const SN_ROOM_DEFAULT = 0x00220203;
const SN_ROOM_BOUNDARY = 0x00220213;
const SN_ROOM_STATE = 0x00220214;
const SN_ROOM_OPTION = 0x00220217;
const SN_ROOM_NAME = 0x0022021A;
const { writeAnsiStringField, decodeBig5ForLog } = require('./room-string');
const rooms = require('../../rooms.js');
const ROOM_RED_TEAM_INDEX = 0;
const ROOM_BLUE_TEAM_INDEX = 1;
const MAP_ID_DEFAULT_PVE = 9001;
const MAP_ID_PVE_MIN = 9001;
const MAP_ID_PVE_MAX = 9012;

function resolveRoomDefaultMapEntry(client, fallback) {
    return fallback;

}

const PVE_MAXUSER_WIRE_VALUE = 16;

function resolveRoomOptionBitsFromRoomSource(roomOptions) {
    if (!roomOptions) return null;
    return {
        password: roomOptions.password ? 1 : 0,
        balance: roomOptions.balance ? 1 : 0,
        intrude: roomOptions.intrude ? 1 : 0,
        training: roomOptions.training ? 1 : 0,
    };

}

function sendRoomOptionOnly(client, roomOptions, getExactMessageBuffer) {
    const [msg, respBody] = getExactMessageBuffer(SN_ROOM_OPTION, 0x04);
    const bits = resolveRoomOptionBitsFromRoomSource(roomOptions) ||
        { password: 0, balance: 0, intrude: 0, training: 0 };
    respBody.writeUint8(bits.password, 0x00);
    respBody.writeUint8(bits.balance, 0x01);
    respBody.writeUint8(bits.intrude, 0x02);
    respBody.writeUint8(bits.training, 0x03);
    client.send(msg);
    console.log(
        `[ZRoomDispatch] >> Sent SN_ROOM_OPTION 0x220217 [option-change broadcast] ` +
        `(flags=${bits.password},${bits.balance},${bits.intrude},${bits.training})`
    );
}

function resolveBoundaryMaxUser(maxPlayers, isCampaignRoom) {
    if (isCampaignRoom) {
        return PVE_MAXUSER_WIRE_VALUE;
    }
    return maxPlayers;
}

function sendRoomNameOnly(client, roomName, getExactMessageBuffer) {
    const [msg, respBody] = getExactMessageBuffer(SN_ROOM_NAME, 0x32);
    {
        writeAnsiStringField(respBody, roomName, 0x00, 0x32);
    }
    client.send(msg);

    const big5Readable = decodeBig5ForLog(roomName);
    console.log(`[ZRoomDispatch] >> Sent SN_ROOM_NAME 0x22021A ("${roomName}"${big5Readable ? ` big5="${big5Readable}"` : ''})`);
}

function sendRoomStatePackets(client, ctx, getExactMessageBuffer) {
    const {
        roomIndex,
        accountIndex,
        roomType,
        mapId,
        maxPlayers,
        maxPlayersWire = maxPlayers,
        currentUsers,
        gameMode,
        mapIndex,
        roomName,
        selectedMech,
        primaryBodyCacheIndex,
        roomSettingGoal,
        roomSettingTime,
        roomSettingRound,
        roomDefaultEntryCount,
        roomDefaultEntryHints,
        optionMask: ctxOptionMask,
        roomOptions,
        isCampaignRoom,
    } = ctx;

    const roomSourceOptionBits = resolveRoomOptionBitsFromRoomSource(roomOptions);

    {
        const bodySize = 0x021A;
        const [msg, respBody] = getExactMessageBuffer(SN_ROOM_DEFAULT, bodySize);
        const roomLinkIndex = isCampaignRoom ? accountIndex : roomIndex;
        respBody.writeUint16LE(accountIndex, 0x00);
        respBody.writeUint16LE(roomLinkIndex, 0x02);
        respBody.writeUint8(roomType, 0x04);
        respBody.writeUint16LE(mapIndex & 0xFFFF, 0x05);
        respBody.writeUint8(maxPlayersWire, 0x07);
        respBody.writeUint8(gameMode, 0x08);
        respBody.writeUint8(3, 0x09);
        respBody.writeUint8(0, 0x0A);
        const defaultEntryOptionBits = roomSourceOptionBits ||
            { password: 0, balance: 0, intrude: 0, training: 0 };
        respBody.writeUint8(defaultEntryOptionBits.password, 0x0B);
        respBody.writeUint8(defaultEntryOptionBits.balance, 0x0C);
        respBody.writeUint8(defaultEntryOptionBits.intrude, 0x0D);
        respBody.writeUint8(defaultEntryOptionBits.training, 0x0E);
        const redTeamIndex = ROOM_RED_TEAM_INDEX;
        const blueTeamIndex = ROOM_BLUE_TEAM_INDEX;
        respBody.writeUint16LE(redTeamIndex, 0x10);
        respBody.writeUint16LE(blueTeamIndex, 0x12);
        respBody.writeUint8(0, 0x1B);
        respBody.writeUint8(roomSettingGoal, 0x1C);
        respBody.writeUint8(roomSettingTime, 0x1D);
        respBody.writeUint8(roomSettingRound, 0x1E);
        respBody.writeUint8(roomDefaultEntryCount, 0x1F);
        const firstEntryMapIndex = resolveRoomDefaultMapEntry(client, primaryBodyCacheIndex);

        for (let i = 0; i < roomDefaultEntryCount; i++) {
            const entryOffset = 0x20 + (i * 9);
            const cacheIndex = (i === 0)
                ? firstEntryMapIndex
                : roomDefaultEntryHints[i];
            respBody.writeUint16LE(cacheIndex, entryOffset + 0x00);
            respBody.writeUint16LE(0, entryOffset + 0x02);
            respBody.writeUint8(1, entryOffset + 0x04);
            respBody.writeUint16LE(selectedMech + i, entryOffset + 0x05);
            respBody.writeUint16LE(0, entryOffset + 0x07);
        }

        // Write slot-count AFTER the entry loop so it is not overwritten.
        // body+0x2F feeds FROOM_INFO slot-count state in the client.
        respBody.writeUint8(roomDefaultEntryCount, 0x2F);

        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent SN_ROOM_DEFAULT (${bodySize} bytes, account=${accountIndex}, room=${roomIndex}, link=${roomLinkIndex}, type=${roomType}, mapIndex=${mapIndex}, map=${mapId}, opt2=0x${((ctxOptionMask || 0) >>> 0).toString(16)}, redTeam=${redTeamIndex}, blueTeam=${blueTeamIndex}, max=${maxPlayers}, size=${maxPlayersWire}, mode=${gameMode}, goal=${roomSettingGoal}, time=${roomSettingTime}, round=${roomSettingRound}, entryCount=${roomDefaultEntryCount}, bodyCache=${primaryBodyCacheIndex})`);
    }

    sendRoomNameOnly(client, roomName, getExactMessageBuffer);

    {
        const [msg, respBody] = getExactMessageBuffer(SN_ROOM_BOUNDARY, 0x02);
        const boundaryMaxUser = resolveBoundaryMaxUser(maxPlayers, isCampaignRoom);
        respBody.writeUint8(currentUsers, 0x00);
        respBody.writeUint8(boundaryMaxUser, 0x01);
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent SN_ROOM_BOUNDARY 0x220213 (current=${currentUsers}, max=${boundaryMaxUser})`);
    }

    {
        const [msg, respBody] = getExactMessageBuffer(SN_ROOM_OPTION, 0x04);
        const optionSnBits = roomSourceOptionBits ||
            { password: 0, balance: 0, intrude: 0, training: 0 };
        respBody.writeUint8(optionSnBits.password, 0x00);
        respBody.writeUint8(optionSnBits.balance, 0x01);
        respBody.writeUint8(optionSnBits.intrude, 0x02);
        respBody.writeUint8(optionSnBits.training, 0x03);
        client.send(msg);
        console.log(
            `[ZRoomDispatch] >> Sent SN_ROOM_OPTION 0x220217 ` +
            `(flags=${respBody.readUint8(0x00)},${respBody.readUint8(0x01)},${respBody.readUint8(0x02)},${respBody.readUint8(0x03)} mask=0x${((ctxOptionMask || 0) >>> 0).toString(16)})`
        );
    }

    {
        const [msg, respBody] = getExactMessageBuffer(SN_ROOM_STATE, 0x02);
        respBody.writeUint8(3, 0x00);
        respBody.writeUint8(0, 0x01);
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent SN_ROOM_STATE 0x220214 (2 bytes)`);
    }
}

module.exports = { sendRoomStatePackets, sendRoomNameOnly, sendRoomOptionOnly };
