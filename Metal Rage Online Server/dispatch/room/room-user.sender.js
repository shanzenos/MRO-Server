const SN_USER_DEFAULT = 0x00220233;
const SN_USER_STATE = 0x00220401;
const SN_USER_MASTER = 0x00220319;
const SN_USER_NAME = 0x00220421;
const SN_USER_PILOT = 0x00220402;
const { writeAnsiStringField } = require('./room-string');
const rooms = require('../../rooms.js');
const ROOM_SELF_RECORD_RESEND_DELAY_MS = 1500;

function sendRoomUserPackets(client, ctx, getExactMessageBuffer, options = {}) {

    const includeMaster = options.includeMaster !== false;
    const {
        accountIndex,
        pilotId,
        userLevelText,
        userLevelType,
        teamIndex,
        userHiddenRaw,
        userStateRaw,
        readyStateRaw = userStateRaw,
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
        respBody.writeUint32LE(userHiddenRaw >>> 0, 0x0A);
        respBody.writeUint8(userLevelType, 0x0E);
        respBody.writeUint32LE(userStateRaw, 0x0F);
        respBody.writeUint16LE(teamIndex, 0x13);
        respBody.writeUint32LE(0, 0x15);
        respBody.writeUint32LE(packedIp, 0x19);
        {
            writeAnsiStringField(respBody, nickname, 0x1D, 0x19);
        }
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent SN_USER_DEFAULT 0x220233 (54 bytes, count=1, userIndex=${accountIndex}, pilot=${pilotId}, nickname="${nickname}", team=${teamIndex}, hiddenRaw=${userHiddenRaw}, stateRaw=${userStateRaw}, levelType=${userLevelType}, roomStateRaw=${userStateRaw})`);
    }

    {
        const [msg, respBody] = getExactMessageBuffer(SN_USER_NAME, 0x4E);
        respBody.writeUint16LE(accountIndex, 0x00);
        writeAnsiStringField(respBody, nickname, 0x1B, 0x4E - 0x1B);
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
        respBody.writeUint32LE(readyStateRaw, 0x04);
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent SN_USER_STATE 0x220401 (count=1, userIndex=${accountIndex}, state=${readyStateRaw})`);
    }

    if (includeMaster) {
        const [msg, respBody] = getExactMessageBuffer(SN_USER_MASTER, 0x06);
        respBody.writeUint16LE(accountIndex, 0x00);
        respBody.writeUint32LE(userStateRaw, 0x02);
        client.send(msg);
        client.roomMasterSent_ = true;
        console.log(`[ZRoomDispatch] >> Sent SN_USER_MASTER 0x220319 (userIndex=${accountIndex}, state=${userStateRaw})`);
    }
}

function buildMemberUserCtx(member) {
    return {
        accountIndex: member.accountId,
        pilotId: Number(member.client && member.client.pilot_) || 101,
        userLevelText: '1',
        userLevelType: 2,
        teamIndex: member.team || 0,
        userHiddenRaw: 0,
        userStateRaw: 1,

        readyStateRaw: member.ready ? 2 : 1,
        packedIp: 0x0100007F,
        nickname: member.nickname || 'Player',
    };
}

module.exports = { sendRoomUserPackets, buildMemberUserCtx };
