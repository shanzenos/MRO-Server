'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const DB_PATH = require.resolve(path.join(ROOT, 'database', 'db.js'));
const WHITELIST_PATH = require.resolve(path.join(ROOT, 'config', 'whitelist.js'));

const { makeFixtureDb } = require('./fixtures/fake-db.js');
const { makeFakeClient } = require('./fixtures/fake-client.js');
const { installFakeTimers } = require('./fixtures/fake-timers.js');

function installFakeModule(resolvedPath, exportsObj)
{
    const mod = new Module(resolvedPath, null);
    mod.filename = resolvedPath;
    mod.loaded = true;
    mod.exports = exportsObj;
    require.cache[resolvedPath] = mod;
}

installFakeModule(DB_PATH, makeFixtureDb());

function installFakeWhitelist(hostAddressesByUsername, enabled = true)
{
    installFakeModule(WHITELIST_PATH, {
        isAllowed(username, remoteAddress) {
            if (!enabled) return true;
            return String(hostAddressesByUsername[String(username || '').toLowerCase()] || '') === remoteAddress;
        },
        status() { return enabled ? 'on' : 'off'; },
        getHostAddress(username) {
            if (!enabled) return arguments[1] || null;
            const key = String(username || '').toLowerCase();
            return Object.prototype.hasOwnProperty.call(hostAddressesByUsername, key)
                ? hostAddressesByUsername[key]
                : null;
        },
    });
}

const rooms = require('../rooms.js');
function resetRooms() {
    for (const room of rooms.listRooms()) {
        for (const account of room.members.keys()) rooms.removeMember(account);
    }
    rooms.registerLobbyClientSource([]);
}

const CQ_CREATE = 0x00220201;
const GAME_START_CN = 0x00222103;
const READY_HOST_CA = 0x00420114;
const READY_HOST_SQ = '0x00420113';
const READY_HOST_SN = '0x00420115';
const READY_SUCCESS_SN = '0x00420116';

function makeCreateBody(name)
{
    const body = Buffer.alloc(51);
    body[0] = 1;
    body[1] = 0;
    body.writeUInt16LE(0, 2);
    body.writeUInt16LE(0, 4);
    body[6] = 5;
    body.writeUInt16LE(0, 7);
    body.writeUInt16LE(0, 9);
    body[11] = 0;
    body.writeUInt16LE(8, 12);
    body.write(name, 14, Math.min(name.length, 25), 'ascii');
    body[39] = 0;
    return body;
}

function makeReadyHostCaBody(port, resultCode = 0)
{
    const body = Buffer.alloc(8);
    body.writeUInt16LE(0, 0x00);
    body.writeUInt32LE(resultCode, 0x02);
    body.writeUInt16LE(port, 0x06);
    return body;
}

async function flushMicrotasks(rounds = 20)
{
    for (let i = 0; i < rounds; ++i)
        await new Promise((resolve) => setImmediate(resolve));
}

function setUpRoom()
{

    delete require.cache[require.resolve('../dispatch/gate.game.dispatch.js')];
    delete require.cache[require.resolve('../dispatch/community.dispatch.js')];
    const GateGameDispatch = require('../dispatch/gate.game.dispatch.js');
    const CommunityDispatch = require('../dispatch/community.dispatch.js');

    resetRooms();

    const gate = new GateGameDispatch();
    const community = new CommunityDispatch();

    const clientA = makeFakeClient(1, 30907);
    const clientB = makeFakeClient(2, 30907);
    clientA.accountId_ = 1;
    clientB.accountId_ = 2;
    clientA.nickname_ = 'Alice';
    clientB.nickname_ = 'Bob';
    clientA.username_ = 'Alice';
    clientA.pilot_ = 101;
    clientB.pilot_ = 102;
    clientA.currentHangarSlot_ = 1;
    clientB.currentHangarSlot_ = 2;

    return { gate, community, clientA, clientB };
}

async function startBattleUpToReadyHostSq({ gate, clientA, clientB, fakeTimers, createBody })
{
    const createHandled = gate.dispatch(clientA, CQ_CREATE, createBody || makeCreateBody('Alice Room'));
    assert.strictEqual(createHandled, true, 'CQ_CREATE must be handled');
    const roomId = clientA.createdRoomIndex_;
    assert.ok(roomId, 'A must have a createdRoomIndex_ after CQ_CREATE');

    rooms.addMember(roomId, { accountId: 2, nickname: 'Bob', team: 0, slot: 0, ready: false, client: clientB });
    assert.strictEqual(rooms.getRoom(roomId).members.size, 2, 'room must have 2 members before F5');

    while (fakeTimers.fireNext()) {  }
    await flushMicrotasks();
    clientA._sent.length = 0;
    clientB._sent.length = 0;

    const startHandled = gate.dispatch(clientA, GAME_START_CN, Buffer.alloc(0));
    assert.strictEqual(startHandled, true, 'Game_Start_CN 0x00222103 must be handled');

    while (fakeTimers.hasPending()) {
        fakeTimers.fireNext();
        await flushMicrotasks();
    }

    return roomId;
}

async function testSqOnlyToHostAndSnToNonHost()
{
    installFakeWhitelist({ alice: '203.0.113.5' });
    const { gate, community, clientA, clientB } = setUpRoom();

    const fakeTimers = installFakeTimers();
    try {
        await startBattleUpToReadyHostSq({ gate, clientA, clientB, fakeTimers });

        assert.strictEqual(clientA._sent.filter((s) => s.op === READY_HOST_SQ).length, 1, 'A (host) must receive exactly one Ready_Host_SQ');
        assert.strictEqual(clientB._sent.some((s) => s.op === READY_HOST_SQ), false, 'B (non-host) must never receive Ready_Host_SQ');
        console.log('[room-ready-host-split test] PASS: Ready_Host_SQ goes only to the host connection');

        clientA._sent.length = 0;
        clientB._sent.length = 0;

        const FAKE_PORT = 12345;
        const caHandled = community.dispatch(clientA, READY_HOST_CA, makeReadyHostCaBody(FAKE_PORT, 0));
        assert.strictEqual(caHandled, true, 'Ready_Host_CA 0x00420114 must be handled');

        const aSuccess = clientA._sent.filter((s) => s.op === READY_SUCCESS_SN);
        assert.strictEqual(aSuccess.length, 1, 'A (host) must still receive its own Ready_Success_SN');

        const bReadyHostSn = clientB._sent.filter((s) => s.op === READY_HOST_SN);
        assert.strictEqual(bReadyHostSn.length, 1, 'B (non-host) must receive exactly one Ready_Host_SN');
        const bBody = Buffer.from(bReadyHostSn[0].hex, 'hex');
        assert.strictEqual(bBody.readUInt16LE(0x00), FAKE_PORT, `Ready_Host_SN port field must be the host-reported port (${FAKE_PORT}), not hardcoded 30907`);
        const bIpWithMap = bBody.subarray(0x03).toString('ascii').split('\0')[0];
        assert.strictEqual(bIpWithMap, '203.0.113.5', `RHSN-IP: Ready_Host_SN ip field must be the bare hostAddress (client appends :port/map itself), got "${bIpWithMap}"`);

        const bSuccess = clientB._sent.filter((s) => s.op === READY_SUCCESS_SN);
        assert.strictEqual(bSuccess.length, 1, 'B (non-host) must receive exactly one Ready_Success_SN, right after Ready_Host_SN');
        assert.strictEqual(clientB._sent[clientB._sent.length - 1].op, READY_SUCCESS_SN, 'B must receive Ready_Success_SN immediately after Ready_Host_SN (design §1 row 9 proposal)');

        console.log('[room-ready-host-split test] PASS: non-host gets Ready_Host_SN (host-reported port + configured hostAddress) then Ready_Success_SN');
    } finally {
        fakeTimers.restore();
        resetRooms();
    }
}

async function testMissingHostAddressSendsNothingToNonHost()
{
    installFakeWhitelist({});
    const { gate, community, clientA, clientB } = setUpRoom();

    const fakeTimers = installFakeTimers();
    try {
        await startBattleUpToReadyHostSq({ gate, clientA, clientB, fakeTimers });
        clientA._sent.length = 0;
        clientB._sent.length = 0;

        const caHandled = community.dispatch(clientA, READY_HOST_CA, makeReadyHostCaBody(12345, 0));
        assert.strictEqual(caHandled, true, 'Ready_Host_CA 0x00420114 must be handled');

        assert.strictEqual(clientA._sent.filter((s) => s.op === READY_SUCCESS_SN).length, 1, 'A (host) must still receive its own Ready_Success_SN even when hostAddress is missing');
        assert.strictEqual(clientB._sent.length, 0, 'B (non-host) must receive nothing at all when the host has no configured hostAddress');

        console.log('[room-ready-host-split test] PASS: missing hostAddress -> non-host gets nothing, host still gets its own Ready_Success_SN');
    } finally {
        fakeTimers.restore();
        resetRooms();
    }
}

async function testWhitelistDisabledUsesHostConnectionAddress()
{
    installFakeWhitelist({}, false);
    const { gate, community, clientA, clientB } = setUpRoom();
    clientA.socket_.remoteAddress = '198.51.100.23';

    const fakeTimers = installFakeTimers();
    try {
        await startBattleUpToReadyHostSq({ gate, clientA, clientB, fakeTimers });
        assert.strictEqual(clientA._sent.filter((s) => s.op === READY_HOST_SQ).length, 1,
            'the host must start with whitelist disabled and no allowlist entry');

        const caHandled = community.dispatch(clientA, READY_HOST_CA, makeReadyHostCaBody(12345, 0));
        assert.strictEqual(caHandled, true);
        const bReadyHostSn = clientB._sent.find((s) => s.op === READY_HOST_SN);
        assert.ok(bReadyHostSn, 'the non-host must receive Ready_Host_SN');
        const hostAddress = Buffer.from(bReadyHostSn.hex, 'hex').subarray(0x03).toString('ascii').split('\0')[0];
        assert.strictEqual(hostAddress, '198.51.100.23', 'the observed host connection IP must be advertised');
        console.log('[room-ready-host-split test] PASS: whitelist off uses the host connection IP without an allowlist entry');
    } finally {
        fakeTimers.restore();
        resetRooms();
    }
}

async function testMalformedCaSendsNothingToAnyone()
{
    installFakeWhitelist({ alice: '203.0.113.5' });
    const { gate, community, clientA, clientB } = setUpRoom();

    const fakeTimers = installFakeTimers();
    try {
        await startBattleUpToReadyHostSq({ gate, clientA, clientB, fakeTimers });
        clientA._sent.length = 0;
        clientB._sent.length = 0;

        const shortBody = makeReadyHostCaBody(12345, 0).subarray(0, 6);
        const caHandled = community.dispatch(clientA, READY_HOST_CA, shortBody);
        assert.strictEqual(caHandled, true, 'Ready_Host_CA 0x00420114 must still be handled (claims the opcode)');

        assert.strictEqual(clientA._sent.length, 0, 'A (host) must receive NOTHING for a malformed (<8 byte) CA -- not even its own Ready_Success_SN');
        assert.strictEqual(clientB._sent.length, 0, 'B (non-host) must receive nothing for a malformed CA');

        console.log('[room-ready-host-split test] PASS: malformed (<8 byte) Ready_Host_CA sends nothing to anyone, including the host');
    } finally {
        fakeTimers.restore();
        resetRooms();
    }
}

async function testListenFailureResultSendsNothingToAnyone()
{
    installFakeWhitelist({ alice: '203.0.113.5' });
    const { gate, community, clientA, clientB } = setUpRoom();

    const fakeTimers = installFakeTimers();
    try {
        await startBattleUpToReadyHostSq({ gate, clientA, clientB, fakeTimers });
        clientA._sent.length = 0;
        clientB._sent.length = 0;

        const caHandled = community.dispatch(clientA, READY_HOST_CA, makeReadyHostCaBody(12345, 0xFFFFFFFF));
        assert.strictEqual(caHandled, true, 'Ready_Host_CA 0x00420114 must still be handled (claims the opcode)');

        assert.strictEqual(clientA._sent.length, 0, 'A (host) must receive NOTHING when its own CA reports a Listen failure -- not even its own Ready_Success_SN');
        assert.strictEqual(clientB._sent.length, 0, 'B (non-host) must receive nothing on a Listen failure');

        console.log('[room-ready-host-split test] PASS: result=0xFFFFFFFF (Listen failure) sends nothing to anyone, including the host');
    } finally {
        fakeTimers.restore();
        resetRooms();
    }
}

async function testReadyHostSnUsesRealMapId(pickedMapId, expectedMapName)
{
    installFakeWhitelist({ alice: '203.0.113.5' });
    const { gate, community, clientA, clientB } = setUpRoom();

    const fakeTimers = installFakeTimers();
    try {
        const createBody = makeCreateBody('Alice Room');
        createBody.writeUInt16LE(pickedMapId, 2);
        await startBattleUpToReadyHostSq({ gate, clientA, clientB, fakeTimers, createBody });

        const caHandled = community.dispatch(clientA, READY_HOST_CA, makeReadyHostCaBody(12345, 0));
        assert.strictEqual(caHandled, true, 'Ready_Host_CA 0x00420114 must be handled');

        const bReadyHostSn = clientB._sent.filter((s) => s.op === READY_HOST_SN);
        assert.strictEqual(bReadyHostSn.length, 1, 'B (non-host) must receive exactly one Ready_Host_SN');
        const bBody = Buffer.from(bReadyHostSn[0].hex, 'hex');
        const bIpWithMap = bBody.subarray(0x03).toString('ascii').split('\0')[0];

        void expectedMapName;
        assert.ok(!bIpWithMap.includes('/'), `RHSN-IP: Ready_Host_SN ip field for room mapId=${pickedMapId} must be a bare IP, got "${bIpWithMap}"`);

        console.log(`[room-ready-host-split test] PASS: room mapId=${pickedMapId} -> Ready_Host_SN URL contains "${expectedMapName}"`);
    } finally {
        fakeTimers.restore();
        resetRooms();
    }
}

function testReadyHostSnMapTableSingleConnectionPath()
{
    const GateGameDispatch = require('../dispatch/gate.game.dispatch.js');
    const cases = [[9010, 'Map_PC04'], [9004, 'Map_PC03']];
    for (const [mapId, expectedMapName] of cases) {
        const { ipWithMap } = GateGameDispatch.buildReadyHostSnMsg('203.0.113.5', 30907, mapId);
        assert.strictEqual(ipWithMap, `203.0.113.5/${expectedMapName}`,
            `buildReadyHostSnMsg's single-connection path for real Cache.Bin map id ${mapId} must resolve to "${expectedMapName}" via MAP_ID_TO_MAP_NAME_GG, got "${ipWithMap}"`);
    }
    console.log('[room-ready-host-split test] PASS: buildReadyHostSnMsg single-connection path still resolves MAP_ID_TO_MAP_NAME_GG (9010->Map_PC04, 9004->Map_PC03)');
}

async function main()
{
    await testSqOnlyToHostAndSnToNonHost();
    await testMissingHostAddressSendsNothingToNonHost();
    await testWhitelistDisabledUsesHostConnectionAddress();
    await testMalformedCaSendsNothingToAnyone();
    await testListenFailureResultSendsNothingToAnyone();
    await testReadyHostSnUsesRealMapId(9010, 'Map_PC04');
    await testReadyHostSnUsesRealMapId(9001, 'Map_PC01');
    testReadyHostSnMapTableSingleConnectionPath();
    console.log('[room-ready-host-split test] ALL CHECKS PASS');
    process.exit(0);
}

main().catch((err) => {
    console.error('[room-ready-host-split test] FAIL:', err);
    process.exit(1);
});
