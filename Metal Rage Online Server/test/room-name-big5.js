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

const rooms = require('../rooms.js');
function resetRooms() {
    for (const room of rooms.listRooms()) {
        for (const account of room.members.keys()) rooms.removeMember(account);
    }
    rooms.registerLobbyClientSource([]);
}
const GateGameDispatch = require('../dispatch/gate.game.dispatch.js');
const roomString = require('../dispatch/room/room-string.js');

const CQ_CREATE = 0x00220201;
const ROOM_NAME_SN = '0x0022021a';
const ROOM_LIST_SN = '0x00220204';

const BIG5_NAME_BYTES = Buffer.from('b4fab8d5a9d0b6a1', 'hex');
const BIG5_NAME_TEXT = '測試房間';

function makeCreateBodyRawName(nameBytes)
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
    nameBytes.copy(body, 14, 0, Math.min(nameBytes.length, 25));
    body[39] = 0;
    return body;
}

function main()
{
    resetRooms();

    const gate = new GateGameDispatch();

    const clientA = makeFakeClient(1, 30907);
    const clientB = makeFakeClient(2, 30907);
    clientA.accountId_ = 1;
    clientB.accountId_ = 2;
    clientA.nickname_ = 'Alice';
    clientB.nickname_ = 'Bob';
    rooms.registerLobbyClientSource([clientA, clientB]);

    const fakeTimers = installFakeTimers();
    try {
        const createHandled = gate.dispatch(clientA, CQ_CREATE, makeCreateBodyRawName(BIG5_NAME_BYTES));
        assert.strictEqual(createHandled, true, 'CQ_CREATE must be handled');

        const roomId = clientA.createdRoomIndex_;
        assert.ok(roomId, 'A must have a createdRoomIndex_ after CQ_CREATE');

        const listEntries = clientB._sent.filter((s) => s.op === ROOM_LIST_SN);
        assert.strictEqual(listEntries.length, 1, 'B must receive exactly one Room_List_SN for the new room');
        {
            const entry = Buffer.from(listEntries[0].hex, 'hex');

            const nameFieldOffset = 2 + 7 + 14;
            const nameLen = entry.readUInt8(nameFieldOffset);
            const nameBytesOnWire = entry.subarray(nameFieldOffset + 1, nameFieldOffset + 1 + nameLen);
            assert.strictEqual(nameBytesOnWire.equals(BIG5_NAME_BYTES), true,
                `Room_List_SN NAME field must carry the exact Big5 bytes, got ${nameBytesOnWire.toString('hex')}`);
        }
        console.log('[room-name-big5 test] PASS: Room_List_SN NAME field round-trips the exact Big5 bytes');

        while (fakeTimers.fireNext()) {  }

        const roomNamePackets = clientA._sent.filter((s) => s.op === ROOM_NAME_SN);
        assert.ok(roomNamePackets.length >= 1, 'A must receive at least one Room_Name_SN');
        for (const packet of roomNamePackets) {
            const body = Buffer.from(packet.hex, 'hex');
            const nameBytesOnWire = body.subarray(0, BIG5_NAME_BYTES.length);
            assert.strictEqual(nameBytesOnWire.equals(BIG5_NAME_BYTES), true,
                `Room_Name_SN body must start with the exact Big5 bytes, got ${nameBytesOnWire.toString('hex')}`);

            assert.strictEqual(body[BIG5_NAME_BYTES.length], 0, 'byte after the name must be the NUL terminator');
        }
        console.log('[room-name-big5 test] PASS: Room_Name_SN body round-trips the exact Big5 bytes with a NUL terminator');

        const room = rooms.getRoom(roomId);
        const decoded = roomString.decodeBig5ForLog(room.name);
        assert.strictEqual(decoded, BIG5_NAME_TEXT, 'decodeBig5ForLog() must recover 測試房間 from the stored raw bytes');
        console.log('[room-name-big5 test] PASS: decodeBig5ForLog() recovers the original Big5 text for log readability');
    } finally {
        fakeTimers.restore();

        resetRooms();
    }

    console.log('[room-name-big5 test] ALL CHECKS PASS');
    process.exit(0);
}

main();
