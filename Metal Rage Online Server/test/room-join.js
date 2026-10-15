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
const LobbyDispatch = require('../dispatch/lobby.dispatch.js');
const { leaveRoomAndNotify } = require('../dispatch/room/room-leave.js');
const { buildRoomListEntry } = require('../dispatch/room/room-list.sender.js');

const CQ_CREATE = 0x00220201;
const ENTER_CQ = 0x00220231;
const ROOM_LIST_SN = '0x00220204';
const USER_DEFAULT_SN = '0x00220233';
const USER_MASTER_SN = '0x00220319';
const LEAVE_SN = '0x00220236';
const LOBBY_ENTER_CQ = 0x00230111;
const MAP_CHANGE_ONE_CQ = 0x00220221;
const MAP_CHANGE_ONE_SN = '0x00220223';

function makeMapChangeOneBody({ b0 = 0, w1, w2 = 0, b5 = 0, w6 = 0, w8 = 0 })
{
    const body = Buffer.alloc(10);
    body.writeUInt8(b0, 0);
    body.writeUInt16LE(w1, 1);
    body.writeUInt16LE(w2, 3);
    body.writeUInt8(b5, 5);
    body.writeUInt16LE(w6, 6);
    body.writeUInt16LE(w8, 8);
    return body;
}

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

function makeEnterBody(roomIndex)
{
    const body = Buffer.alloc(0x1D);
    body.writeUInt16LE(roomIndex, 0x00);
    return body;
}

async function main()
{
    resetRooms();

    const gate = new GateGameDispatch();
    const lobby = new LobbyDispatch();

    const clientA = makeFakeClient(1, 30907);
    const clientB = makeFakeClient(2, 30907);
    clientA.accountId_ = 1;
    clientB.accountId_ = 2;
    clientA.nickname_ = 'Alice';
    clientB.nickname_ = 'Bob';

    rooms.registerLobbyClientSource([clientA, clientB]);

    const fakeTimers = installFakeTimers();
    try {

        const createHandled = gate.dispatch(clientA, CQ_CREATE, makeCreateBody('Alice Room'));
        assert.strictEqual(createHandled, true, 'CQ_CREATE must be handled');

        const roomId = clientA.createdRoomIndex_;
        assert.ok(roomId, 'A must have a createdRoomIndex_ after CQ_CREATE');
        assert.ok(rooms.getRoom(roomId), 'room must be tracked in rooms.js');

        const bRoomListPackets = clientB._sent.filter((s) => s.op === ROOM_LIST_SN);
        assert.strictEqual(bRoomListPackets.length, 1, 'B (in the lobby) must receive exactly one Room_List_SN for the new room');
        assert.strictEqual(clientA._sent.some((s) => s.op === ROOM_LIST_SN), false, 'A (now a room member) must not receive the lobby broadcast of her own room');
        console.log('[room-join test] PASS: CQ_CREATE broadcasts Room_List_SN to the lobby, not the creator');

        {
            const entry = Buffer.from(bRoomListPackets[0].hex, 'hex');

            assert.strictEqual(entry.readUInt16LE(2), roomId, 'entry RoomIndex must be the created room');
            assert.strictEqual(entry.readUInt8(4), 1, 'entry UpdateType must be 1 (new room)');

            const fieldMask = entry.readUInt16LE(7);
            assert.strictEqual(fieldMask, 0x032F, 'FieldMask must be the full field set (ROOM_TYPE|MATCH|USER_COUNT|ROOM_FLAGS|MAP|NAME_INDEX|NAME)');
            assert.strictEqual(entry.readUInt8(9), 1, 'wire RoomType for a campaign room (normalized 2) must be raw 1, per the jump table');
            assert.strictEqual(entry.readUInt8(12), 1, 'USER_COUNT wire byte 0 must be CurrentUser (1 member: the host)');
            assert.strictEqual(entry.readUInt8(13), 8, 'USER_COUNT wire byte 1 must be MaxUser (8 for a campaign room)');
            assert.strictEqual(entry.readUInt16LE(19), 9001, 'MAP field bytes 4-5 (wire offset 19-20) must carry MapIndex');
            assert.strictEqual(entry.readUInt32LE(15), 0, 'MAP field bytes 0-3 (wire offset 15-18, rotate-flag source + unread) must stay zero');
        }
        console.log('[room-join test] PASS: Room_List_SN entry bytes match the DLL-confirmed RoomType/UserCount/MapIndex layout');

        const freshB = makeFakeClient(3, 30907);
        freshB.accountId_ = 3;
        rooms.registerLobbyClientSource([clientA, clientB, freshB]);
        lobby.dispatch(freshB, LOBBY_ENTER_CQ, Buffer.alloc(0));
        assert.strictEqual(freshB._sent.filter((s) => s.op === ROOM_LIST_SN).length, 1, 'opening the lobby must send a full Room_List_SN including the existing room');
        console.log('[room-join test] PASS: opening the lobby sends the full room list');

        while (fakeTimers.fireNext()) {  }

        clientA._sent.length = 0;
        clientB._sent.length = 0;

        const enterHandled = gate.dispatch(clientB, ENTER_CQ, makeEnterBody(roomId));
        assert.strictEqual(enterHandled, true, 'Enter_CQ must be handled');
        assert.strictEqual(clientB._sent.some((s) => s.op === '0x00220232'), true, 'B must receive Enter_SA');

        assert.strictEqual(rooms.getRoomByAccount(2), rooms.getRoom(roomId), 'B must now be tracked as a member of the room');

        assert.strictEqual(clientA._sent.some((s) => s.op === USER_DEFAULT_SN), true, 'A must receive a User_Default_SN for B immediately');

        while (fakeTimers.fireNext()) {  }

        const bUserDefaults = clientB._sent.filter((s) => s.op === USER_DEFAULT_SN);
        assert.strictEqual(bUserDefaults.length, 2, 'B must receive one User_Default_SN per room member (herself + A) after the scene-change retry fires');

        const aUserDefaults = clientA._sent.filter((s) => s.op === USER_DEFAULT_SN);
        assert.strictEqual(aUserDefaults.length, 1, 'A must receive exactly one User_Default_SN (for B)');

        console.log('[room-join test] PASS: both sides receive each other\'s User_Default_SN after Enter_CQ');

        clientA._sent.length = 0;
        clientB._sent.length = 0;

        leaveRoomAndNotify(2);

        assert.strictEqual(rooms.getRoomByAccount(2), undefined, 'B must no longer be tracked in the room after disconnect');
        assert.ok(rooms.getRoomByAccount(1), 'A must still be in the room (room survives a partial leave)');

        const aLeaveNotices = clientA._sent.filter((s) => s.op === LEAVE_SN);
        assert.strictEqual(aLeaveNotices.length, 1, 'A must receive exactly one Leave_SN for B');
        assert.strictEqual(aLeaveNotices[0].hex.slice(0, 4), '0200', 'Leave_SN UserIndex must be B (account 2), little-endian u16');

        console.log('[room-join test] PASS: B disconnecting notifies the remaining member with Leave_SN');

        clientA._sent.length = 0;

        rooms.addMember(roomId, { accountId: 2, nickname: 'Bob', team: 0, slot: 0, ready: false, client: clientB });
        clientB._sent.length = 0;

        assert.strictEqual(rooms.getRoom(roomId).hostAccountId, 1, 'A must be host before disconnecting');

        leaveRoomAndNotify(1);

        assert.strictEqual(rooms.getRoomByAccount(1), undefined, 'A must no longer be tracked in the room after disconnect');
        const roomAfterHostLeave = rooms.getRoom(roomId);
        assert.ok(roomAfterHostLeave, 'room must survive A leaving (B is still in it)');
        assert.strictEqual(roomAfterHostLeave.hostAccountId, 2, 'host must be reassigned to B (design §2: earliest remaining joiner)');

        const bMasterNotices = clientB._sent.filter((s) => s.op === USER_MASTER_SN);
        assert.strictEqual(bMasterNotices.length, 1, 'B must receive exactly one User_Master_SN naming her the new host');
        assert.strictEqual(bMasterNotices[0].hex.slice(0, 4), '0200', 'User_Master_SN UserIndex must be B (account 2), little-endian u16');

        const bLeaveNotices = clientB._sent.filter((s) => s.op === LEAVE_SN);
        assert.strictEqual(bLeaveNotices.length, 1, 'B must also receive Leave_SN for A leaving');

        console.log('[room-join test] PASS: host disconnecting hands the room to the earliest remaining member');
    } finally {
        fakeTimers.restore();
        resetRooms();
    }

    resetRooms();

    try {
        const lobby2 = new LobbyDispatch();
        const viewer = makeFakeClient(9, 30907);
        viewer.accountId_ = 9;
        rooms.registerLobbyClientSource([viewer]);

        const ROOM_COUNT = 25;
        const LONG_NAME = 'A'.repeat(25);
        for (let i = 0; i < ROOM_COUNT; i++) {
            const room = rooms.createRoom({
                id: rooms.allocateRoomId(),
                name: LONG_NAME,
                mapId: 9001,
                playTime: 10,
                playRound: 1,
                maxPlayers: 4,
                campaign: true,
                hostAccountId: 100 + i,
                roomType: 1,
                hasPassword: false,
                password: '',
            });
            rooms.addMember(room.id, { accountId: 100 + i, nickname: `Host${i}`, team: 0, slot: 0, ready: false, client: null });
        }

        lobby2.dispatch(viewer, LOBBY_ENTER_CQ, Buffer.alloc(0));

        const listFrames = viewer._sent.filter((s) => s.op === ROOM_LIST_SN);
        assert.ok(listFrames.length > 1, `expected the ${ROOM_COUNT}-room list to split into multiple Room_List_SN frames, got ${listFrames.length}`);
        for (const frame of listFrames) {
            const wireBytes = frame.len + 0x10;
            assert.ok(wireBytes <= 0x400, `Room_List_SN frame must not exceed 0x400 wire bytes, got ${wireBytes}`);
        }
        console.log(`[room-join test] PASS: ${ROOM_COUNT}-room list split into ${listFrames.length} frames, all <= 0x400 bytes`);
    } finally {
        resetRooms();
    }

    resetRooms();

    try {
        const solo = makeFakeClient(21, 30907);
        solo.accountId_ = 21;
        solo.nickname_ = 'Solo';
        const viewer2 = makeFakeClient(22, 30907);
        viewer2.accountId_ = 22;
        rooms.registerLobbyClientSource([solo, viewer2]);

        const createHandled2 = gate.dispatch(solo, CQ_CREATE, makeCreateBody('Solo Room'));
        assert.strictEqual(createHandled2, true, 'CQ_CREATE must be handled with ROOM_JOIN_MODE off');
        const soloRoomId = solo.createdRoomIndex_;
        assert.ok(rooms.getRoom(soloRoomId), 'room must be tracked even with ROOM_JOIN_MODE off (dual-write is unconditional)');

        const createBroadcasts = viewer2._sent.filter((s) => s.op === ROOM_LIST_SN);
        assert.strictEqual(createBroadcasts.length, 1, 'viewer must get one Room_List_SN on room creation with ROOM_JOIN_MODE off');
        assert.strictEqual(Buffer.from(createBroadcasts[0].hex, 'hex').readUInt8(4), 1, 'create broadcast UpdateType must be 1 (new room)');

        viewer2._sent.length = 0;

        leaveRoomAndNotify(21);

        assert.strictEqual(rooms.getRoom(soloRoomId), undefined, 'room must be removed from the registry once its last member leaves, even with ROOM_JOIN_MODE off');

        const deleteBroadcasts = viewer2._sent.filter((s) => s.op === ROOM_LIST_SN);
        assert.strictEqual(deleteBroadcasts.length, 1, 'viewer must get one Room_List_SN (UpdateType=3) when the room empties, ROOM_JOIN_MODE off -- this is the D1-4b bug fix');
        const deleteEntry = Buffer.from(deleteBroadcasts[0].hex, 'hex');
        assert.strictEqual(deleteEntry.readUInt8(4), 3, 'delete broadcast UpdateType must be 3');
        assert.strictEqual(deleteEntry.readUInt16LE(2), soloRoomId, 'delete broadcast RoomIndex must match the room that emptied');

        console.log('[room-join test] PASS: create + solo Leave_CQ both broadcast to the lobby with LOBBY_ROOM_LIST_MODE on and ROOM_JOIN_MODE off');
    } finally {
        resetRooms();
    }

    resetRooms();

    const fakeTimers2 = installFakeTimers();
    try {
        const hostC = makeFakeClient(31, 30907);
        hostC.accountId_ = 31;
        hostC.nickname_ = 'Carol';
        const joinerD = makeFakeClient(32, 30907);
        joinerD.accountId_ = 32;
        joinerD.nickname_ = 'Dave';
        rooms.registerLobbyClientSource([hostC, joinerD]);

        const createHandled3 = gate.dispatch(hostC, CQ_CREATE, makeCreateBody('PvE Room'));
        assert.strictEqual(createHandled3, true, 'CQ_CREATE must be handled');
        const pveRoomId = hostC.createdRoomIndex_;

        while (fakeTimers2.fireNext()) {  }

        const ROOM_STATE_OPS = [
            '0x00220203',
            '0x0022021a',
            '0x00220213',
            '0x00220217',
            '0x00220214',
            '0x00220226',
            '0x00220223',
            '0x0023013a',
        ];
        function firstStateBurst(sentList) {
            const out = {};
            for (const op of ROOM_STATE_OPS) {
                const hits = sentList.filter((s) => s.op === op);
                assert.ok(hits.length > 0, `expected at least one ${op} in the room-state burst`);
                out[op] = hits[0].hex;
            }
            return out;
        }
        const hostBurst = firstStateBurst(hostC._sent);

        joinerD._sent.length = 0;
        const enterHandled3 = gate.dispatch(joinerD, ENTER_CQ, makeEnterBody(pveRoomId));
        assert.strictEqual(enterHandled3, true, 'Enter_CQ must be handled');
        while (fakeTimers2.fireNext()) {  }
        const joinerBurst = firstStateBurst(joinerD._sent);

        assert.strictEqual(
            hostBurst['0x00220203'].slice(8),
            joinerBurst['0x00220203'].slice(8),
            'Room_Default_SN bytes from offset 0x04 onward must match between host and joiner (roomType/mapIndex/maxPlayers/gameMode/teams/settings/entries)'
        );
        assert.notStrictEqual(
            hostBurst['0x00220203'].slice(0, 8),
            joinerBurst['0x00220203'].slice(0, 8),
            'Room_Default_SN offset 0x00-0x03 (accountIndex/roomLinkIndex) is identity-dependent and must differ (host=31, joiner=32)'
        );

        assert.strictEqual(Buffer.from(hostBurst['0x00220203'], 'hex').readUInt8(4), 1, 'host roomType byte must be 1 (PvE)');
        assert.strictEqual(Buffer.from(joinerBurst['0x00220203'], 'hex').readUInt8(4), 1, 'joiner roomType byte must be 1 (PvE), not 2 (PvP shell)');

        assert.strictEqual(
            hostBurst['0x00220213'].slice(2, 4),
            joinerBurst['0x00220213'].slice(2, 4),
            'Room_Boundary_SN maxPlayers byte must match'
        );
        assert.strictEqual(Buffer.from(hostBurst['0x00220213'], 'hex').readUInt8(0), 1, 'host burst currentUsers must be 1 (captured solo, right after CQ_CREATE)');
        assert.strictEqual(Buffer.from(joinerBurst['0x00220213'], 'hex').readUInt8(0), 2, 'joiner burst currentUsers must be 2 (captured after her own Enter_CQ added her)');

        for (const op of ROOM_STATE_OPS) {
            if (op === '0x00220203') continue;
            if (op === '0x00220213') continue;
            assert.strictEqual(hostBurst[op], joinerBurst[op], `${op} must be byte-for-byte identical between host and joiner`);
        }

        console.log('[room-join test] PASS: joiner\'s room-state burst matches the host\'s byte-for-byte (except accountIndex/roomLinkIndex), including Map_Change_ALL/ONE and Campaign_SN which were previously never sent to a joiner at all');
    } finally {
        fakeTimers2.restore();
        resetRooms();
    }

    resetRooms();

    const fakeTimers3 = installFakeTimers();
    try {
        const hostE = makeFakeClient(41, 30907);
        hostE.accountId_ = 41;
        hostE.nickname_ = 'Erin';
        const joinerF = makeFakeClient(42, 30907);
        joinerF.accountId_ = 42;
        joinerF.nickname_ = 'Frank';
        rooms.registerLobbyClientSource([hostE, joinerF]);

        const createBody4 = makeCreateBody('Erin Room');
        createBody4.writeUInt16LE(9007, 2);
        const createHandled4 = gate.dispatch(hostE, CQ_CREATE, createBody4);
        assert.strictEqual(createHandled4, true, 'CQ_CREATE must be handled');
        const roomId4 = hostE.createdRoomIndex_;
        assert.strictEqual(rooms.getRoom(roomId4).mapId, 9007, 'room.mapId must be the map Erin picked');
        while (fakeTimers3.fireNext()) {  }

        const enterHandled4 = gate.dispatch(joinerF, ENTER_CQ, makeEnterBody(roomId4));
        assert.strictEqual(enterHandled4, true, 'Enter_CQ must be handled');
        while (fakeTimers3.fireNext()) {  }

        joinerF._sent.length = 0;
        const readyBody = Buffer.from('270a000001', 'hex');
        const readyHandled = gate.dispatch(joinerF, 0x00222101, readyBody);
        assert.strictEqual(readyHandled, true, 'Ready/Room_Enter_CN 0x00222101 must be handled');

        const roomDefaultHits = joinerF._sent.filter((s) => s.op === '0x00220203');
        assert.ok(roomDefaultHits.length > 0, 'Ready resend must include Room_Default_SN');
        const mapIndex = Buffer.from(roomDefaultHits[0].hex, 'hex').readUInt16LE(0x05);
        assert.strictEqual(mapIndex, 9007, "Ready resend must carry the room's actual map (9007), not MAP_ID_DEFAULT_PVE (9001) or any other joiner-side fallback");

        const masterHits = joinerF._sent.filter((s) => s.op === USER_MASTER_SN);
        assert.ok(masterHits.length > 0, 'Ready resend must include User_Master_SN');
        const masterAccountIndex = Buffer.from(masterHits[0].hex, 'hex').readUInt16LE(0x00);
        assert.strictEqual(masterAccountIndex, 41, 'User_Master_SN in the Ready resend must name the host (Erin, account 41), not the joiner (Frank, account 42) who pressed Ready');

        console.log('[room-join test] PASS: joiner pressing Ready (0x00222101) after joining gets a room-state resend read from the shared Room, not her own client fields -- correct map and host identity');
    } finally {
        fakeTimers3.restore();
        resetRooms();
    }

    resetRooms();

    const fakeTimers4 = installFakeTimers();
    try {
        const hostG = makeFakeClient(51, 30907);
        hostG.accountId_ = 51;
        hostG.nickname_ = 'Grace';
        const joinerH = makeFakeClient(52, 30907);
        joinerH.accountId_ = 52;
        joinerH.nickname_ = 'Heidi';
        rooms.registerLobbyClientSource([hostG, joinerH]);

        const createHandled5 = gate.dispatch(hostG, CQ_CREATE, makeCreateBody('Grace Room'));
        assert.strictEqual(createHandled5, true, 'CQ_CREATE must be handled');
        const roomId5 = hostG.createdRoomIndex_;
        while (fakeTimers4.fireNext()) {  }

        const enterHandled5 = gate.dispatch(joinerH, ENTER_CQ, makeEnterBody(roomId5));
        assert.strictEqual(enterHandled5, true, 'Enter_CQ must be handled');
        while (fakeTimers4.fireNext()) {  }

        assert.ok(rooms.getRoom(roomId5).members.has(52), 'Heidi must be a member before either kick attempt');

        hostG._sent.length = 0;
        joinerH._sent.length = 0;

        const kickBodyByNonHost = Buffer.alloc(2);
        kickBodyByNonHost.writeUInt16LE(51, 0);
        const kickHandled1 = gate.dispatch(joinerH, 0x00220337, kickBodyByNonHost);
        assert.strictEqual(kickHandled1, true, 'Kickout_CQ from a non-host must still be handled (with a failure reply)');

        const nonHostSa = joinerH._sent.filter((s) => s.op === '0x00220338');
        assert.strictEqual(nonHostSa.length, 1, 'non-host kicker must get exactly one Kickout_SA');
        assert.notStrictEqual(nonHostSa[0].hex, '000000000000', 'non-host Kickout_SA must be a failure (non-zero header), not the 0/0 success header');
        assert.strictEqual(hostG._sent.length, 0, 'the target (host) must receive nothing when a non-host tries to kick her');
        assert.ok(rooms.getRoom(roomId5).members.has(51), 'the host must still be a member after a failed kick attempt');
        assert.ok(rooms.getRoom(roomId5).members.has(52), 'the non-host kicker must still be a member after her own failed kick attempt');
        console.log('[room-join test] PASS: a non-host Kickout_CQ against the host fails and changes nothing');

        joinerH._sent.length = 0;

        const kickBodyByHost = Buffer.alloc(2);
        kickBodyByHost.writeUInt16LE(52, 0);
        const kickHandled2 = gate.dispatch(hostG, 0x00220337, kickBodyByHost);
        assert.strictEqual(kickHandled2, true, 'Kickout_CQ from the host must be handled');

        const hostSa = hostG._sent.filter((s) => s.op === '0x00220338');
        assert.strictEqual(hostSa.length, 1, 'host kicker must get exactly one Kickout_SA');
        assert.strictEqual(hostSa[0].hex, '000000000000', 'host Kickout_SA must be a success (0/0 header)');

        const kickedLeaveSn = joinerH._sent.filter((s) => s.op === LEAVE_SN);
        assert.strictEqual(kickedLeaveSn.length, 1, 'the kicked member must receive exactly one Leave_SN');
        assert.strictEqual(kickedLeaveSn[0].hex, '340001', 'Leave_SN to the kicked member must be UserIndex=52 (LE u16 0x0034) + Kickout=1');

        assert.strictEqual(rooms.getRoomByAccount(52), undefined, 'the kicked member must no longer be tracked as a room member');
        assert.ok(rooms.getRoomByAccount(51), 'the host must still be in the room after kicking someone else');
        assert.strictEqual(rooms.getRoom(roomId5).members.size, 1, 'the room must have exactly one member (the host) left');

        console.log('[room-join test] PASS: a host Kickout_CQ against a real member succeeds -- success SA to the host, Leave_SN(kicked, kickout=1) to the kicked member, room membership actually drops');
    } finally {
        fakeTimers4.restore();
        resetRooms();
    }

    resetRooms();

    const fakeTimers5 = installFakeTimers();
    try {
        const hostI = makeFakeClient(61, 30907);
        hostI.accountId_ = 61;
        hostI.nickname_ = 'Ivy';
        const joinerJ = makeFakeClient(62, 30907);
        joinerJ.accountId_ = 62;
        joinerJ.nickname_ = 'Judy';
        rooms.registerLobbyClientSource([hostI, joinerJ]);

        const createHandled6 = gate.dispatch(hostI, CQ_CREATE, makeCreateBody('Ivy Room'));
        assert.strictEqual(createHandled6, true, 'CQ_CREATE must be handled');
        const roomId6 = hostI.createdRoomIndex_;
        while (fakeTimers5.fireNext()) {  }

        const enterHandled6 = gate.dispatch(joinerJ, ENTER_CQ, makeEnterBody(roomId6));
        assert.strictEqual(enterHandled6, true, 'Enter_CQ must be handled');
        while (fakeTimers5.fireNext()) {  }

        const mapChangeBody = makeMapChangeOneBody({ b0: 0, w1: 9007, w2: 45, b5: 3, w6: 0, w8: 0 });

        const expectedSnHex = makeMapChangeOneBody({ b0: 0, w1: 9007, w2: 45, b5: 3, w6: 0, w8: 0 }).toString('hex');

        hostI._sent.length = 0;
        joinerJ._sent.length = 0;
        try {
            const mapChangeHandledOn = gate.dispatch(hostI, MAP_CHANGE_ONE_CQ, mapChangeBody);
            assert.strictEqual(mapChangeHandledOn, true, 'Map_Change_One_CQ must be handled');
            const joinerHitsOn = joinerJ._sent.filter((s) => s.op === MAP_CHANGE_ONE_SN);
            assert.strictEqual(joinerHitsOn.length, 1, 'ROOM_MAP_BROADCAST_MODE on: joiner must receive exactly one Map_Change_One_SN');
            assert.strictEqual(joinerHitsOn[0].hex, expectedSnHex, "joiner's Map_Change_One_SN body must be identical to the host's own map-change payload");
            console.log('[room-join test] PASS: ROOM_MAP_BROADCAST_MODE on -- joiner receives one Map_Change_One_SN with the host-identical body');
        } finally {

        }
    } finally {
        fakeTimers5.restore();
        resetRooms();
    }

    const USER_STATE_SN = '0x00220401';
    function decodeUserState(hex) {
        const buf = Buffer.from(hex, 'hex');
        return { userIndex: buf.readUInt16LE(0x02), raw: buf.readUInt32LE(0x04) };
    }
    resetRooms();

    const fakeTimers6 = installFakeTimers();
    try {
        const hostK = makeFakeClient(71, 30907);
        hostK.accountId_ = 71;
        hostK.nickname_ = 'Kara';
        const joinerL = makeFakeClient(72, 30907);
        joinerL.accountId_ = 72;
        joinerL.nickname_ = 'Liam';
        rooms.registerLobbyClientSource([hostK, joinerL]);

        const createHandled7 = gate.dispatch(hostK, CQ_CREATE, makeCreateBody('Kara Room'));
        assert.strictEqual(createHandled7, true, 'CQ_CREATE must be handled');
        const roomId7 = hostK.createdRoomIndex_;
        while (fakeTimers6.fireNext()) {  }

        const enterHandled7 = gate.dispatch(joinerL, ENTER_CQ, makeEnterBody(roomId7));
        assert.strictEqual(enterHandled7, true, 'Enter_CQ must be handled');
        while (fakeTimers6.fireNext()) {  }

        hostK._sent.length = 0;
        joinerL._sent.length = 0;
        const readyBody = Buffer.from('270a000001', 'hex');
        const readyHandledFirst = gate.dispatch(joinerL, 0x00222101, readyBody);
        assert.strictEqual(readyHandledFirst, true, 'Ready 0x00222101 must be handled');

        hostK._sent.length = 0;
        joinerL._sent.length = 0;

        const readyHandledOn = gate.dispatch(joinerL, 0x00222101, Buffer.from('270a000001', 'hex'));
        assert.strictEqual(readyHandledOn, true, 'Ready 0x00222101 must be handled');

        hostK._sent.length = 0;
        joinerL._sent.length = 0;
        assert.strictEqual(gate.dispatch(joinerL, 0x00222101, Buffer.from('270a000000', 'hex')), true, 'un-ready 0x00222101 must be handled');
        assert.strictEqual(rooms.getRoomByAccount(72).members.get(72).ready, false, 'player must be able to un-ready');
        assert.deepStrictEqual(decodeUserState(hostK._sent.find((s) => s.op === USER_STATE_SN).hex), { userIndex: 72, raw: 1 }, 'un-ready must broadcast waiting state');
        gate.dispatch(joinerL, 0x00222101, Buffer.from('270a000001', 'hex'));

        const hostReadyHits = hostK._sent.filter((s) => s.op === USER_STATE_SN).map((s) => decodeUserState(s.hex));
        assert.strictEqual(hostReadyHits.length, 2, 'the host must receive the explicit un-ready and ready state updates');
        assert.deepStrictEqual(hostReadyHits[0], { userIndex: 72, raw: 1 }, "the host's first update must mark the joiner WAITING (raw 1)");
        assert.deepStrictEqual(hostReadyHits[1], { userIndex: 72, raw: 2 }, "the host's second update must mark the joiner READY (raw 2)");

        const joinerReadyHits = joinerL._sent.filter((s) => s.op === USER_STATE_SN).map((s) => decodeUserState(s.hex));
        const joinerOwnReadyBroadcast = joinerReadyHits.filter((h) => h.userIndex === 72 && h.raw === 2);
        assert.strictEqual(joinerOwnReadyBroadcast.length, 1, 'the joiner must also receive her own User_State_SN broadcast (raw 2), sendAll includes the sender');
        console.log('[room-join test] PASS: pressing Ready broadcasts User_State_SN raw=2 to every room member including the presser');

        const freshM = makeFakeClient(73, 30907);
        freshM.accountId_ = 73;
        freshM.nickname_ = 'Mona';
        rooms.registerLobbyClientSource([hostK, joinerL, freshM]);
        const enterHandled8 = gate.dispatch(freshM, ENTER_CQ, makeEnterBody(roomId7));
        assert.strictEqual(enterHandled8, true, 'Enter_CQ for the third member must be handled');
        while (fakeTimers6.fireNext()) {  }

        const newcomerReadyHits = freshM._sent.filter((s) => s.op === USER_STATE_SN).map((s) => decodeUserState(s.hex));
        const joinerAsSeenByNewcomer = newcomerReadyHits.filter((h) => h.userIndex === 72);
        assert.strictEqual(joinerAsSeenByNewcomer.length, 1, 'the newcomer must receive exactly one User_State_SN for the already-ready joiner');
        assert.strictEqual(joinerAsSeenByNewcomer[0].raw, 2, "the newcomer's room-state burst must show the joiner already READY (raw 2)");
        const hostAsSeenByNewcomer = newcomerReadyHits.filter((h) => h.userIndex === 71);
        assert.strictEqual(hostAsSeenByNewcomer.length, 1, 'the newcomer must also receive exactly one User_State_SN for the host');
        assert.strictEqual(hostAsSeenByNewcomer[0].raw, 1, "the host has not pressed Ready -- newcomer's burst must show raw 1 for her");
        console.log('[room-join test] PASS: a member joining afterward sees the already-ready joiner\'s User_State_SN raw=2 in her own room-state burst');
    } finally {
        fakeTimers6.restore();
        resetRooms();
    }

    const pvpHost = makeFakeClient(81, 30907);
    const pvpJoiner = makeFakeClient(82, 30907);
    const lobbyWatcher = makeFakeClient(83, 30907);
    pvpHost.accountId_ = 81;
    pvpJoiner.accountId_ = 82;
    lobbyWatcher.accountId_ = 83;
    pvpHost.username_ = 'PvpHost';
    pvpHost.mapChangeOneTime_ = 5;
    pvpHost.mapChangeOneRound_ = 1;
    pvpHost.mapChangeOneKill_ = 50;
    pvpHost.mapChangeOneGoal_ = 0;
    pvpHost.nickname_ = 'PvpHost';
    pvpJoiner.nickname_ = 'PvpJoiner';
    rooms.registerLobbyClientSource([pvpHost, pvpJoiner, lobbyWatcher]);
    const pvpCreateBody = makeCreateBody('Pvp Room');
    pvpCreateBody[0] = 2;
    pvpCreateBody[6] = 2;
    pvpCreateBody.writeUInt16LE(3, 4);
    pvpCreateBody.writeUInt16LE(3, 12);
    assert.strictEqual(gate.dispatch(pvpHost, CQ_CREATE, pvpCreateBody), true, 'PvP room creation must be handled');
    const pvpRoom = rooms.getRoom(pvpHost.createdRoomIndex_);
    assert.strictEqual(pvpRoom.maxPlayers, 8, 'PvP 4v4 setting must allow eight total players');
    assert.strictEqual(pvpRoom.maxPlayersWire, 3, 'PvP wire size must preserve the client 4v4 selection');
    assert.strictEqual(pvpRoom.playTime, 5, 'PvP room must retain the host-selected time setting');
    assert.strictEqual(pvpRoom.playRound, 1, 'PvP room must not interpret the selected map ID as its round count');

    const pvpSettingsBody = makeMapChangeOneBody({ w1: 1011, w2: 7, b5: 3, w6: 20, w8: 5 });
    assert.strictEqual(gate.dispatch(pvpHost, 0x00220221, pvpSettingsBody), true, 'PvP map/settings change must be handled');
    assert.strictEqual(pvpRoom.playTime, 7, 'host time setting must be stored on the shared room');
    assert.strictEqual(pvpRoom.playRound, 3, 'host round setting must be stored on the shared room');
    assert.strictEqual(pvpRoom.mapChangeOneKill, 20, 'host kill setting must be stored on the shared room');
    assert.strictEqual(pvpRoom.mapChangeOneGoal, 5, 'host goal setting must be stored on the shared room');

    const optionChangeBody = Buffer.from([0, 1, 1]);
    assert.strictEqual(gate.dispatch(pvpHost, 0x00220215, optionChangeBody), true, 'PvP room option change must be handled');
    assert.strictEqual(pvpRoom.options.balance, true, 'room must retain the host-selected balance option');
    assert.strictEqual(pvpRoom.options.intrude, true, 'room must retain the host-selected join option');
    const hostOptionPacket = pvpHost._sent.findLast((s) => s.op === '0x00220217');
    assert.ok(hostOptionPacket, 'host must receive the updated room options');
    assert.deepStrictEqual(Buffer.from(hostOptionPacket.hex, 'hex').subarray(0, 4), Buffer.from([0, 1, 1, 0]));

    const pvpJoinTimers = installFakeTimers();
    try {
        assert.strictEqual(gate.dispatch(pvpJoiner, ENTER_CQ, makeEnterBody(pvpRoom.id)), true, 'PvP room entry must be handled');
        while (pvpJoinTimers.fireNext()) { }
    } finally {
        pvpJoinTimers.restore();
    }
    const joinerRoomDefault = pvpJoiner._sent.find((s) => s.op === '0x00220203');
    assert.ok(joinerRoomDefault, 'PvP joiner must receive room settings');
    const joinerSettings = Buffer.from(joinerRoomDefault.hex, 'hex');
    assert.strictEqual(joinerSettings.readUInt8(0x07), 3, 'PvP joiner must receive the client wire setting for 4v4');
    const joinerBoundary = pvpJoiner._sent.find((s) => s.op === '0x00220213');
    assert.ok(joinerBoundary, 'PvP joiner must receive the room boundary');
    assert.strictEqual(Buffer.from(joinerBoundary.hex, 'hex').readUInt8(1), 8, 'PvP joiner must receive an eight-player boundary for 4v4');
    assert.deepStrictEqual(
        { goal: joinerSettings.readUInt8(0x1C), time: joinerSettings.readUInt8(0x1D), round: joinerSettings.readUInt8(0x1E) },
        { goal: 5, time: 7, round: 3 },
        'PvP joiner must receive the host-selected shared goal, time, and round settings'
    );
    assert.deepStrictEqual(
        Buffer.from(pvpJoiner._sent.findLast((s) => s.op === '0x00220217').hex, 'hex').subarray(0, 4),
        Buffer.from([0, 1, 1, 0]),
        'PvP joiner must receive shared balance and join options'
    );
    pvpHost._sent.length = 0;
    pvpJoiner._sent.length = 0;
    assert.strictEqual(gate.dispatch(pvpHost, 0x00220215, Buffer.from([0, 0, 0])), true, 'PvP room options must be switchable off');
    assert.strictEqual(pvpRoom.options.balance, false);
    assert.strictEqual(pvpRoom.options.intrude, false);
    assert.deepStrictEqual(Buffer.from(pvpHost._sent.findLast((s) => s.op === '0x00220217').hex, 'hex').subarray(0, 4), Buffer.from([0, 0, 0, 0]));
    assert.deepStrictEqual(Buffer.from(pvpJoiner._sent.findLast((s) => s.op === '0x00220217').hex, 'hex').subarray(0, 4), Buffer.from([0, 0, 0, 0]));

    pvpHost._sent.length = 0;
    pvpJoiner._sent.length = 0;
    assert.strictEqual(gate.dispatch(pvpHost, 0x00220211, Buffer.from([16])), true, 'PvP room capacity change must be handled');
    assert.strictEqual(pvpRoom.maxPlayers, 16, '8v8 room setting must update total room capacity');
    assert.strictEqual(pvpRoom.maxPlayersWire, 7, '8v8 room setting must update the room default size value');
    assert.ok(pvpHost._sent.find((s) => s.op === '0x00220212'), 'host must receive MaxUser_Change_SA');
    assert.strictEqual(Buffer.from(pvpHost._sent.findLast((s) => s.op === '0x00220203').hex, 'hex').readUInt8(0x07), 7);
    assert.strictEqual(Buffer.from(pvpJoiner._sent.findLast((s) => s.op === '0x00220203').hex, 'hex').readUInt8(0x07), 7);
    assert.strictEqual(Buffer.from(pvpJoiner._sent.findLast((s) => s.op === '0x00220213').hex, 'hex').readUInt8(1), 16);

    const pvpListEntry = buildRoomListEntry(pvpRoom, 1);
    assert.strictEqual(pvpListEntry.readUInt8(7), 2, 'PvP room list entry must preserve wire room type 2');
    assert.strictEqual(pvpListEntry.readUInt8(11), 16, 'PvP room list entry must advertise sixteen total seats for 8v8');

    const mapListRequest = Buffer.alloc(56);
    mapListRequest[0] = 1;
    mapListRequest[1] = 6;
    for (let i = 0; i < 6; i++) {
        const off = 2 + i * 9;
        mapListRequest.writeUInt16LE(1011 + i * 10, off);
        mapListRequest.writeUInt16LE(5, off + 2);
        mapListRequest.writeUInt8(i === 0 ? 1 : 0, off + 4);
    }
    pvpHost._sent.length = 0;
    assert.strictEqual(gate.dispatch(pvpHost, 0x00220224, mapListRequest), true, 'Map_Change_All_CQ must be handled');
    const mapListAck = pvpHost._sent.find((s) => s.op === '0x00220225');
    assert.ok(mapListAck, 'Map_Change_All_CQ must receive its matching SA instead of falling through unhandled');
    assert.deepStrictEqual(Buffer.from(mapListAck.hex, 'hex'), Buffer.alloc(6), 'Map_Change_All_SA must acknowledge success');

    const teamChangeBody = Buffer.alloc(2);
    teamChangeBody.writeUInt16LE(1, 0);
    const teamChangeHandled = gate.dispatch(pvpJoiner, 0x00220311, teamChangeBody);
    assert.strictEqual(teamChangeHandled, true, 'PvP team change must be handled');
    assert.strictEqual(pvpRoom.members.get(82).team, 1, 'server member state must retain the selected blue team');
    assert.ok(pvpJoiner._sent.some((s) => s.op === '0x00220312'), 'team changer must receive Team_Change_SA');
    const hostTeamState = pvpHost._sent.findLast((s) => s.op === USER_DEFAULT_SN && Buffer.from(s.hex, 'hex').readUInt16LE(0x02) === 82);
    assert.ok(hostTeamState, 'host must receive the updated joiner user state');
    assert.strictEqual(Buffer.from(hostTeamState.hex, 'hex').readUInt16LE(0x13), 1, 'host must see the joiner on blue team');
    console.log('[room-join test] PASS: PvP room type and team changes are retained and broadcast to the host');

    const startTimers = installFakeTimers();
    try {
        pvpHost._sent.length = 0;
        pvpJoiner._sent.length = 0;
        assert.strictEqual(gate.dispatch(pvpHost, 0x00222103, Buffer.alloc(0)), true, 'room game start must be handled');
        while (startTimers.fireNext()) { await new Promise((resolve) => setImmediate(resolve)); }
    } finally {
        startTimers.restore();
    }
    const gameInfoPacket = pvpHost._sent.find((s) => s.op === '0x00222111');
    assert.ok(gameInfoPacket, 'host must receive game-info roster state');
    assert.strictEqual(Buffer.from(gameInfoPacket.hex, 'hex').readUInt16LE(0x0F), 2, 'game-info roster count must match the two current room members');
    const gameUserPackets = pvpHost._sent.filter((s) => s.op === '0x00222112');
    assert.strictEqual(gameUserPackets.length, 2, 'host must receive both in-game user records');
    const joinerGameUser = gameUserPackets.find((s) => Buffer.from(s.hex, 'hex').readUInt16LE(0x02) === 82);
    assert.ok(joinerGameUser, 'host must receive the joiner in the in-game user table');
    assert.strictEqual(Buffer.from(joinerGameUser.hex, 'hex').readUInt16LE(0x04), 1, 'in-game user table must preserve the joiner on blue team');
    const hostGameUser = pvpJoiner._sent.filter((s) => s.op === '0x00222112').find((s) => Buffer.from(s.hex, 'hex').readUInt16LE(0x02) === 81);
    assert.ok(hostGameUser, 'joiner must receive the host in the in-game user table');
    assert.strictEqual(Buffer.from(hostGameUser.hex, 'hex').readUInt16LE(0x04), 0, 'in-game user table must preserve the host on red team');
    assert.strictEqual(pvpRoom.state, 'playing', 'the shared room must enter the in-progress state on start');
    assert.strictEqual(buildRoomListEntry(pvpRoom, 1).readUInt8(8), 1, 'room-list state must identify the room as in progress');
    assert.ok(lobbyWatcher._sent.some((s) => s.op === ROOM_LIST_SN && Buffer.from(s.hex, 'hex').includes(Buffer.from([pvpRoom.id, 0, 2]))), 'lobby watchers must receive the running-room update');

    pvpHost._sent.length = 0;
    const deathBody = Buffer.alloc(11);
    deathBody.writeUInt16LE(81, 0);
    deathBody.writeUInt16LE(82, 2);
    deathBody[4] = 1;
    assert.strictEqual(lobby.dispatch(pvpHost, 0x00230123, deathBody), true, 'PvP kill must be handled');
    let deathPacket = pvpHost._sent.find((s) => s.op === '0x00230124');
    assert.strictEqual(Buffer.from(deathPacket.hex, 'hex').readUInt16LE(0x06), 1, 'red team kill score must appear in Death_SN');
    assert.strictEqual(Buffer.from(deathPacket.hex, 'hex').readUInt16LE(0x08), 0, 'blue team score must remain zero after a red kill');
    deathBody.writeUInt16LE(82, 0);
    deathBody.writeUInt16LE(81, 2);
    pvpJoiner._sent.length = 0;
    assert.strictEqual(lobby.dispatch(pvpHost, 0x00230123, deathBody), true, 'opposing PvP kill must be handled');
    deathPacket = pvpJoiner._sent.find((s) => s.op === '0x00230124');
    assert.strictEqual(Buffer.from(deathPacket.hex, 'hex').readUInt16LE(0x06), 1, 'red team score must be retained');
    assert.strictEqual(Buffer.from(deathPacket.hex, 'hex').readUInt16LE(0x08), 1, 'blue team kill score must increment');

    const deniedJoiner = makeFakeClient(84, 30907);
    deniedJoiner.accountId_ = 84;
    assert.strictEqual(gate.dispatch(deniedJoiner, ENTER_CQ, makeEnterBody(pvpRoom.id)), true, 'mid-match entry request must be handled');
    assert.strictEqual(pvpRoom.members.has(84), false, 'join-in-progress must be rejected while the room option is off');
    assert.strictEqual(Buffer.from(deniedJoiner._sent.find((s) => s.op === '0x00220232').hex, 'hex').readUInt16LE(0), 1, 'rejected entry must receive a failure response');

    pvpRoom.state = 'lobby';
    pvpRoom.battleStartGen = 0;
    pvpRoom.beginRoundAcceptedAt = 0;
    assert.strictEqual(lobby.dispatch(pvpHost, 0x00230151, Buffer.alloc(0)), true, 'BeginRound must be handled');
    assert.strictEqual(pvpRoom.state, 'playing', 'BeginRound must mark the room in progress');
    assert.ok(lobbyWatcher._sent.some((s) => s.op === ROOM_LIST_SN && Buffer.from(s.hex, 'hex').includes(Buffer.from([pvpRoom.id, 0, 2]))), 'BeginRound must refresh lobby room state');

    const generationBeforeDuplicateStart = pvpRoom.battleStartGen;
    const duplicateStartTimers = installFakeTimers();
    try {
        assert.strictEqual(gate.dispatch(pvpHost, 0x00222103, Buffer.alloc(0)), true);
        assert.strictEqual(pvpRoom.battleStartGen, generationBeforeDuplicateStart, 'duplicate starts must not create a new battle generation');
        assert.strictEqual(duplicateStartTimers.hasPending(), false, 'duplicate start must not schedule another match start');
    } finally {
        duplicateStartTimers.restore();
    }

    pvpHost._sent.length = 0;
    assert.strictEqual(gate.dispatch(pvpHost, 0x00220215, Buffer.from([0, 0, 1])), true, 'host must be able to enable in-progress joins');
    assert.ok(!pvpHost._sent.some((s) => s.op === USER_MASTER_SN), 'room settings changes must not resend the host appointment popup');
    const lateJoiner = makeFakeClient(85, 30907);
    lateJoiner.accountId_ = 85;
    lateJoiner.nickname_ = 'LateJoiner';
    lateJoiner.pilot_ = 103;
    const lateJoinTimers = installFakeTimers();
    try {
        assert.strictEqual(gate.dispatch(lateJoiner, ENTER_CQ, makeEnterBody(pvpRoom.id)), true, 'mid-match entry must be handled');
        while (lateJoinTimers.fireNext()) await new Promise((resolve) => setImmediate(resolve));
    } finally {
        lateJoinTimers.restore();
    }
    assert.strictEqual(pvpRoom.state, 'playing', 'joining must not return the existing room to its lobby');
    assert.strictEqual(pvpRoom.members.get(85).team, 0, 'late joiner must be assigned to the smaller PvP team');
    assert.ok(lateJoiner._sent.some((s) => s.op === '0x00420111'), 'late joiner must receive the transition into the active match');
    assert.ok(lateJoiner._sent.some((s) => s.op === '0x00222112'), 'late joiner must receive the in-game player roster');
    assert.ok(lateJoiner._sent.some((s) => s.op === '0x00222111'), 'late joiner must receive the active match settings');
    assert.ok(lateJoiner._sent.some((s) => s.op === '0x00222104'), 'late joiner must receive the game-start acknowledgement');

    const lateLeaveTimers = installFakeTimers();
    try {
        assert.strictEqual(gate.dispatch(lateJoiner, 0x00220234, Buffer.alloc(0)), true, 'late joiner must be able to leave the room');
        while (lateLeaveTimers.fireNext()) { }
    } finally {
        lateLeaveTimers.restore();
    }
    console.log('[room-join test] PASS: game-start user table retains each PvP member\'s selected team');

    const leaveTimers = installFakeTimers();
    try {
        pvpRoom.state = 'playing';
        pvpRoom.members.get(82).team = 1;
        pvpRoom.members.get(81).team = 0;
        pvpHost._sent.length = 0;
        assert.strictEqual(gate.dispatch(pvpJoiner, 0x00222131, Buffer.alloc(0)), true, 'in-battle leave must be handled');
        assert.strictEqual(pvpRoom.state, 'lobby', 'a PvP match must end when one side leaves the match');
        const endGame = pvpHost._sent.find((s) => s.op === '0x00222213');
        assert.ok(endGame, 'remaining PvP player must receive EndGame_SN when the opposing side leaves');
        assert.strictEqual(Buffer.from(endGame.hex, 'hex').readUInt16LE(0), 0, 'remaining red player must be declared the winner');

        const leaveHandled = gate.dispatch(pvpJoiner, 0x00220234, Buffer.alloc(0));
        assert.strictEqual(leaveHandled, true, 'room leave must be handled');
        assert.strictEqual(rooms.getRoomByAccount(82), undefined, 'leaving member must be removed from room state');
        assert.strictEqual(pvpRoom.members.size, 1, 'remaining host must no longer see the leaver in room state');
        assert.strictEqual(pvpRoom.members.get(81).ready, false, 'remaining player must return to waiting after match end');
        assert.strictEqual(pvpJoiner.roomType_, 0, 'leaving client room session must reset');
        while (leaveTimers.fireNext()) { }
        assert.ok(pvpJoiner._sent.some((s) => s.op === '0x00230112'), 'leaving client must receive lobby-enter state');
        assert.ok(pvpJoiner._sent.some((s) => s.op === '0x00230103'), 'leaving client must receive lobby room-list state');
        console.log('[room-join test] PASS: leaving a room resets membership and restores lobby state');
    } finally {
        leaveTimers.restore();
    }
    resetRooms();

    for (const [requestedMaxPlayers, teamSize] of [[8, 4], [16, 8], [24, 12], [32, 16]]) {
        const sizeHost = makeFakeClient(90 + requestedMaxPlayers, 30907);
        sizeHost.accountId_ = 90 + requestedMaxPlayers;
        sizeHost.nickname_ = `Size${teamSize}`;
        sizeHost.username_ = `Size${teamSize}`;
        rooms.registerLobbyClientSource([sizeHost]);
        const sizeBody = makeCreateBody(`Size ${teamSize}`);
        sizeBody[0] = 2;
        sizeBody[1] = requestedMaxPlayers;
        sizeBody.writeUInt16LE(3, 12);
        const sizeTimers = installFakeTimers();
        try {
            assert.strictEqual(gate.dispatch(sizeHost, CQ_CREATE, sizeBody), true, `${teamSize}v${teamSize} PvP room creation must be handled`);
            const sizeRoom = rooms.getRoom(sizeHost.createdRoomIndex_);
            assert.strictEqual(sizeRoom.maxPlayers, teamSize * 2, `${teamSize}v${teamSize} PvP room must allow ${teamSize * 2} players`);
            assert.strictEqual(sizeRoom.maxPlayersWire, teamSize - 1, `${teamSize}v${teamSize} room must send its normalized size value`);
        } finally {
            sizeTimers.restore();
            resetRooms();
        }
    }

    console.log('[room-join test] ALL CHECKS PASS');
    process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
