const SN_ROOM_DEFAULT = 0x00220203;
const SN_ROOM_BOUNDARY = 0x00220213;
const SN_ROOM_STATE = 0x00220214;
const SN_ROOM_OPTION = 0x00220217;
const SN_ROOM_NAME = 0x0022021A;

function sendRoomStatePackets(client, ctx, getExactMessageBuffer) {
    const {
        roomIndex,
        accountIndex,
        roomType,
        mapId,
        maxPlayers,
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
    } = ctx;

    {
        const bodySize = 0x021A;
        const [msg, respBody] = getExactMessageBuffer(SN_ROOM_DEFAULT, bodySize);
        const roomLinkIndex = client.campaignRoom_ ? accountIndex : roomIndex;
        respBody.writeUint16LE(accountIndex, 0x00);
        respBody.writeUint16LE(roomLinkIndex, 0x02);
        respBody.writeUint8(roomType, 0x04);
        respBody.writeUint16LE(mapIndex & 0xFFFF, 0x05);
        respBody.writeUint8(maxPlayers, 0x07);
        respBody.writeUint8(gameMode, 0x08);
        respBody.writeUint8(3, 0x09);
        respBody.writeUint8(0, 0x0A);
        respBody.writeUint8(0, 0x0B);
        respBody.writeUint8(0, 0x0C);
        respBody.writeUint8(0, 0x0D);
        respBody.writeUint8(0, 0x0E);
        respBody.writeUint16LE(client.createWord1_ || 0, 0x10);
        respBody.writeUint16LE(client.createWord2_ || 0, 0x12);
        respBody.writeUint8(0, 0x1B);
        respBody.writeUint8(roomSettingGoal, 0x1C);
        respBody.writeUint8(roomSettingTime, 0x1D);
        respBody.writeUint8(roomSettingRound, 0x1E);
        respBody.writeUint8(roomDefaultEntryCount, 0x1F);

        for (let i = 0; i < roomDefaultEntryCount; i++) {
            const entryOffset = 0x20 + (i * 9);
            const cacheIndex = (i === 0)
                ? primaryBodyCacheIndex
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
        console.log(`[ZRoomDispatch] >> Sent SN_ROOM_DEFAULT (${bodySize} bytes, account=${accountIndex}, room=${roomIndex}, link=${roomLinkIndex}, type=${roomType}, mapIndex=${mapIndex}, map=${mapId}, opt1=0x${(client.createWord1_ || 0).toString(16)}, opt2=0x${(client.createWord2_ || 0).toString(16)}, max=${maxPlayers}, mode=${gameMode}, goal=${roomSettingGoal}, time=${roomSettingTime}, round=${roomSettingRound}, entryCount=${roomDefaultEntryCount}, bodyCache=${primaryBodyCacheIndex})`);
    }

    {
        const [msg, respBody] = getExactMessageBuffer(SN_ROOM_NAME, 0x32);
        respBody.write(roomName + '\0', 0x00, 'utf16le');
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent SN_ROOM_NAME 0x22021A ("${roomName}")`);
    }

    {
        const [msg, respBody] = getExactMessageBuffer(SN_ROOM_BOUNDARY, 0x02);
        respBody.writeUint8(maxPlayers, 0x00);
        respBody.writeUint8(currentUsers, 0x01);
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent SN_ROOM_BOUNDARY 0x220213 (max=${maxPlayers}, current=${currentUsers})`);
    }

    {
        const [msg, respBody] = getExactMessageBuffer(SN_ROOM_OPTION, 0x04);
        const optionMask = (client.createWord2_ || 0) >>> 0;
        // Static analysis:
        // body+0x10 -> bit 0x01
        // body+0x11 -> bit 0x02
        // body+0x12 -> bit 0x04
        // body+0x13 -> bit 0x20
        respBody.writeUint8(optionMask & 0x01 ? 1 : 0, 0x00);
        respBody.writeUint8(optionMask & 0x02 ? 1 : 0, 0x01);
        respBody.writeUint8(optionMask & 0x04 ? 1 : 0, 0x02);
        respBody.writeUint8(optionMask & 0x20 ? 1 : 0, 0x03);
        client.send(msg);
        console.log(
            `[ZRoomDispatch] >> Sent SN_ROOM_OPTION 0x220217 ` +
            `(flags=${respBody.readUint8(0x00)},${respBody.readUint8(0x01)},${respBody.readUint8(0x02)},${respBody.readUint8(0x03)} mask=0x${optionMask.toString(16)})`
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

module.exports = {
    sendRoomStatePackets,
};
