const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Client = require('../client');
const message = require('../message');
const { makeFakeClient } = require('./fixtures/fake-client');
const { makeFixtureDb } = require('./fixtures/fake-db');

function inject(name, exports) {
    require.cache[require.resolve(name)] = { id: require.resolve(name), loaded: true, exports };
}

const db = makeFixtureDb();
inject('../database/db', db);
inject('../config/whitelist', { isAllowed: () => true, getHostAddress: () => '127.0.0.1' });
inject('../database/item-share-type', { getShareType: () => 1, getUseTimeSeconds: () => 0 });

class Socket extends EventEmitter {
    constructor() { super(); this.sent = []; }
    write(data) { this.sent.push(Buffer.from(data)); }
    end() { this.writableEnded = true; }
    destroy() { this.destroyed = true; }
}

test('coalesced and fragmented frames retain exact lengths and bit-7 opcodes', () => {
    const socket = new Socket(), received = [];
    new Client(socket, (_, type, body) => received.push([type, Buffer.from(body)]));
    const frames = Buffer.concat([
        message.make(Buffer.alloc(7, 1), 0x00230123, 0xf0f00f0f),
        message.make(Buffer.alloc(11, 2), 0x00230121, 0xf0f00f0f),
        message.make(Buffer.alloc(4, 3), 0x00220191, 0xf0f00f0f),
    ]);
    for (let i = 0; i < frames.length; i += 3) socket.emit('data', frames.subarray(i, i + 3));
    assert.deepEqual(received.map(([op, body]) => [op, body.length, body[0]]), [
        [0x00230123, 7, 1], [0x00230121, 11, 2], [0x00220191, 4, 3],
    ]);
    assert.ok(!socket.destroyed && !socket.writableEnded);
});

test('early keepalive and maximum outgoing frame', () => {
    const socket = new Socket(), client = new Client(socket, () => {});
    socket.emit('data', message.make(Buffer.alloc(4), 0x00020083, 0xf0f00f0f));
    assert.equal(socket.sent.length, 1);
    assert.equal(client.getMessageBuffer(1, 1008)[0].length, 1024);
    assert.throws(() => client.getMessageBuffer(1, 1009), RangeError);
});

test('handler exceptions close only the offending socket', () => {
    const broken = new Socket(), healthy = new Socket();
    new Client(broken, () => { throw new Error('malformed request'); });
    let delivered = 0;
    new Client(healthy, () => delivered++);
    broken.emit('data', message.make(Buffer.alloc(7), 0x00230123, 0xf0f00f0f));
    healthy.emit('data', message.make(Buffer.alloc(7), 0x00230123, 0xf0f00f0f));
    assert.equal(broken.destroyed, true);
    assert.equal(delivered, 1);
    assert.ok(!healthy.destroyed);
});

test('async dispatch waits for preceding requests and contains rejection', async () => {
    const { DispatchServer } = require('../server');
    let release;
    const first = new Promise(resolve => { release = resolve; }), order = [];
    const server = new DispatchServer('Test', 0, [{ async dispatch(client, type) {
        order.push(type);
        if (type === 1) await first;
        else throw new Error('test rejection');
        order.push('done');
        return true;
    } }]);
    const socket = new Socket();
    server.onConnection(socket);
    socket.emit('data', Buffer.concat([message.make(Buffer.alloc(0), 1, 0xf0f00f0f), message.make(Buffer.alloc(0), 2, 0xf0f00f0f)]));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, [1]);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(order, [1, 'done', 2]);
    assert.equal(socket.destroyed, true);
});

test('inventory chunks preserve every serial and equipped status', async () => {
    const previous = db.getItemEquips;
    db.getItemEquips = async () => [{ item_id: 100010 }];
    try {
        const client = makeFakeClient(1, 30907);
        const items = Array.from({ length: 101 }, (_, i) => ({ id: 100001 + i, item_id: 22100101, part_slot: 1, mech_type: 1 }));
        await require('../dispatch/item-info.sender').sendItemInfo(client, items, 1, 'test');
        const serials = [], equipped = [];
        for (const packet of client._sent) {
            const body = Buffer.from(packet.hex, 'hex');
            assert.ok(body.length + 16 <= 1024);
            for (let i = 0; i < body[1]; i++) {
                const offset = 6 + i * 35;
                serials.push(body.readUInt32LE(offset));
                if (body.readUInt32LE(offset + 8)) equipped.push(body.readUInt32LE(offset));
            }
        }
        assert.deepEqual(serials, items.map(item => item.id));
        assert.deepEqual(equipped, [100010]);
    } finally { db.getItemEquips = previous; }
});

test('invalid game tokens never read an account or send success', async () => {
    const tokens = require('../auth-tokens');
    const key = tokens.issueKey(41);
    assert.equal(tokens.lookup(41, key), 41);
    assert.equal(tokens.lookup(42, key), null);
    const previous = db.getAccountById;
    let reads = 0;
    db.getAccountById = async () => { reads++; throw new Error('must not read'); };
    try {
        const Login = require('../dispatch/gamelogin.dispatch');
        for (const size of [0, 4, 7, 8, 32]) {
            const client = makeFakeClient(1, 30907);
            await new Login().dispatch(client, 0x00110124, Buffer.alloc(size));
            assert.equal(client.disconnected_, true);
            assert.equal(client._sent.length, 0);
        }
        assert.equal(reads, 0);
    } finally { db.getAccountById = previous; }
});

test('valid game login preserves identity and sends normal grade and completion', async () => {
    const account = db._fixture.account;
    const key = require('../auth-tokens').issueKey(account.id);
    const body = Buffer.alloc(8);
    body.writeUInt32LE(account.id, 0);
    body.writeUInt32LE(key, 4);
    const client = makeFakeClient(1, 30907);
    await new (require('../dispatch/gamelogin.dispatch'))().dispatch(client, 0x00110124, body);
    assert.ok(!client.disconnected_);
    assert.equal(client.accountId_, account.id);
    assert.ok(client._sent.some(packet => packet.op === '0x00210121'));
    const grade = client._sent.find(packet => packet.op === '0x00510101');
    assert.equal(Buffer.from(grade.hex, 'hex').readUInt32LE(0), 0);
});

test('login database failure disconnects without success', async () => {
    const previous = db.getAccountByUsername;
    db.getAccountByUsername = async () => { throw new Error('database offline'); };
    try {
        const client = makeFakeClient(1, 9211), body = Buffer.alloc(0x381);
        body.write('Player');
        await new (require('../dispatch/account.dispatch'))().dispatch(client, 0x00110151, body);
        assert.equal(client.disconnected_, true);
        assert.equal(client._sent.length, 0);
    } finally { db.getAccountByUsername = previous; }
});

test('duplicate shared purchases and insufficient funds never charge', async () => {
    const previousPool = db.pool, previousCatalog = db.getItemCatalog;
    try {
        for (const [balance, owned] of [[10000, true], [5, false]]) {
            const writes = [], state = { rollback: 0, commit: 0, released: false };
            db.getItemCatalog = async () => [{ item_id: 22100101, price: 1000, category_type: 2 }];
            db.pool = { async getConnection() { return {
                async beginTransaction() {},
                async execute(sql, args) {
                    if (sql.startsWith('SELECT point')) return [[{ point: balance }]];
                    if (sql.startsWith('SELECT id FROM items')) return [owned ? [{ id: 100001 }] : []];
                    writes.push([sql, args]); return [{}];
                },
                async rollback() { state.rollback++; },
                async commit() { state.commit++; },
                release() { state.released = true; },
            }; } };
            const client = makeFakeClient(1, 30907); client.accountId_ = 1;
            await new (require('../dispatch/room.dispatch'))().handleShopPurchase(client, 22100101, Buffer.alloc(4));
            assert.equal(writes.length, 0);
            assert.equal(state.commit, 0);
            assert.equal(state.rollback, 1);
            assert.equal(state.released, true);
            const answer = Buffer.from(client._sent.find(packet => packet.op === '0x00240202').hex, 'hex');
            assert.equal(answer.readUInt32LE(2), 1);
            assert.equal(answer.readBigUInt64LE(6), BigInt(balance));
        }
    } finally { db.pool = previousPool; db.getItemCatalog = previousCatalog; }
});

test('equipment save rejects unowned serials and rolls back', async () => {
    const filename = require.resolve('../database/db'), saved = require.cache[filename];
    delete require.cache[filename];
    const realDb = require('../database/db');
    require.cache[filename] = saved;
    const writes = [], state = { rollback: 0, released: false };
    realDb.pool.getConnection = async () => ({
        async beginTransaction() {},
        async execute(sql) { if (!sql.startsWith('SELECT')) writes.push(sql); return [[]]; },
        async rollback() { state.rollback++; },
        release() { state.released = true; },
    });
    try {
        await assert.rejects(realDb.saveEquippedLoadout(1, 1, [100001, 0, 0, 0, 0, 0]), /not owned/);
        assert.deepEqual(writes, []);
        assert.equal(state.rollback, 1);
        assert.equal(state.released, true);
        await assert.rejects(realDb.saveEquippedLoadout(1, 9, [0, 0, 0, 0, 0, 0]), /invalid mech/);
        await assert.rejects(realDb.saveEquippedLoadout(1, 1, [100001, 100001, 0, 0, 0, 0]), /duplicate/);
    } finally { await realDb.pool.end(); }
});

test('successful purchase commits the debit and item together', async () => {
    const previousPool = db.pool, previousCatalog = db.getItemCatalog;
    const calls = [];
    db.getItemCatalog = async () => [{ item_id: 22100101, price: 1000, category_type: 2 }];
    db.pool = { async getConnection() { return {
        async beginTransaction() { calls.push('begin'); },
        async execute(sql, args) {
            if (sql.startsWith('SELECT point')) return [[{ point: 5000 }]];
            if (sql.startsWith('SELECT id')) return [[]];
            calls.push([sql, args]); return [{ insertId: 100001 }];
        },
        async commit() { calls.push('commit'); },
        async rollback() { calls.push('rollback'); },
        release() { calls.push('release'); },
    }; } };
    try {
        const client = makeFakeClient(1, 30907); client.accountId_ = 1;
        const dispatch = new (require('../dispatch/room.dispatch'))();
        dispatch.sendPackageItems = async () => {};
        dispatch.sendHangarWearInfo = async () => {};
        dispatch.scheduleShopListRepaint = () => {};
        await dispatch.handleShopPurchase(client, 22100101, Buffer.alloc(4));
        assert.equal(calls[0], 'begin');
        assert.match(calls[1][0], /^UPDATE accounts SET point/);
        assert.deepEqual(calls[1][1], [4000, 1]);
        assert.match(calls[2][0], /^INSERT INTO items/);
        assert.deepEqual(calls.slice(3), ['commit', 'release']);
        assert.equal(client.point_, 4000);
        const answer = Buffer.from(client._sent.find(packet => packet.op === '0x00240202').hex, 'hex');
        assert.equal(answer.readUInt32LE(2), 0);
        assert.equal(answer.readBigUInt64LE(6), 4000n);
    } finally { db.pool = previousPool; db.getItemCatalog = previousCatalog; }
});

test('game user record includes eight canonical loadouts within the frame limit', async () => {
    const { sendGameUserBootstrap } = require('../dispatch/room/room-game-user.sender');
    const { CANONICAL_LOADOUTS } = require('../database/default-loadouts');
    const client = makeFakeClient(1, 30907);
    await sendGameUserBootstrap(client, { accountIndex: 1, nickname: 'Player', teamIndex: 0, selectedMech: 8, pilotId: 101 }, client.getMessageBuffer);
    const packet = client._sent.find(packet => packet.op === '0x00222112');
    assert.ok(packet.len + 16 <= 1024);
    const body = Buffer.from(packet.hex, 'hex');
    assert.equal(body[2 + 0x6c], 8);
    for (let slot = 1; slot <= 8; slot++) {
        const offset = 2 + 0x6d + (slot - 1) * 0x2f;
        assert.equal(body.readUInt32LE(offset + 4), CANONICAL_LOADOUTS[slot].body);
    }
});
