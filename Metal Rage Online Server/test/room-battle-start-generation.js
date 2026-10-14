'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const DB_PATH = require.resolve(path.join(ROOT, 'database', 'db.js'));

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
installFakeModule(require.resolve('../config/whitelist'), { isAllowed: () => true, getHostAddress: () => '127.0.0.1' });

const rooms = require('../rooms.js');
function resetRooms() {
    for (const room of rooms.listRooms()) {
        for (const account of room.members.keys()) rooms.removeMember(account);
    }
    rooms.registerLobbyClientSource([]);
}
const GateGameDispatch = require('../dispatch/gate.game.dispatch.js');

const CQ_CREATE = 0x00220201;
const GAME_START_CN = 0x00222103;
const GAME_WAIT_SN = '0x00420111';

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

async function flushMicrotasks(rounds = 20)
{
    for (let i = 0; i < rounds; ++i)
        await new Promise((resolve) => setImmediate(resolve));
}

function setUpTwoMemberRoom()
{
    resetRooms();

    const gate = new GateGameDispatch();
    const clientA = makeFakeClient(1, 30907);
    const clientB = makeFakeClient(2, 30907);
    clientA.accountId_ = 1;
    clientB.accountId_ = 2;
    clientA.nickname_ = 'Alice';
    clientB.nickname_ = 'Bob';
    clientA.username_ = 'Alice';
    clientB.username_ = 'Bob';
    clientA.pilot_ = 101;
    clientB.pilot_ = 102;
    clientA.currentHangarSlot_ = 1;
    clientB.currentHangarSlot_ = 2;

    return { gate, clientA, clientB };
}

async function startBattle({ gate, clientA, clientB, fakeTimers })
{
    const createHandled = gate.dispatch(clientA, CQ_CREATE, makeCreateBody('Alice Room'));
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

    assert.strictEqual(clientA._sent.filter((s) => s.op === GAME_WAIT_SN).length, 1, 'A must receive the synchronous Game_Wait_SN');
    assert.strictEqual(clientB._sent.filter((s) => s.op === GAME_WAIT_SN).length, 1, 'B must receive the synchronous Game_Wait_SN');

    return roomId;
}

async function drainAndAssertNothingElseSent({ fakeTimers, clientA, clientB }, label)
{
    while (fakeTimers.hasPending()) {
        fakeTimers.fireNext();
        await flushMicrotasks();
    }
    assert.strictEqual(clientA._sent.length, 0, `A must receive nothing from any of the five guarded callbacks after ${label}`);
    assert.strictEqual(clientB._sent.length, 0, `B must receive nothing from any of the five guarded callbacks after ${label}`);
}

async function testGenerationBumpAbortsEveryCallback()
{
    const { gate, clientA, clientB } = setUpTwoMemberRoom();
    const fakeTimers = installFakeTimers();
    try {
        const roomId = await startBattle({ gate, clientA, clientB, fakeTimers });
        clientA._sent.length = 0;
        clientB._sent.length = 0;

        rooms.getRoom(roomId).battleStartGen += 1;

        await drainAndAssertNothingElseSent({ fakeTimers, clientA, clientB }, 'battleStartGen was bumped mid-sequence');
        console.log('[room-battle-start-generation test] PASS: a bumped battleStartGen aborts all five callbacks');
    } finally {
        fakeTimers.restore();
        resetRooms();
    }
}

async function testHostChangeAbortsEveryCallback()
{
    const { gate, clientA, clientB } = setUpTwoMemberRoom();
    const fakeTimers = installFakeTimers();
    try {
        const roomId = await startBattle({ gate, clientA, clientB, fakeTimers });
        clientA._sent.length = 0;
        clientB._sent.length = 0;

        assert.strictEqual(rooms.getRoom(roomId).hostAccountId, 1, 'A (account 1) must be host before the change');
        rooms.setHost(roomId, 2);

        await drainAndAssertNothingElseSent({ fakeTimers, clientA, clientB }, 'the room host changed mid-sequence');
        console.log('[room-battle-start-generation test] PASS: a host change mid-sequence aborts all five callbacks (including Ready_Host_SQ)');
    } finally {
        fakeTimers.restore();
        resetRooms();
    }
}

async function testRoomGoneAbortsEveryCallback()
{
    const { gate, clientA, clientB } = setUpTwoMemberRoom();
    const fakeTimers = installFakeTimers();
    try {
        await startBattle({ gate, clientA, clientB, fakeTimers });
        clientA._sent.length = 0;
        clientB._sent.length = 0;

        rooms.removeMember(1);
        rooms.removeMember(2);

        await drainAndAssertNothingElseSent({ fakeTimers, clientA, clientB }, 'the room was deleted mid-sequence');
        console.log('[room-battle-start-generation test] PASS: the room disappearing mid-sequence aborts all five callbacks');
    } finally {
        fakeTimers.restore();
        resetRooms();
    }
}

async function main()
{
    await testGenerationBumpAbortsEveryCallback();
    await testHostChangeAbortsEveryCallback();
    await testRoomGoneAbortsEveryCallback();
    console.log('[room-battle-start-generation test] ALL CHECKS PASS');
    process.exit(0);
}

main().catch((err) => {
    console.error('[room-battle-start-generation test] FAIL:', err);
    process.exit(1);
});
