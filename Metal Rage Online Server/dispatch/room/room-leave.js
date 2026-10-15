'use strict';

const rooms = require('../../rooms.js');
const { sendRoomUserPackets, buildMemberUserCtx } = require('./room-user.sender');
const { broadcastRoomListChange, sendFullRoomList } = require('./room-list.sender');

function getExactMessageBuffer(type, bodySize) {
    const msg = Buffer.alloc(0x10 + bodySize);
    msg.writeUint16BE(msg.length, 0x6);
    msg.writeUint32BE(type, 0xC);
    return [msg, msg.subarray(0x10)];
}

function leaveRoomAndNotify(accountId, { kickout = false } = {}) {
    const room = rooms.getRoomByAccount(accountId);
    if (!room) return;

    const leaverMember = room.members.get(accountId);
    const leaverClient = leaverMember ? leaverMember.client : null;
    const wasHost = room.hostAccountId === accountId;
    const wasPlaying = room.state === 'playing';
    const remainingMembers = Array.from(room.members.values()).filter((m) => m.accountId !== accountId);

    if (wasPlaying) {
        room.state = 'lobby';
        room.battleStartGen = (room.battleStartGen || 0) + 1;
        for (const member of room.members.values()) {
            member.ready = false;
            if (member.client) member.client.gameStarted_ = false;
        }
        if (leaverClient) leaverClient.gameStarted_ = false;
    }

    rooms.removeMember(accountId);

    if (remainingMembers.length > 0) {

        for (const member of remainingMembers) {
            if (!member.client) continue;
            const [leaveMsg, leaveBody] = getExactMessageBuffer(0x00220236, 0x03);
            leaveBody.writeUInt16LE(accountId, 0x00);
            leaveBody.writeUInt8(kickout ? 1 : 0, 0x02);
            member.client.send(leaveMsg);
        }
        if (wasPlaying) {
            for (const member of remainingMembers) {
                if (!member.client) continue;
                const [stateMsg, stateBody] = getExactMessageBuffer(0x00220401, 0x08);
                stateBody.writeUInt8(0, 0x00);
                stateBody.writeUInt8(1, 0x01);
                stateBody.writeUInt16LE(member.accountId, 0x02);
                stateBody.writeUInt32LE(1, 0x04);
                member.client.send(stateMsg);
            }
        }
        console.log(`[room-leave] >> Sent Leave_SN 0x220236 to ${remainingMembers.length} remaining room member(s) (left=${accountId}, kickout=${kickout})`);

        if (wasHost) {

            const newHost = remainingMembers[0];
            rooms.setHost(room.id, newHost.accountId);
            console.log(`[room-leave] >> Host left room #${room.id}; reassigned to account ${newHost.accountId}`);
            for (const member of remainingMembers) {
                if (!member.client) continue;
                sendRoomUserPackets(member.client, buildMemberUserCtx(newHost), getExactMessageBuffer);
            }
        }
    }

    {
        const updateType = remainingMembers.length > 0 ? 2 : 3;
        broadcastRoomListChange(rooms.getLobbyClients(), room, updateType, getExactMessageBuffer);

        if (leaverClient) sendFullRoomList(leaverClient, rooms.listRooms(), getExactMessageBuffer);
    }
}

module.exports = { leaveRoomAndNotify };
