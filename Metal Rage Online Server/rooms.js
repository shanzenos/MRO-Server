

'use strict';

const rooms = new Map();

const byAccount = new Map();

let nextRoomId = 1;

let clientSource = [];

function registerLobbyClientSource(clientArrayRef) {
    clientSource = clientArrayRef || [];
}

function getLobbyClients() {
    return clientSource.filter((client) => client && client.accountId_ && !byAccount.has(Number(client.accountId_)));
}

function allocateRoomId() {
    return nextRoomId++;
}

function createRoom({
    id, name, mapId, playTime, playRound, maxPlayers, maxPlayersWire, campaign, hostAccountId, roomType, hasPassword, password,
    rawRoomType, gameMode, optionMask, createMapId, mapChangeOneKill, mapChangeOneGoal,
}) {
    const room = {
        id,
        name,
        mapId,
        playTime,
        playRound,
        mapChangeOneKill: mapChangeOneKill == null ? (campaign ? 0 : 1) : mapChangeOneKill,
        mapChangeOneGoal: mapChangeOneGoal == null ? (campaign ? 0 : 1) : mapChangeOneGoal,
        maxPlayers,
        maxPlayersWire: maxPlayersWire == null ? maxPlayers : maxPlayersWire,
        campaign: !!campaign,
        hostAccountId,

        roomType: roomType || 0,
        hasPassword: !!hasPassword,
        password: password || '',

        rawRoomType: rawRoomType || 0,
        gameMode: gameMode || 0,
        optionMask: (optionMask >>> 0) || 0,

        createMapId: createMapId || 0,

        options: {
            password: !!hasPassword,
            balance: false,
            intrude: false,
            training: false,
        },
        members: new Map(),
        state: 'lobby',
    };
    rooms.set(id, room);
    return room;
}

function getRoomByAccount(accountId) {
    const roomId = byAccount.get(accountId);
    if (roomId === undefined) return undefined;
    return rooms.get(roomId);
}

function getRoom(roomId) {
    return rooms.get(roomId);
}

function isPvpRoom(roomOrClient) {
    if (!roomOrClient) return false;
    const campaign = roomOrClient.campaign ?? roomOrClient.campaignRoom_;
    const rawRoomType = roomOrClient.rawRoomType ?? roomOrClient.rawRoomType_;
    return !campaign && Number(rawRoomType) === 2;
}

function setHost(roomId, accountId) {
    const room = rooms.get(roomId);
    if (!room) return false;
    room.hostAccountId = accountId;
    return true;
}

function updateRoomMapSelection(roomId, { mapId, playTime, playRound, mapChangeOneKill, mapChangeOneGoal }) {
    const room = rooms.get(roomId);
    if (!room) return false;
    if (mapId !== undefined) room.mapId = mapId;
    if (playTime !== undefined) room.playTime = playTime;
    if (playRound !== undefined) room.playRound = playRound;
    if (mapChangeOneKill !== undefined) room.mapChangeOneKill = mapChangeOneKill;
    if (mapChangeOneGoal !== undefined) room.mapChangeOneGoal = mapChangeOneGoal;
    return true;
}

function addMember(roomId, member) {
    const room = rooms.get(roomId);
    if (!room) throw new Error(`rooms.addMember: no room ${roomId}`);

    const full = {
        accountId: member.accountId,
        nickname: member.nickname || '',
        team: member.team || 0,
        slot: member.slot || 0,
        ready: member.ready || false,
        client: member.client || null,
        disconnectedAt: member.disconnectedAt || null,
    };

    room.members.set(full.accountId, full);
    byAccount.set(full.accountId, roomId);
    return full;
}

function removeMember(accountId) {
    const roomId = byAccount.get(accountId);
    if (roomId === undefined) return false;
    const room = rooms.get(roomId);
    if (room) {
        room.members.delete(accountId);
        if (room.members.size === 0) {
            rooms.delete(roomId);
        }
    }
    byAccount.delete(accountId);
    return true;
}

function setMemberClient(accountId, client) {
    const room = getRoomByAccount(accountId);
    if (!room) return false;
    const member = room.members.get(accountId);
    if (!member) return false;
    member.client = client || null;
    member.disconnectedAt = client ? null : Date.now();
    return true;
}

function listRooms() {
    return Array.from(rooms.values());
}

function sendAll(roomId, build) {
    const room = rooms.get(roomId);
    if (!room) return;
    for (const member of room.members.values()) {
        if (!member.client) continue;
        const msg = build(member.client);
        if (msg) member.client.send(msg);
    }
}

function sendOthers(roomId, exceptAccountId, build) {
    const room = rooms.get(roomId);
    if (!room) return;
    for (const member of room.members.values()) {
        if (member.accountId === exceptAccountId) continue;
        if (!member.client) continue;
        const msg = build(member.client);
        if (msg) member.client.send(msg);
    }
}

module.exports = { allocateRoomId, createRoom, getRoomByAccount, getRoom, isPvpRoom, setHost, updateRoomMapSelection, addMember, removeMember, setMemberClient, listRooms, sendAll, sendOthers, registerLobbyClientSource, getLobbyClients };
