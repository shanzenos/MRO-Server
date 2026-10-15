'use strict';

const SN_ROOM_LIST = 0x00220204;

const MAX_FRAME_BYTES = 0x400;
const FRAME_HEADER_BYTES = 0x10;
const LIST_HEADER_BYTES = 0x02;
const SAFETY_MARGIN_BYTES = 0x20;
const MAX_ENTRIES_BYTES = MAX_FRAME_BYTES - FRAME_HEADER_BYTES - LIST_HEADER_BYTES - SAFETY_MARGIN_BYTES;

const { toRoomNameWireBytes } = require('./room-string');

const FIELD_BIT = {
    ROOM_TYPE: 1 << 0,
    MATCH_FLAGS: 1 << 1,
    USER_COUNT: 1 << 2,
    ROOM_FLAGS: 1 << 3,
    MAP: 1 << 5,
    NAME_INDEX: 1 << 8,
    NAME: 1 << 9,
};

const FULL_FIELD_MASK = FIELD_BIT.ROOM_TYPE | FIELD_BIT.MATCH_FLAGS | FIELD_BIT.USER_COUNT |
    FIELD_BIT.ROOM_FLAGS | FIELD_BIT.MAP | FIELD_BIT.NAME_INDEX | FIELD_BIT.NAME;

const ROOM_TYPE_NORM_TO_RAW = { 0: 0, 1: 3, 2: 1, 3: 5, 4: 6 };

function buildRoomListEntry(room, updateType) {
    if (updateType === 3) {
        const buf = Buffer.alloc(0x03);
        buf.writeUInt16LE(room.id & 0xFFFF, 0x00);
        buf.writeUInt8(3, 0x02);
        return buf;
    }

    const { text: name, encoding: nameEncoding } = toRoomNameWireBytes(room.name, 0xFF);
    const headerSize = 0x02 + 0x01 + (updateType === 1 ? 0x02 : 0) + 0x02;
    const fieldsSize = 0x01  + 0x02  + 0x02
        + 0x01  + 0x06  + 0x02  + (0x01 + name.length) ;
    const buf = Buffer.alloc(headerSize + fieldsSize);

    let off = 0;
    buf.writeUInt16LE(room.id & 0xFFFF, off); off += 2;
    buf.writeUInt8(updateType, off); off += 1;
    if (updateType === 1) {
        buf.writeUInt16LE(room.id & 0xFFFF, off); off += 2;
    }
    buf.writeUInt16LE(FULL_FIELD_MASK, off); off += 2;

    const rawRoomType = !room.isTrueCampaign && Number(room.rawRoomType) === 2
        ? 2
        : (ROOM_TYPE_NORM_TO_RAW[room.roomType] ?? 0);
    buf.writeUInt8(rawRoomType & 0xFF, off); off += 1;
    buf.writeUInt8(room.state === 'playing' ? 1 : 0, off); off += 1;
    buf.writeUInt8(0, off); off += 1;

    buf.writeUInt8(Math.min(room.members.size, 0xFF), off); off += 1;
    buf.writeUInt8(Math.min(room.maxPlayers, 0xFF), off); off += 1;
    buf.writeUInt8(room.hasPassword ? 0x01 : 0x00, off); off += 1;

    buf.writeUInt16LE(0, off); off += 2;
    buf.writeUInt16LE(0, off); off += 2;
    buf.writeUInt16LE(room.mapId & 0xFFFF, off); off += 2;
    buf.writeUInt16LE(room.id & 0xFFFF, off); off += 2;
    buf.writeUInt8(name.length, off); off += 1;
    buf.write(name, off, name.length, nameEncoding); off += name.length;

    return buf;
}

function sendRoomListEntries(client, entries, getExactMessageBuffer) {
    const chunks = [[]];
    let currentSize = 0;
    for (const entry of entries) {
        const last = chunks[chunks.length - 1];
        if (last.length >= 0xFF || (currentSize + entry.length) > MAX_ENTRIES_BYTES) {
            chunks.push([]);
            currentSize = 0;
        }
        chunks[chunks.length - 1].push(entry);
        currentSize += entry.length;
    }

    chunks.forEach((chunkEntries, index) => {
        const isLast = index === chunks.length - 1;
        const bodySize = LIST_HEADER_BYTES + chunkEntries.reduce((sum, e) => sum + e.length, 0);
        const [msg, body] = getExactMessageBuffer(SN_ROOM_LIST, bodySize);
        body.writeUInt8(isLast ? 0 : 1, 0x00);
        body.writeUInt8(chunkEntries.length, 0x01);
        let off = LIST_HEADER_BYTES;
        for (const entry of chunkEntries) {
            entry.copy(body, off);
            off += entry.length;
        }
        client.send(msg);
    });
}

function sendFullRoomList(client, roomList, getExactMessageBuffer) {
    const entries = roomList.map((room) => buildRoomListEntry(room, 1));
    sendRoomListEntries(client, entries, getExactMessageBuffer);
}

function broadcastRoomListChange(lobbyClients, room, updateType, getExactMessageBuffer) {
    const entry = buildRoomListEntry(room, updateType);
    for (const client of lobbyClients) {
        sendRoomListEntries(client, [entry], getExactMessageBuffer);
    }
}

module.exports = {
    SN_ROOM_LIST,
    buildRoomListEntry,
    sendRoomListEntries,
    sendFullRoomList,
    broadcastRoomListChange,
};
