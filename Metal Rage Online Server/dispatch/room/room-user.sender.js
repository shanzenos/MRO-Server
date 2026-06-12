const SN_USER_DEFAULT = 0x00220233;
const SN_USER_STATE = 0x00220401;
const SN_USER_MASTER = 0x00220319;
const SN_USER_NAME = 0x00220421;
const SN_USER_PILOT = 0x00220402;

function sendRoomUserPackets(client, ctx, getExactMessageBuffer) {
    const {
        accountIndex,
        pilotId,
        userLevelText,
        userLevelType,
        teamIndex,
        userHiddenRaw,
        userStateRaw,
        packedIp,
        nickname,
    } = ctx;

    {
        const [msg, respBody] = getExactMessageBuffer(SN_USER_DEFAULT, 0x36);
        respBody.writeUint8(0, 0x00);
        respBody.writeUint8(1, 0x01);
        respBody.writeUint16LE(accountIndex, 0x02);
        respBody.writeUint32LE(pilotId, 0x04);
        respBody.write(userLevelText + '\0', 0x08, 'ascii');
        respBody.writeUint32LE(userHiddenRaw >>> 0, 0x0E);
        respBody.writeUint8(userLevelType, 0x12);
        respBody.writeUint16LE(teamIndex, 0x13);
        respBody.writeUint32LE(userStateRaw, 0x15);
        respBody.writeUint32LE(packedIp, 0x19);
        respBody.write(nickname + '\0', 0x1D, 'ascii');
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent SN_USER_DEFAULT 0x220233 (54 bytes, count=1, userIndex=${accountIndex}, pilot=${pilotId}, nickname="${nickname}", team=${teamIndex}, hiddenRaw=${userHiddenRaw}, stateRaw=${userStateRaw}, levelType=${userLevelType}, roomStateRaw=${userStateRaw})`);
    }

    {
        const [msg, respBody] = getExactMessageBuffer(SN_USER_NAME, 0x4E);
        respBody.writeUint16LE(accountIndex, 0x00);
        respBody.write(nickname + '\0', 0x1B, 'utf16le');
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent SN_USER_NAME 0x220421 ("${nickname}")`);
    }

    {
        const [msg, respBody] = getExactMessageBuffer(SN_USER_PILOT, 0x06);
        respBody.writeUint16LE(accountIndex, 0x00);
        respBody.writeUint32LE(pilotId, 0x02);
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent SN_USER_PILOT 0x220402 (pilot=${pilotId})`);
    }

    {
        const [msg, respBody] = getExactMessageBuffer(SN_USER_STATE, 0x08);
        respBody.writeUint8(0, 0x00);
        respBody.writeUint8(1, 0x01);
        respBody.writeUint16LE(accountIndex, 0x02);
        respBody.writeUint32LE(userStateRaw, 0x04);
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent SN_USER_STATE 0x220401 (count=1, userIndex=${accountIndex}, state=${userStateRaw})`);
    }

    if (!client.roomMasterSent_) {
        const [msg, respBody] = getExactMessageBuffer(SN_USER_MASTER, 0x06);
        respBody.writeUint16LE(accountIndex, 0x00);
        respBody.writeUint32LE(userStateRaw, 0x02);
        client.send(msg);
        client.roomMasterSent_ = true;
        console.log(`[ZRoomDispatch] >> Sent SN_USER_MASTER 0x220319 (userIndex=${accountIndex}, state=${userStateRaw})`);
    } else {
        console.log(`[ZRoomDispatch] >> Skipped SN_USER_MASTER 0x220319 (already sent)`);
    }
}

module.exports = {
    sendRoomUserPackets,
};
