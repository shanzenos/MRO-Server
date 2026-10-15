const NetworkClient = require("../client");

const { sendGameUserBootstrap } = require('./room/room-game-user.sender');

const rooms = require('../rooms.js');

const { sendRoomStatePackets, sendRoomNameOnly, sendRoomOptionOnly } = require('./room/room-state.sender');

const { sendRoomMapPackets } = require('./room/room-map.sender');
const { sendRoomUserPackets, buildMemberUserCtx } = require('./room/room-user.sender');
const { broadcastRoomListChange } = require('./room/room-list.sender');

const { decodeAnsiBytes, decodeBig5ForLog, writeAnsiStringField } = require('./room/room-string');

const { leaveRoomAndNotify } = require('./room/room-leave');

const whitelist = require('../config/whitelist.js');

const { MAP_IDS_PVP } = require('./map-info.sender');

// ZGateGameDispatch - Handles Gate-range (0x22XXXX) messages on the GAME server
//
// Key messages:
//   0x00220201 (CQ_CREATE)  - Room creation from lobby
//   0x00220121              - Player name/presence lookup
//   0x00220141              - Gate social request
//   0x00221221              - Hardware/config report (CN - no response needed)
// Room creation uses Lobby Create_SA; ZDispatchRoom 0x22XXXX room state follows after scene change.
//
// via room messages so the client can populate the room UI.

const CQ_CREATE = 0x00220201;
const SA_LOBBY_CREATE = 0x00220202;

const CQ_ROOM_NAME_CHANGE = 0x00220218;
const SA_ROOM_NAME_CHANGE = 0x00220219;

const ROOM_DEFAULT_ENTRY_HINTS = [8, 37, 30, 34, 6, 2];

function computeCampaignMapAllHints() {
    return [9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009, 9010, 9011, 9012];
}

const MAP_ID_DEFAULT_CAMPAIGN = 9001;

const MAP_ID_DEFAULT_PVP = 1011;

const ROOM_STATE_RETRY_SCHEDULE = [
    [350, 'delayed'],
    [1200, 'retry after scene change'],
];

const MAP_CHANGE_ONE_SA_EXPERIMENT = {
    mode: 'manual',  // SA에 현재 선택된 맵 캐시키를 반환 (returns the currently selected map cache key in the SA)
    manual: {
        b0: 0,
        w1: 'current_cache',  // CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID[mapId]로 resolve됨 (resolved via CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID[mapId])
        w2: 0,
        b5: 0,
        w6: 0,
        w8: 0,
    },
};
// Cache.Bin에서 추출한 맵 인덱스 매핑 (map index mapping extracted from Cache.Bin)
// map_id(DB) → cacheIndex(Cache.Bin)
const CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID = {
    0: 1,   // Map_Ptuto  (튜토리얼 / tutorial)
    1: 8,   // Map_C01
    2: 34,  // Map_C02
    3: 83,  // Map_C03
    4: 32,  // Map_C04
    5: 58, // Map_PC01 (캠페인 기본 - Map_C05는 클라이언트에 없음) (campaign default - Map_C05 does not exist in the client)
    6: 6,   // Map_C06
    7: 2,   // Map_C08
    8: 26,  // Map_C09
    9: 36,  // Map_C18
    10: 43, // Map_C19
    11: 16, // Map_C20
    12: 24, // Map_C21
    13: 45, // Map_C22
    14: 47, // Map_C25
    15: 49, // Map_C30
    16: 14, // Map_N01
    17: 10, // Map_N05
    18: 22, // Map_N07
    19: 52, // Map_N11
    20: 30, // Map_N13
    21: 18, // Map_N17
    22: 58, // Map_PC01
    23: 70, // Map_PC02
    24: 64, // Map_PC03
    25: 77, // Map_PC04
};

function getExactMessageBuffer(type, bodySize)
{
    const msg = Buffer.alloc(0x10 + bodySize);
    msg.writeUint16BE(msg.length, 0x6);
    msg.writeUint32BE(type, 0xC);
    return [msg, msg.subarray(0x10)];
}

function normalizeIpv4(address)
{
    const raw = String(address || '').trim();
    if (!raw) return '127.0.0.1';
    if (raw === '::1') return '127.0.0.1';
    if (raw.startsWith('::ffff:')) return raw.slice(7);
    return raw;
}

function sendOkSa(client, type, tag)
{
    const [msg, respBody] = getExactMessageBuffer(type, 0x06);
    respBody.writeUint16LE(0, 0x00);
    respBody.writeUint32LE(0, 0x02);
    client.send(msg);
    console.log(`[ZGateGameDispatch] >> Sent ${tag} 0x${type.toString(16).padStart(8, '0')} (status=0, result=0)`);
}

function sendReadyHostSq(client)
{
    const [msg, respBody] = getExactMessageBuffer(0x00420113, 0x06);
    respBody.writeUint16LE(0, 0x00);
    respBody.writeUint32LE(0, 0x02);
    client.send(msg);
    console.log(`[ZGateGameDispatch] >> Sent Ready_Host_SQ 0x00420113 (status=0, result=0)`);
}

const CACHE_INDEX_TO_MAP_NAME_GG = {
    58: 'Map_PC01', 70: 'Map_PC02', 64: 'Map_PC03', 77: 'Map_PC04',
    8: 'Map_C01', 34: 'Map_C02', 83: 'Map_C03', 32: 'Map_C04',
    6: 'Map_C06', 2: 'Map_C08', 26: 'Map_C09', 36: 'Map_C18',
    43: 'Map_C19', 16: 'Map_C20', 24: 'Map_C21',
    14: 'Map_N01', 10: 'Map_N05', 22: 'Map_N07', 30: 'Map_N13', 18: 'Map_N17',
    1: 'Map_Ptuto',
};

const MAP_ID_TO_MAP_NAME_GG = {
    9001: 'Map_PC01', 9002: 'Map_PC01', 9003: 'Map_PC01',
    9004: 'Map_PC03', 9005: 'Map_PC03', 9006: 'Map_PC03',
    9007: 'Map_PC02', 9008: 'Map_PC02', 9009: 'Map_PC02',
    9010: 'Map_PC04', 9011: 'Map_PC04', 9012: 'Map_PC04',
    1011: 'Map_C08', 1021: 'Map_C06', 1031: 'Map_C01',
    1041: 'Map_N05_de', 1051: 'Desert', 1061: 'Map_N01',
    1071: 'Map_C20', 1081: 'Map_N17',
};

function buildReadyHostSnMsg(ip, port, mapCacheKey, ipOnly = false)
{

    const mapName = MAP_ID_TO_MAP_NAME_GG[mapCacheKey]
        || CACHE_INDEX_TO_MAP_NAME_GG[mapCacheKey]
        || 'Map_PC01';
    // 실제 서버: IP:Port/MapName?team=0 형식으로 ClientTravel (real server: ClientTravel in IP:Port/MapName?team=0 format)
    // ip 필드에 "IP/MapName" 형식으로 전달 시도 (attempt to pass in "IP/MapName" format in the ip field)

    const ipWithMap = ipOnly ? ip : ip + '/' + mapName;
    const urlBytes = Buffer.byteLength(ipWithMap, 'ascii');
    const bodySize = 0x03 + urlBytes + 1;

    const [msg, respBody] = getExactMessageBuffer(0x00420115, bodySize);
    respBody.writeUInt16LE(port, 0x00);
    respBody.writeUInt8(0, 0x02);

    const roomForBytes = respBody.length - 0x03;
    const written = respBody.write(ipWithMap + '\0', 0x03, Math.min(urlBytes + 1, roomForBytes), 'ascii');

    return { msg, ipWithMap, bodySize, written, urlBytes };
}

function sendReadyHostSn(client)
{
    const ip = normalizeIpv4(client.socket_ && client.socket_.localAddress);
    const port = 30907;
    const mapCacheKey = Number(client.campaignMapCacheKey_) || 58;
    const { msg, ipWithMap, bodySize, written, urlBytes } = buildReadyHostSnMsg(ip, port, mapCacheKey);

    if (written < urlBytes + 1)
        console.log(`[ZGateGameDispatch] !! Ready_Host_SN URL TRUNCATED: wrote ${written} of ${urlBytes + 1} bytes — client will travel to a map that does not exist`);

    client.send(msg);
    console.log(`[ZGateGameDispatch] >> Sent Ready_Host_SN 0x00420115 ip=${ipWithMap} port=${port} (mode=${"fit"}, body=0x${bodySize.toString(16)})`);
}

function sendReadyHostSnToRoomMember(targetClient, ip, port, mapCacheKey)
{
    const { msg, ipWithMap, bodySize, written, urlBytes } = buildReadyHostSnMsg(ip, port, mapCacheKey, true);

    if (written < urlBytes + 1)
        console.log(`[ZGateGameDispatch] !! Ready_Host_SN URL TRUNCATED (room member): wrote ${written} of ${urlBytes + 1} bytes — client will travel to a map that does not exist`);

    targetClient.send(msg);
    console.log(`[ZGateGameDispatch] >> Sent Ready_Host_SN 0x00420115 (room member) ip=${ipWithMap} port=${port} (mode=${"fit"}, body=0x${bodySize.toString(16)})`);
}

function sendRoomGameWaitSn(client, tag)
{
    const [msg] = getExactMessageBuffer(0x00420111, 0x00);
    client.send(msg);
    console.log(`[ZGateGameDispatch] >> Sent Game_Wait_SN 0x00420111 [${tag}]`);
}
function sendGameUserSn(client, tag)
{
    const accountIndex = Number(client.accountIndex_ || client.accountId_ || 1);
    const ctx = {
        accountIndex,
        nickname: client.nickname_ || 'Player',
        userLevelText: '1',

        teamIndex: 0,
        selectedMech: Number(client.currentHangarSlot_) || 1,
        pilotId: Number(client.pilot_) || 101,
    };
    console.log(`[ZGateGameDispatch] >> Game_User_SN [${tag}]`);
    return Promise.resolve(sendGameUserBootstrap(client, ctx, getExactMessageBuffer))
        .catch(err => console.error(`[ZGateGameDispatch] >> Game_User_SN failed: ${err.message}`));
}
async function sendGameUserSnRoomBroadcast(room, tag, expectedGen)
{
    const targetAccountIds = Array.from(room.members.keys());
    const sourceAccountIdsSnapshot = Array.from(room.members.keys());

    for (const targetAccountId of targetAccountIds) {
        for (const sourceAccountId of sourceAccountIdsSnapshot) {

            const currentRoom = rooms.getRoom(room.id);
            if (!currentRoom) {
                console.log(`[ZGateGameDispatch] >> Game_User_SN room broadcast aborted: room #${room.id} no longer tracked [${tag}]`);
                return;
            }
            if (expectedGen !== undefined && currentRoom.battleStartGen !== expectedGen) {
                console.log(`[ZGateGameDispatch] >> Game_User_SN room broadcast aborted: room #${room.id}'s battleStartGen changed (${expectedGen} -> ${currentRoom.battleStartGen}) mid-batch [${tag}]`);
                return;
            }
            const currentTarget = currentRoom.members.get(targetAccountId);
            if (!currentTarget || !currentTarget.client) {

                break;
            }
            const currentSource = currentRoom.members.get(sourceAccountId);
            if (!currentSource) continue;

            const sourceClient = currentSource.client;

            const teamIndex = Number(currentSource.team) === 1 ? 1 : 0;
            const ctx = {
                accountIndex: Number(currentSource.accountId),
                nickname: currentSource.nickname || 'Player',
                teamIndex,
                userLevelText: '1',
                selectedMech: Number(sourceClient && sourceClient.currentHangarSlot_) || 1,
                pilotId: Number(sourceClient && sourceClient.pilot_) || 101,
            };
            console.log(`[ZGateGameDispatch] >> Game_User_SN [room #${currentRoom.id} broadcast, target=${currentTarget.accountId}, source=${currentSource.accountId}, ${tag}]`);
            try {

                await sendGameUserBootstrap(currentTarget.client, ctx, getExactMessageBuffer, {
                    sendTo: currentTarget.client,
                    itemsAccountId: currentSource.accountId,
                });
            } catch (err) {
                console.error(`[ZGateGameDispatch] >> Game_User_SN (room broadcast) failed: ${err.message}`);
            }
        }
    }
}

function getGameInfoRound(client)
{
    return Number(client.playRound_) || 0;
}

function sendGameInfoSn(client, tag)
{
    const BODY_SIZE = 0x1A;
    const [msg, body] = getExactMessageBuffer(0x00222111, BODY_SIZE);

    const mapId = Number(client.campaignMapCacheKey_ || CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID[client.mapId_] || client.mapId_ || 58) & 0xFFFF;  // Cache.Bin 인덱스로 전송 (sent as Cache.Bin index)
    const userIndex = Number(client.accountIndex_ || client.accountId_ || 1) & 0xFFFF;
    const battleIndex = 1;

    const redTeamIndex = 0;
    const blueTeamIndex = 1;
    const clanFlag = 0;
    let timeLimitMinutes = 10;
    let timeLimitSource = 'hardcoded';
    {
        if (client.mapChangeOneTime_) {
            timeLimitMinutes = client.mapChangeOneTime_;
            timeLimitSource = 'mapChangeOne';
        } else if (client.createPlayTime_) {
            timeLimitMinutes = client.createPlayTime_;
            timeLimitSource = 'create';
        }
    }
    const goalScore = 0;

    body.writeUInt32LE(battleIndex, 0x00);
    body.writeUInt16LE(redTeamIndex, 0x04);
    body.writeUInt16LE(blueTeamIndex, 0x06);
    body.writeUInt16LE(0, 0x0A);
    body.writeUInt16LE(0, 0x0C);
    body.writeUInt8(clanFlag, 0x0E);
    body.writeUInt16LE(2, 0x0F);
    body.writeUInt16LE(mapId, 0x11);
    body.writeUInt16LE(timeLimitMinutes, 0x13);

    const playRound = getGameInfoRound(client);
    body.writeUInt8(playRound & 0xFF, 0x15);
    body.writeUInt16LE(goalScore, 0x16);
    body.writeUInt16LE(goalScore, 0x18);

    client.send(msg);
    console.log(
        `[ZGateGameDispatch] >> Sent Game_Info_SN 0x00222111 [${tag}] ` +
        `(battle=${battleIndex}, red=${redTeamIndex}, blue=${blueTeamIndex}, map=${mapId}, ` +
        `clan=${clanFlag}, user=${userIndex}, timeLimit=${timeLimitMinutes} (${timeLimitSource}), round=${playRound}, goal=${goalScore}, ` +
        `body=${body.toString('hex')})`
    );
}

function sendRoomGameWaitSnBroadcast(room, tag)
{
    rooms.sendAll(room.id, () => {
        const [msg] = getExactMessageBuffer(0x00420111, 0x00);
        return msg;
    });
    console.log(`[ZGateGameDispatch] >> Broadcast Game_Wait_SN 0x00420111 to room #${room.id} (${room.members.size} member(s)) [${tag}]`);
}

function sendAckBroadcast(room, type, tag)
{
    rooms.sendAll(room.id, () => {
        const [msg, respBody] = getExactMessageBuffer(type, 0x06);
        respBody.writeUint16LE(0, 0x00);
        respBody.writeUint32LE(0, 0x02);
        return msg;
    });
    console.log(`[ZGateGameDispatch] >> Broadcast 0x${type.toString(16).padStart(8, '0')} to room #${room.id} (${room.members.size} member(s), status=0, result=0) [${tag}]`);
}

function sendGameInfoSnToClient(room, client, tag)
{
    const BODY_SIZE = 0x1A;
    const [msg, body] = getExactMessageBuffer(0x00222111, BODY_SIZE);
    body.writeUInt32LE(1, 0x00);
    body.writeUInt16LE(0, 0x04);
    body.writeUInt16LE(1, 0x06);
    body.writeUInt16LE(0, 0x0A);
    body.writeUInt16LE(0, 0x0C);
    body.writeUInt8(0, 0x0E);
    body.writeUInt16LE(Math.min(Math.max(Number(room.members.size) || 1, 1), Number(room.maxPlayers) || 8), 0x0F);
    body.writeUInt16LE(Number(room.mapId || MAP_ID_DEFAULT_CAMPAIGN) & 0xFFFF, 0x11);
    body.writeUInt16LE(Number(room.playTime) || 10, 0x13);
    body.writeUInt8((Number(room.playRound) || 0) & 0xFF, 0x15);
    body.writeUInt16LE(0, 0x16);
    body.writeUInt16LE(0, 0x18);
    client.send(msg);
    console.log(`[ZGateGameDispatch] >> Sent Game_Info_SN 0x00222111 to account=${client.accountIndex_ || client.accountId_} [${tag}]`);
}

async function sendGameUsersToClient(room, targetMember, tag)
{
    for (const sourceMember of room.members.values()) {
        if (!targetMember.client) return;
        const sourceClient = sourceMember.client;
        const ctx = {
            accountIndex: Number(sourceMember.accountId),
            nickname: sourceMember.nickname || 'Player',
            teamIndex: Number(sourceMember.team) === 1 ? 1 : 0,
            userLevelText: '1',
            selectedMech: Number(sourceClient && sourceClient.currentHangarSlot_) || 1,
            pilotId: Number(sourceClient && sourceClient.pilot_) || 101,
        };
        try {
            await sendGameUserBootstrap(targetMember.client, ctx, getExactMessageBuffer, {
                sendTo: targetMember.client,
                itemsAccountId: sourceMember.accountId,
            });
        } catch (err) {
            console.error(`[ZGateGameDispatch] >> Game_User_SN (join-in-progress) failed: ${err.message} [${tag}]`);
        }
    }
}

async function sendGameUserToClient(sourceMember, targetMember, tag)
{
    if (!targetMember.client) return;
    const sourceClient = sourceMember.client;
    const ctx = {
        accountIndex: Number(sourceMember.accountId),
        nickname: sourceMember.nickname || 'Player',
        teamIndex: Number(sourceMember.team) === 1 ? 1 : 0,
        userLevelText: '1',
        selectedMech: Number(sourceClient && sourceClient.currentHangarSlot_) || 1,
        pilotId: Number(sourceClient && sourceClient.pilot_) || 101,
    };
    try {
        await sendGameUserBootstrap(targetMember.client, ctx, getExactMessageBuffer, {
            sendTo: targetMember.client,
            itemsAccountId: sourceMember.accountId,
        });
        console.log(`[ZGateGameDispatch] >> Added in-game user ${sourceMember.accountId} to account ${targetMember.accountId} [${tag}]`);
    } catch (err) {
        console.error(`[ZGateGameDispatch] >> Game_User_SN (join-in-progress update) failed: ${err.message} [${tag}]`);
    }
}

function broadcastRoomReadyStates(room)
{
    for (const member of room.members.values()) {
        rooms.sendAll(room.id, () => {
            const [msg, body] = getExactMessageBuffer(0x00220401, 0x08);
            body.writeUInt8(0, 0x00);
            body.writeUInt8(1, 0x01);
            body.writeUInt16LE(member.accountId, 0x02);
            body.writeUInt32LE(member.ready ? 2 : 1, 0x04);
            return msg;
        });
    }
}

function sendRoomMemberState(room, accountId, ready)
{
    rooms.sendAll(room.id, () => {
        const [msg, body] = getExactMessageBuffer(0x00220401, 0x08);
        body.writeUInt8(0, 0x00);
        body.writeUInt8(1, 0x01);
        body.writeUInt16LE(accountId, 0x02);
        body.writeUInt32LE(ready ? 2 : 1, 0x04);
        return msg;
    });
}

function sendGameInfoSnRoomBroadcast(room, tag)
{
    const BODY_SIZE = 0x1A;
    const mapId = Number(room.mapId || MAP_ID_DEFAULT_CAMPAIGN) & 0xFFFF;
    const battleIndex = 1;
    const redTeamIndex = 0;
    const blueTeamIndex = 1;
    const clanFlag = 0;

    let timeLimitMinutes = 10;
    let timeLimitSource = 'hardcoded';
    if (room.playTime) {
        timeLimitMinutes = room.playTime;
        timeLimitSource = 'room';
    }
    const playRound = Number(room.playRound) || 0;
    const goalScore = 0;

    rooms.sendAll(room.id, () => {
        const [msg, body] = getExactMessageBuffer(0x00222111, BODY_SIZE);
        body.writeUInt32LE(battleIndex, 0x00);
        body.writeUInt16LE(redTeamIndex, 0x04);
        body.writeUInt16LE(blueTeamIndex, 0x06);
        body.writeUInt16LE(0, 0x0A);
        body.writeUInt16LE(0, 0x0C);
        body.writeUInt8(clanFlag, 0x0E);
        body.writeUInt16LE(Math.min(Math.max(Number(room.members.size) || 1, 1), Number(room.maxPlayers) || 8), 0x0F);
        body.writeUInt16LE(mapId, 0x11);
        body.writeUInt16LE(timeLimitMinutes, 0x13);
        body.writeUInt8(playRound & 0xFF, 0x15);
        body.writeUInt16LE(goalScore, 0x16);
        body.writeUInt16LE(goalScore, 0x18);
        return msg;
    });
    console.log(
        `[ZGateGameDispatch] >> Broadcast Game_Info_SN 0x00222111 to room #${room.id} (${room.members.size} member(s)) [${tag}] ` +
        `(battle=${battleIndex}, red=${redTeamIndex}, blue=${blueTeamIndex}, map=${mapId}, ` +
        `clan=${clanFlag}, timeLimit=${timeLimitMinutes} (${timeLimitSource}), round=${playRound}, goal=${goalScore})`
    );
}

function scheduleGameWaitSnExperiment(client)
{

    if (!client.battleStartSequenceArmed_) {
        console.log(`[ZGateGameDispatch] >> Skipped Game_Wait_SN experiment (battleStartSequenceArmed_=false)`);
        return;
    }
    if (client.gameWaitExperimentSent_) {
        console.log(`[ZGateGameDispatch] >> Skipped Game_Wait_SN experiment (already scheduled for this start)`);
        return;
    }

    client.gameWaitExperimentSent_ = true;
    sendRoomGameWaitSn(client, 'experiment immediate after Game_Start_SN');
    setTimeout(() => {
        sendRoomGameWaitSn(client, 'experiment retry @75ms before Game_Info_SN');
    }, 75);
}

function schedulePostGameWaitReadyHost(client)
{

    if (!client.battleStartSequenceArmed_) {
        console.log(`[ZGateGameDispatch] >> Skipped post-Game_Wait Ready_Host (battleStartSequenceArmed_=false)`);
        return;
    }
    if (client.postGameWaitReadyHostSent_) {
        console.log(`[ZGateGameDispatch] >> Skipped post-Game_Wait Ready_Host (already scheduled)`);
        return;
    }

    client.postGameWaitReadyHostSent_ = true;
    setTimeout(() => {
        sendReadyHostSq(client);
    }, 160);
    setTimeout(() => {
        sendReadyHostSn(client);
    }, 260);
}

function scheduleGameInfoSnExperiment(client)
{

    if (!client.battleStartSequenceArmed_) {
        console.log(`[ZGateGameDispatch] >> Skipped Game_Info_SN experiment (battleStartSequenceArmed_=false)`);
        return;
    }
    if (client.waitingGameInfoExperimentSent_) {
        console.log(`[ZGateGameDispatch] >> Skipped Game_Info_SN experiment (already scheduled for this start)`);
        return;
    }

    client.waitingGameInfoExperimentSent_ = true;
    [350, 700, 1200].forEach((delay, index) => {
        setTimeout(() => {
            sendGameInfoSn(client, `experiment #${index + 1} @${delay}ms`);
        }, delay);
    });
}

function primeReadyHostHandshake(client)
{

    if (!client.battleStartSequenceArmed_) {
        console.log(`[ZGateGameDispatch] >> Skipped Ready_Host prime (battleStartSequenceArmed_=false)`);
        return;
    }
    if (client.readyHostHandshakeSent_) {
        console.log(`[ZGateGameDispatch] >> Skipped Ready_Host prime (already sent for this room/start)`);
        return;
    }

    client.readyHostHandshakeSent_ = true;
    setTimeout(() => {
        sendReadyHostSn(client);
    }, 100);
}

function parseMapChangeOneBody(body)
{
    const safe = Buffer.alloc(10, 0x00);
    body.copy(safe, 0, 0, Math.min(body.length, safe.length));
    return {
        rawHex: safe.toString('hex'),
        b0: safe.readUInt8(0),
        w1: safe.readUInt16LE(1),
        w2: safe.readUInt16LE(3),
        b5: safe.readUInt8(5),
        w6: safe.readUInt16LE(6),
        w8: safe.readUInt16LE(8),
    };
}

function getCurrentCampaignMapCacheIndex(client)
{
    return CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID[client.mapId_] || 8;
}

function resolveExperimentValue(value, client)
{
    if (value === 'current_cache') {
        return getCurrentCampaignMapCacheIndex(client);
    }
    return value;
}

function writeMapChangeOneBody(body, fields, offset = 0)
{
    body.writeUInt8(fields.b0 & 0xFF, offset + 0);
    body.writeUInt16LE(fields.w1 & 0xFFFF, offset + 1);
    body.writeUInt16LE(fields.w2 & 0xFFFF, offset + 3);
    body.writeUInt8(fields.b5 & 0xFF, offset + 5);
    body.writeUInt16LE(fields.w6 & 0xFFFF, offset + 6);
    body.writeUInt16LE(fields.w8 & 0xFFFF, offset + 8);
}

function buildMapChangeOneSaFields(body, client)
{
    const incoming = parseMapChangeOneBody(body);
    {
        const adoptedMapId = Number(client.campaignMapCacheKey_);
        const adoptedRound = Number(client.playRound_);
        return {
            rawHex: null,

            b0: incoming.b0,
            w1: (adoptedMapId >= 9001 && adoptedMapId <= 9012) || MAP_IDS_PVP.includes(adoptedMapId)
                ? adoptedMapId : incoming.w1,
            w2: incoming.w2,
            b5: Number.isInteger(adoptedRound) && adoptedRound >= 0 && adoptedRound <= 0xFF
                ? adoptedRound : incoming.b5,
            w6: incoming.w6,
            w8: incoming.w8,
        };
    }

}

function buildRoomCtxFromRoom(room, accountId) {
    const isPvpRoom = rooms.isPvpRoom(room);
    return {
        roomIndex: room.id,
        accountIndex: accountId,
        roomType: room.rawRoomType,
        mapId: room.mapId,
        maxPlayers: room.maxPlayers,
        maxPlayersWire: room.maxPlayersWire,
        currentUsers: room.members.size,
        gameMode: room.gameMode,
        mapIndex: room.mapId,
        roomName: room.name,
        roomSettingGoal: room.campaign ? 0 : room.mapChangeOneGoal,
        roomSettingTime: room.campaign ? 0 : room.playTime,
        roomSettingRound: room.campaign ? 1 : room.playRound,
        roomDefaultEntryCount: room.campaign
            ? ROOM_DEFAULT_ENTRY_HINTS.length
            : (isPvpRoom ? MAP_IDS_PVP.length : Math.min(Math.max(room.maxPlayers, 1), ROOM_DEFAULT_ENTRY_HINTS.length)),
        roomDefaultEntryHints: isPvpRoom ? MAP_IDS_PVP : ROOM_DEFAULT_ENTRY_HINTS,
        primaryBodyCacheIndex: isPvpRoom
            ? MAP_IDS_PVP[0]
            : (CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID[room.createMapId || 1] || ROOM_DEFAULT_ENTRY_HINTS[0] || 8),
        selectedMech: 1,
        isCampaignRoom: room.campaign,
        isPvpRoom,
        optionMask: room.optionMask || 0,
        roomOptions: room.options,
        campaignMapCacheKey: room.mapId,
        campaignMapHints: computeCampaignMapAllHints(),
        pvpMapHints: MAP_IDS_PVP,
        mapChangeOneTime: room.playTime,
        mapChangeOneRound: room.playRound,
        playRound: room.playRound,
        mapChangeOneKill: room.mapChangeOneKill,
        mapChangeOneGoal: room.mapChangeOneGoal,
    };
}

function sendFullRoomStateToClient(client, room, accountId, tag) {
    const roomStateCtx = buildRoomCtxFromRoom(room, accountId);
    sendRoomStatePackets(client, roomStateCtx, getExactMessageBuffer);
    sendRoomMapPackets(client, roomStateCtx, getExactMessageBuffer, { mapChangeOneResponse: true });
    if (room.campaign) {
        const { sendCampaignBootstrap } = require('./room/room-map.sender');
        sendCampaignBootstrap(client, getExactMessageBuffer);
    }
    const allMembers = Array.from(room.members.values());
    for (const member of allMembers) {
        const memberCtx = buildMemberUserCtx(member);
        const includeMaster = member.accountId === room.hostAccountId;
        sendRoomUserPackets(client, memberCtx, getExactMessageBuffer, { includeMaster });

    }
    console.log(`[ZGateGameDispatch] >> Sent full room state from Room #${room.id} to account ${accountId} (members=${allMembers.length})${tag ? ` [${tag}]` : ''}`);
}

function resendRoomState(client, tag)
{
    try {
        const accountId = Number(client.accountIndex_ || client.accountId_ || 1);

        const room = rooms.getRoomByAccount(accountId);
        if (room && accountId !== room.hostAccountId) {
            sendFullRoomStateToClient(client, room, accountId, tag);
            return;
        }
        const ZRoomDispatch = require('./room.dispatch');
        const roomDispatch = new ZRoomDispatch();
        roomDispatch.sendRoomState(client);
        console.log(`[ZGateGameDispatch] >> Re-sent room state [${tag}]`);
    } catch (err) {
        console.error(`[ZGateGameDispatch] >> Error re-sending room state [${tag}]:`, err.message);
    }
}

function clearPendingRoomStateRetries(client, reason)
{
    const retries = Array.isArray(client.roomStateRetryTimers_) ? client.roomStateRetryTimers_ : [];
    if (retries.length === 0) {
        return;
    }
    for (const timer of retries) {
        clearTimeout(timer);
    }
    client.roomStateRetryTimers_ = [];
    console.log(`[ZGateGameDispatch] >> Cleared pending room state retries (${reason})`);
}

function resendRoomMapOnly(client, tag)
{
    try {

        const accountIdForRoom = Number(client.accountIndex_ || client.accountId_ || 1);
        const roomForResend = rooms.getRoomByAccount(accountIdForRoom);
        if (roomForResend && accountIdForRoom !== roomForResend.hostAccountId) {
            const roomCtx = buildRoomCtxFromRoom(roomForResend, accountIdForRoom);
            const { sendRoomMapPackets, sendCampaignBootstrap } = require('./room/room-map.sender');
            sendRoomMapPackets(client, roomCtx, getExactMessageBuffer, { mapChangeOneResponse: true });
            if (roomCtx.isCampaignRoom) sendCampaignBootstrap(client, getExactMessageBuffer);
            console.log(`[ZGateGameDispatch] >> Re-sent map packets only from Room #${roomForResend.id} [${tag}] (mapId=${roomCtx.mapId}, cacheKey=${roomCtx.campaignMapCacheKey})`);
            return;
        }

        if (!rooms.isPvpRoom(client)) {
            console.log(`[ZGateGameDispatch] >> Skipped map-only resend [${tag}] (not in a map-selectable room)`);
            return;
        }

        const { sendRoomMapPackets, sendCampaignBootstrap } = require('./room/room-map.sender');
        // sendRoomState와 동일한 맵 목록 사용 — same map list as sendRoomState (CAMPAIGN_MAP_ALL_HINTS)
        const campaignMapAllHints = computeCampaignMapAllHints();
        const roomDefaultEntryHints = ROOM_DEFAULT_ENTRY_HINTS;
        const mapId = client.createdMapId_ || client.mapId_ || 1;
        const campaignMapCacheKey = client.campaignMapCacheKey_ || CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID[mapId] || 8;
        const ctx = {
            campaignMapCacheKey,
            roomDefaultEntryHints,
            campaignMapHints: campaignMapAllHints,
            pvpMapHints: MAP_IDS_PVP,

            isCampaignRoom: client.campaignRoom_,
            isPvpRoom: rooms.isPvpRoom(client),
            mapChangeOneTime: client.mapChangeOneTime_,
            mapChangeOneRound: client.mapChangeOneRound_,
            playRound: client.playRound_,
            mapChangeOneKill: client.mapChangeOneKill_,
            mapChangeOneGoal: client.mapChangeOneGoal_,
        };
        sendRoomMapPackets(client, ctx, getExactMessageBuffer, { mapChangeOneResponse: true });
        if (client.campaignRoom_) sendCampaignBootstrap(client, getExactMessageBuffer);
        console.log(`[ZGateGameDispatch] >> Re-sent map packets only [${tag}] (mapId=${mapId}, cacheKey=${campaignMapCacheKey})`);
    } catch (err) {
        console.error(`[ZGateGameDispatch] >> Error re-sending map packets [${tag}]:`, err.message);
    }
}

module.exports =
class ZGateGameDispatch
{
    dispatch(client, type, body)
    {
        const prefix = (type >> 16) & 0xFF;

        // Only handle 0x22XXXX messages
        if (prefix !== 0x22)
            return false;

        if (type === 0x00220111 || type === 0x00220101 || type === 0x00220102)
            return false;

        const subRange = (type >> 8) & 0xFF;
        console.log(`[ZGateGameDispatch] Message 0x${type.toString(16).padStart(8, '0')} sub=0x${subRange.toString(16)} (${body.length} bytes)`);
        if (body.length > 0) {
            console.log(`[ZGateGameDispatch] Body:`, body.toString('hex'));
            const ascii = body.toString('ascii').replace(/[^\x20-\x7e]/g, '.');
            if (ascii.replace(/\./g, '').length > 2) {
                console.log(`[ZGateGameDispatch] ASCII:`, ascii);
            }
        }

        switch (type)
        {
            // ==========================================
            // Room Creation from Lobby
            // ==========================================
            case CQ_CREATE:
            {
                console.log(`[ZGateGameDispatch] >> Room Create request (${body.length} bytes)`);

                const roomIndex = rooms.allocateRoomId();
                const enterRoomIndex = 0;
                const nickname = client.nickname_ || 'Player';

                // Parse CQ_CREATE body and echo settings back in Room_Default_SN.
                // ZDispatchLobby::Create_CQ writes body[11] as a value flag and
                // body[12..13] as the associated room/max value. The selected map
                // is the byte at body[6].
                const roomType = body.length > 0 ? body[0] : 0;
                const createByte1 = body.length > 1 ? body[1] : 0;
                const createWord1 = body.length >= 4 ? body.readUInt16LE(2) : 0;
                const createWord2 = body.length >= 6 ? body.readUInt16LE(4) : 0;
                const mapId = body.length > 6 ? body[6] : 1;
                const createWord3 = body.length >= 9 ? body.readUInt16LE(7) : 0;
                const createWord4 = body.length >= 11 ? body.readUInt16LE(9) : 0;
                const roomNumberFlag = body.length > 11 ? body[11] : 0;
                const roomNumberValue = body.length >= 14 ? body.readUInt16LE(12) : 1;
                const gameMode = createWord4 & 0xFF;
                const rawName = body.length > 14
                    ? decodeAnsiBytes(body.subarray(14, Math.min(body.length, 39)))
                    : '';
                const roomName = rawName || `${nickname}`;
                const hasPassword = body.length > 39 ? body[39] : 0;
                const roomPassword = hasPassword
                    ? decodeAnsiBytes(body.subarray(40, Math.min(body.length, 51)))
                    : '';
                // isCampaignLike: roomType 1(캠페인)과 2(PvP) 모두 최대 8명 슬롯 유지용 (keeps max 8-player slots for both roomType 1 (campaign) and 2 (PvP))
                const isCampaignLike = (roomType === 1) || (roomType === 2) || (gameMode === 4 || gameMode === 5);
                const effectiveRoomType = isCampaignLike ? 2 : roomType;
                const isCampaignRoom = (roomType === 1) || (gameMode === 4 || gameMode === 5);
                const requestedPvpMaxPlayers = [8, 16, 24, 32].includes(createByte1)
                    ? createByte1
                    : null;
                const pvpTeamSize = requestedPvpMaxPlayers
                    ? requestedPvpMaxPlayers / 2
                    : Math.min(Math.max(roomNumberValue + 1, 1), 16);
                const maxPlayers = isCampaignRoom
                    ? 8
                    : (roomType === 2 ? (requestedPvpMaxPlayers || pvpTeamSize * 2) : Math.min(Math.max(roomNumberValue || 1, 1), 8));
                const maxPlayersWire = isCampaignRoom ? 8 : (roomType === 2 ? pvpTeamSize - 1 : maxPlayers);
                // isCampaignRoom: 실제 캠페인 방 여부 (PvP는 false) (whether it is an actual campaign room, PvP=false)

                const roomNameBig5Readable = decodeBig5ForLog(roomName);
                console.log(`[ZGateGameDispatch] >> Creating room #${roomIndex} (type=${roomType}->${effectiveRoomType}, map=${mapId}, opt1=0x${createWord1.toString(16)}, opt2=0x${createWord2.toString(16)}, max=${maxPlayers}, mode=${gameMode}, valueFlag=${roomNumberFlag}, value=${roomNumberValue}) for "${nickname}"${roomNameBig5Readable ? ` name_big5="${roomNameBig5Readable}"` : ''}`);

                // Store room info on client for other dispatchers to reference
                client.createdRoomIndex_ = roomIndex;
                client.roomIndex_ = enterRoomIndex;
                client.roomType_ = effectiveRoomType;
                client.rawRoomType_ = roomType;
                client.mapId_ = mapId;
                client.playRound_ = Number(client.mapChangeOneRound_) || 1;
                client.createByte1_ = createByte1;
                client.createWord1_ = createWord1;
                client.createWord2_ = createWord2;
                client.createPlayTime_ = createWord2;
                client.createWord3_ = createWord3;
                client.createWord4_ = createWord4;
                client.roomNumberFlag_ = roomNumberFlag;
                client.roomNumberValue_ = roomNumberValue;
                client.roomName_ = roomName;
                client.roomPassword_ = roomPassword;
                client.maxPlayers_ = maxPlayers;
                client.maxPlayersWire_ = maxPlayersWire;
                client.gameMode_ = gameMode;
                client.mapSeed_ = (createWord2 << 16) | createWord1;
                client.campaignRoom_ = isCampaignRoom;
                client.createdMapId_ = mapId;
                {
                    const pickedMap = body.length >= 4 ? body.readUInt16LE(2) : 0;
                    client.campaignMapCacheKey_ = isCampaignRoom
                        ? ((pickedMap >= 9001 && pickedMap <= 9012) ? pickedMap : MAP_ID_DEFAULT_CAMPAIGN)
                        : (MAP_IDS_PVP.includes(pickedMap) ? pickedMap : MAP_ID_DEFAULT_PVP);
                }
                client.readyHostHandshakeSent_ = false;
                client.gameUserBootstrapSent_ = false;
                client.waitingGameInfoExperimentSent_ = false;
                client.gameWaitExperimentSent_ = false;
                client.postGameWaitReadyHostSent_ = false;

                {
                    const hostAccountId = Number(client.accountIndex_ || client.accountId_ || 1);
                    const room = rooms.createRoom({
                        id: roomIndex,
                        name: roomName,
                        mapId: client.campaignMapCacheKey_ || mapId,

                        playTime: client.mapChangeOneTime_ ?? client.createPlayTime_ ?? 0,
                        playRound: client.mapChangeOneRound_ ?? client.playRound_,
                        maxPlayers,
                        maxPlayersWire,
                        campaign: isCampaignRoom,
                        hostAccountId,
                        roomType: effectiveRoomType,
                        hasPassword: !!roomPassword,
                        password: roomPassword,
                        rawRoomType: roomType,
                        gameMode,
                        optionMask: createWord2,
                        mapChangeOneKill: client.mapChangeOneKill_,
                        mapChangeOneGoal: client.mapChangeOneGoal_,
                        createMapId: mapId,
                    });
                    rooms.addMember(room.id, {
                        accountId: hostAccountId,
                        nickname,

                        team: 0,
                        slot: 0,
                        ready: false,
                        client,
                    });

                    {
                        broadcastRoomListChange(rooms.getLobbyClients(), room, 1, getExactMessageBuffer);
                        console.log(`[ZGateGameDispatch] >> Broadcast new room #${room.id} to the lobby`);
                    }
                }

                // ZDispatchLobby::Create_CQ sends 0x220201 with Send(..., 0x220202),
                // so the matching success response is Create_SA 0x220202. The
                // handler requires body+0x00 word == 0 and body+0x02 dword == 0
                // before it clears lobby/room data and switches to the room scene.
                {
                    const bodySize = 0x28;
                    const [msg, respBody] = getExactMessageBuffer(SA_LOBBY_CREATE, bodySize);
                    respBody.writeUint16LE(enterRoomIndex, 0x00);
                    respBody.writeUint32LE(0, 0x02);
                    respBody.writeUint16LE(enterRoomIndex, 0x06);
                    respBody.writeUint8(0, 0x0B);

                    const createSaNameEncoding = 'latin1';
                    const createSaNameLengthBasis = Buffer.byteLength(roomName, 'latin1');
                    respBody.write(roomName + '\0', 0x0E, Math.min(createSaNameLengthBasis + 1, 0x19), createSaNameEncoding);
                    respBody.writeUint8(roomPassword ? 1 : 0, 0x27);
                    client.send(msg);
                    console.log(`[ZGateGameDispatch] >> Sent Create_SA 0x220202 (Lobby_Room_Create trigger, roomIndex=${enterRoomIndex}, body=${bodySize}, directName=1)`);
                }

                console.log(`[ZGateGameDispatch] >> Room creation response sent via Create_SA path (created=${roomIndex}, enter=${enterRoomIndex})`);

                // Send room state after Create_SA scene transition, then retry while
                // the room scene activates its ZDispatchRoom handlers.
                client.roomStateRetryTimers_ = [];
                const sendRoomStateDelayed = (delay, tag) => {
                    const timer = setTimeout(() => {
                        try {
                            const ZRoomDispatch = require('./room.dispatch');
                            const roomDispatch = new ZRoomDispatch();
                            roomDispatch.sendRoomState(client);
                            console.log(`[ZGateGameDispatch] >> Sent room state notifications (0x22 room SN) [${tag}]`);

                            {
                                if (client.campaignRoom_ && !client.campaignMapCacheKey_)
                                    client.campaignMapCacheKey_ = MAP_ID_DEFAULT_CAMPAIGN;
                                sendGameInfoSn(client, `room state [${tag}]`);
                            }
                        } catch (err) {
                            console.error(`[ZGateGameDispatch] >> Error sending room state:`, err.message);
                        }
                    }, delay);
                    client.roomStateRetryTimers_.push(timer);
                };
                for (const [delay, tag] of ROOM_STATE_RETRY_SCHEDULE)
                    sendRoomStateDelayed(delay, tag);

                return true;
            }

            // ==========================================
            // Hardware/Config Reports (CN - client notification, no response needed)
            // ==========================================
            case 0x00221221:
            {
                // Client sends hardware/graphics config as 0x05-delimited strings
                // First field is "true"/"false", second is version like "2.50"
                // Followed by numeric capability codes
                console.log(`[ZGateGameDispatch] >> Hardware config report (${body.length} bytes) - acknowledged`);
                return true;
            }

            // ==========================================
            // Player name/presence lookup
            // ==========================================
            case 0x00220121:
            {
                const name = body.subarray(0, 25).toString('ascii').split('\0').shift();
                console.log(`[ZGateGameDispatch] >> Player lookup: "${name}"`);

                const [msg, respBody] = client.getMessageBuffer(0x00220122, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
                return true;
            }

            // ==========================================
            // Room Enter CN (씬 로드 완료 알림 / scene load complete notification)
            // 클라이언트가 방 씬 로드 후 반복 전송 — 방 상태 재전송으로 응답 (client sends this repeatedly after loading the room scene — respond by re-sending room state)
            // ==========================================
            case 0x00222101:
            {
                console.log(`[ZGateGameDispatch] >> Room Enter CN (0x00222101) — ACK only`);
                sendOkSa(client, 0x00222102, 'Room_Enter_SN');
                // 최초 1회만 방 상태 재전송, 이후는 ACK만 (re-send room state only on the first occurrence; ACK only thereafter)
                if (!client.roomEnterAcked_) {
                    client.roomEnterAcked_ = true;
                    resendRoomState(client, 'room-enter cn (first)');
                }

                {
                    const accountIdForReady = Number(client.accountIndex_ || client.accountId_ || 1);
                    const roomForReady = rooms.getRoomByAccount(accountIdForReady);
                    if (roomForReady && body.length >= 5) {
                        const readyFlag = body.readUInt8(4) !== 0;
                        const member = roomForReady.members.get(accountIdForReady);
                        if (member) {
                            member.ready = readyFlag;
                            sendRoomMemberState(roomForReady, accountIdForReady, readyFlag);
                            console.log(`[ZGateGameDispatch] >> Broadcast User_State_SN 0x220401 (account=${accountIdForReady}, ready=${readyFlag}, raw=${readyFlag ? 2 : 1})`);
                        }
                    }
                }
                return true;
            }

            // ==========================================
            // Room Game Start CQ
            // ==========================================
            case 0x00222103:
            {

                {
                    const accountIdForGate = Number(client.accountIndex_ || client.accountId_ || 1);
                    const roomForGate = rooms.getRoomByAccount(accountIdForGate);
                    if (roomForGate) {
                        if (accountIdForGate !== roomForGate.hostAccountId) {
                            console.log(`[ZGateGameDispatch] >> Ignored Game_Start_CN 0x00222103 from non-host account=${accountIdForGate} (host=${roomForGate.hostAccountId}, room #${roomForGate.id})`);
                            return true;
                        }
                        if (roomForGate.state === 'playing') {
                            console.log(`[ZGateGameDispatch] >> Ignored duplicate Game_Start_CN for room #${roomForGate.id} already in progress`);
                            return true;
                        }
                        if (rooms.isPvpRoom(roomForGate)) {
                            const teams = new Set(Array.from(roomForGate.members.values(), (member) => Number(member.team)));
                            if (teams.size < 2) {
                                console.log(`[ZGateGameDispatch] >> Refused PvP start for room #${roomForGate.id}: both teams must be occupied`);
                                return true;
                            }
                        }
                        if (roomForGate.members.size > 1) {

                            const hostAddress = client.username_
                                ? whitelist.getHostAddress(client.username_, client.socket_ && client.socket_.remoteAddress)
                                : null;
                            if (!hostAddress) {
                                console.error(`[ZGateGameDispatch] !! Refusing battle start: no hostAddress configured for host account=${accountIdForGate} (username=${client.username_}, nickname=${client.nickname_}), room #${roomForGate.id} has ${roomForGate.members.size} members`);
                                return true;
                            }
                        }
                    }
                }

                // Static analysis confirms both Game_Ready_SN (0x222102) and
                // Game_Start_SN (0x222104) consume the same simple SA body and
                // emit NETWORK_ROOM_GAME_READY. Current runtime only sending
                // 0x222104 did not progress beyond that point, so keep a narrow
                // experiment that can also send 0x222102 first.
                console.log(`[ZGateGameDispatch] >> Room Game_Start_CQ`);
                clearPendingRoomStateRetries(client, 'game-start cq');

                client.pveRoundsCleared_ = 0;
                {
                    const accountIdForRoundReset = Number(client.accountIndex_ || client.accountId_ || 1);
                    const roomForRoundReset = rooms.getRoomByAccount(accountIdForRoundReset);
                    if (roomForRoundReset && accountIdForRoundReset === roomForRoundReset.hostAccountId) {
                        roomForRoundReset.pveRoundsCleared_ = 0;

                    }
                }

                {
                    const accountIdForStart = Number(client.accountIndex_ || client.accountId_ || 1);
                    const roomForStart = rooms.getRoomByAccount(accountIdForStart);
                    if (roomForStart) {
                        roomForStart.state = 'playing';
                        for (const member of roomForStart.members.values()) {
                            if (member.client) member.client.gameStarted_ = true;
                        }
                        for (const member of roomForStart.members.values()) {
                            member.ready = false;
                        }
                        roomForStart.teamScores = [0, 0];
                        broadcastRoomReadyStates(roomForStart);
                        broadcastRoomListChange(rooms.getLobbyClients(), roomForStart, 2, getExactMessageBuffer);
                    }
                }

                const accountIdForBattleBroadcast = Number(client.accountIndex_ || client.accountId_ || 1);
                const roomForBattleBroadcast = rooms.getRoomByAccount(accountIdForBattleBroadcast);

                let startedBattleGen;
                let startedHostAccountId;
                if (roomForBattleBroadcast) {
                    roomForBattleBroadcast.battleStartGen = (roomForBattleBroadcast.battleStartGen || 0) + 1;
                    startedBattleGen = roomForBattleBroadcast.battleStartGen;
                    startedHostAccountId = roomForBattleBroadcast.hostAccountId;
                }

                function battleStartStillValid(tag)
                {
                    if (!roomForBattleBroadcast) return true;
                    const currentRoom = rooms.getRoom(roomForBattleBroadcast.id);
                    if (!currentRoom) {
                        console.log(`[ZGateGameDispatch] >> Battle-start aborted: room #${roomForBattleBroadcast.id} no longer tracked [${tag}]`);
                        return false;
                    }
                    if (currentRoom.battleStartGen !== startedBattleGen) {
                        console.log(`[ZGateGameDispatch] >> Battle-start aborted: room #${roomForBattleBroadcast.id}'s battleStartGen changed (${startedBattleGen} -> ${currentRoom.battleStartGen}, a newer Game_Start_CN superseded this one) [${tag}]`);
                        return false;
                    }
                    if (currentRoom.hostAccountId !== startedHostAccountId) {
                        console.log(`[ZGateGameDispatch] >> Battle-start aborted: room #${roomForBattleBroadcast.id}'s host changed (${startedHostAccountId} -> ${currentRoom.hostAccountId}) mid-sequence [${tag}]`);
                        return false;
                    }
                    return true;
                }

                {

                    const useRoomBattleBroadcast = !!roomForBattleBroadcast;

                    if (useRoomBattleBroadcast) {
                        for (const member of roomForBattleBroadcast.members.values()) {
                            if (!member.client) continue;
                            if (member.client.campaignRoom_ && !member.client.campaignMapCacheKey_)
                                member.client.campaignMapCacheKey_ = MAP_ID_DEFAULT_CAMPAIGN;
                            member.client.gameStarted_ = true;

                            member.client.battleStartSequenceArmed_ = !!roomForBattleBroadcast.campaign ||
                                (false);
                        }
                    } else {

                        if (client.campaignRoom_ && !client.campaignMapCacheKey_)
                            client.campaignMapCacheKey_ = MAP_ID_DEFAULT_CAMPAIGN;
                        client.gameStarted_ = true;

                        client.battleStartSequenceArmed_ = (Number(client.rawRoomType_) === 1) ||
                            (Number(client.gameMode_) === 4 || Number(client.gameMode_) === 5) ||
                            (false);
                    }

                    if (useRoomBattleBroadcast) {
                        sendRoomGameWaitSnBroadcast(roomForBattleBroadcast, 'server-driven: to scene 6');
                    } else {
                        sendRoomGameWaitSn(client, 'server-driven: to scene 6');
                    }

                    setTimeout(() => {
                        if (!battleStartStillValid('game-user-sn @60ms')) return;

                        if (roomForBattleBroadcast) {
                            sendGameUserSnRoomBroadcast(roomForBattleBroadcast, 'server-driven: in-game user table', startedBattleGen);
                        } else {
                            sendGameUserSn(client, 'server-driven: in-game user table');
                        }
                    }, 60);

                    setTimeout(() => {
                        if (!battleStartStillValid('game-info-sn @150ms')) return;
                        if (useRoomBattleBroadcast) {
                            sendGameInfoSnRoomBroadcast(roomForBattleBroadcast, 'server-driven: scene-6 map');
                        } else {
                            sendGameInfoSn(client, 'server-driven: scene-6 map');
                        }
                    }, 150);

                    setTimeout(() => {
                        if (!battleStartStillValid('ready-start-sn @300ms')) return;
                        if (useRoomBattleBroadcast) {
                            sendAckBroadcast(roomForBattleBroadcast, 0x00222102, 'server-driven: Game_Ready_SN');
                            sendAckBroadcast(roomForBattleBroadcast, 0x00222104, 'server-driven: Game_Start_SN');
                        } else {
                            sendOkSa(client, 0x00222102, 'server-driven: Game_Ready_SN');
                            sendOkSa(client, 0x00222104, 'server-driven: Game_Start_SN');
                        }
                    }, 300);

                    setTimeout(() => {
                        if (!battleStartStillValid('ready-host-sq @450ms')) return;
                        if (roomForBattleBroadcast) {

                            const hostMember = roomForBattleBroadcast.members.get(roomForBattleBroadcast.hostAccountId);
                            if (hostMember && hostMember.client) {
                                sendReadyHostSq(hostMember.client);
                            } else {
                                console.error(`[ZGateGameDispatch] !! room #${roomForBattleBroadcast.id}'s host (account=${roomForBattleBroadcast.hostAccountId}) has no live connection -- not sending Ready_Host_SQ`);
                            }
                        } else {
                            sendReadyHostSq(client);
                        }
                    }, 450);
                    setTimeout(() => {
                        if (!battleStartStillValid('game-info-sn retry @600ms')) return;
                        if (useRoomBattleBroadcast) {
                            sendGameInfoSnRoomBroadcast(roomForBattleBroadcast, 'server-driven: scene-6 map retry');
                        } else {
                            sendGameInfoSn(client, 'server-driven: scene-6 map retry');
                        }
                    }, 600);
                    console.log(`[ZGateGameDispatch] >> SERVER_DRIVEN_START: Wait -> Info -> Ready/Start`);
                    return true;
                }

            }

            case 0x00222131:
            {
                console.log(`[ZGateGameDispatch] >> 0x222131 (Leave_CQ, in-battle): replying Leave_SA 0x222132`);
                const [msg, respBody] = client.getMessageBuffer(0x00222132, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);

                const accountId = Number(client.accountIndex_ || client.accountId_ || 1);
                const room = rooms.getRoomByAccount(accountId);
                if (room && room.state === 'playing') {
                    const departing = room.members.get(accountId);
                    const remaining = Array.from(room.members.values()).filter((member) => member.accountId !== accountId);
                    const remainingTeams = new Set(remaining.map((member) => Number(member.team)));
                    const endsPvp = rooms.isPvpRoom(room) && remaining.length > 0 && remainingTeams.size < 2;
                    if (endsPvp) {
                        const winnerTeam = Number(remaining[0].team) || 0;
                        for (const member of remaining) {
                            if (!member.client) continue;
                            const [endMsg, endBody] = getExactMessageBuffer(0x00222213, 0x1E);
                            endBody.writeUint16LE(winnerTeam, 0x00);
                            endBody.writeUint16LE(0, 0x02);
                            endBody.writeUint16LE(1, 0x10);
                            member.client.send(endMsg);
                        }
                        console.log(`[ZGateGameDispatch] >> PvP match ended after account=${accountId} left; winnerTeam=${winnerTeam}, room #${room.id} returned to lobby`);
                    }
                    if (endsPvp) {
                        room.state = 'lobby';
                        room.battleStartGen = (room.battleStartGen || 0) + 1;
                        for (const member of room.members.values()) {
                            member.ready = false;
                            if (member.client) member.client.gameStarted_ = false;
                        }
                        client.gameStarted_ = false;
                        broadcastRoomReadyStates(room);
                        broadcastRoomListChange(rooms.getLobbyClients(), room, 2, getExactMessageBuffer);
                    }
                }

                return true;
            }

            case 0x00220231:
            {

                const roomIndexReq = body.length >= 2 ? body.readUInt16LE(0) : 0;
                let password = '';
                for (let i = 2; i + 1 < body.length; i += 2) {
                    const code = body.readUInt16LE(i);
                    if (code === 0) break;
                    password += String.fromCharCode(code);
                }

                const accountId = Number(client.accountIndex_ || client.accountId_ || 1);
                const room = rooms.getRoom(roomIndexReq);

                const sendEnterSa = (ok) => {
                    const [msg, respBody] = getExactMessageBuffer(0x00220232, 0x06);
                    respBody.writeUInt16LE(ok ? 0 : 1, 0x00);
                    respBody.writeUInt32LE(ok ? 0 : 1, 0x02);
                    client.send(msg);
                    console.log(`[ZGateGameDispatch] >> Sent Enter_SA 0x220232 (${ok ? 'success' : 'failure'}, room=${roomIndexReq})`);
                };

                if (!room) {
                    console.log(`[ZGateGameDispatch] >> Enter_CQ: room #${roomIndexReq} not found`);
                    sendEnterSa(false);
                    return true;
                }
                if (room.hasPassword && room.password !== password) {
                    console.log(`[ZGateGameDispatch] >> Enter_CQ: wrong password for room #${roomIndexReq}`);
                    sendEnterSa(false);
                    return true;
                }

                if (room.state === 'playing' && !room.options.intrude) {
                    console.log(`[ZGateGameDispatch] >> Enter_CQ: room #${roomIndexReq} does not allow joining in progress`);
                    sendEnterSa(false);
                    return true;
                }

                if (rooms.getRoomByAccount(accountId)) {
                    console.log(`[ZGateGameDispatch] >> Enter_CQ: account=${accountId} is already in a room`);
                    sendEnterSa(false);
                    return true;
                }

                if (room.members.size >= room.maxPlayers) {
                    console.log(`[ZGateGameDispatch] >> Enter_CQ: room #${roomIndexReq} full (${room.members.size}/${room.maxPlayers})`);
                    sendEnterSa(false);
                    return true;
                }

                const nickname = client.nickname_ || 'Player';
                const teamCounts = [0, 0];
                for (const member of room.members.values()) {
                    if (Number(member.team) === 1) teamCounts[1]++;
                    else teamCounts[0]++;
                }
                const joinTeam = teamCounts[0] <= teamCounts[1] ? 0 : 1;
                rooms.addMember(room.id, {
                    accountId,
                    nickname,
                    team: joinTeam,
                    slot: 0,
                    ready: false,
                    client,
                });

                client.campaignRoom_ = room.campaign;
                client.createdRoomIndex_ = room.id;
                client.roomIndex_ = 0;
                client.maxPlayers_ = room.maxPlayers;
                client.maxPlayersWire_ = room.maxPlayersWire;
                client.mapId_ = room.mapId;
                client.roomName_ = room.name;

                sendEnterSa(true);

                const allMembers = Array.from(room.members.values());
                const otherMembers = allMembers.filter((m) => m.accountId !== accountId);

                setTimeout(() => {
                    if (room.state === 'playing') {
                        const joiner = room.members.get(accountId);
                        if (!joiner || !joiner.client) return;
                        sendRoomGameWaitSn(joiner.client, 'join in progress');
                        sendGameUsersToClient(room, joiner, 'join in progress').then(() => {
                            for (const member of room.members.values()) {
                                if (member.accountId !== accountId)
                                    sendGameUserToClient(joiner, member, 'join in progress');
                            }
                            setTimeout(() => {
                                if (rooms.getRoom(room.id) !== room || room.state !== 'playing' || !room.members.has(accountId)) return;
                                sendGameInfoSnToClient(room, joiner.client, 'join in progress');
                                sendOkSa(joiner.client, 0x00222102, 'join in progress: Game_Ready_SN');
                                sendOkSa(joiner.client, 0x00222104, 'join in progress: Game_Start_SN');
                            }, 150);
                        });
                    } else {
                        sendFullRoomStateToClient(client, room, accountId);
                    }
                }, 350);

                const joinerCtxSource = { accountId, nickname, team: joinTeam, client };
                for (const member of otherMembers) {
                    if (!member.client) continue;
                    sendRoomUserPackets(member.client, buildMemberUserCtx(joinerCtxSource), getExactMessageBuffer, { includeMaster: false });
                }
                console.log(`[ZGateGameDispatch] >> Notified ${otherMembers.length} existing room member(s) of new arrival (account=${accountId})`);

                {
                    broadcastRoomListChange(rooms.getLobbyClients(), room, 2, getExactMessageBuffer);
                }

                return true;
            }

            // ==========================================
            // Room Map Change All CQ
            // ==========================================
            case 0x00220224:
            {
                const [msg, respBody] = getExactMessageBuffer(0x00220225, 0x06);
                respBody.writeUInt16LE(0, 0x00);
                respBody.writeUInt32LE(0, 0x02);
                client.send(msg);
                const room = rooms.getRoomByAccount(Number(client.accountIndex_ || client.accountId_ || 1));
                console.log(`[ZGateGameDispatch] >> Sent Map_Change_All_SA 0x220225 (status=0, result=0, request=${body.length} bytes)`);
                return true;
            }

            // ==========================================
            // Room Map Change One CQ
            // ==========================================
            case 0x00220221:
            {
                clearPendingRoomStateRetries(client, 'map-change-one cq');
                const incomingFields = parseMapChangeOneBody(body);

                const isPveMap = incomingFields.w1 >= 9001 && incomingFields.w1 <= 9012;
                const isPvpMap = MAP_IDS_PVP.includes(incomingFields.w1);
                const isKnownMap = isPveMap || isPvpMap;
                if (isKnownMap) {
                    client.campaignMapCacheKey_ = incomingFields.w1;
                }

                if (isKnownMap) {
                    client.playRound_ = incomingFields.b5;

                    client.mapChangeOneTime_ = incomingFields.w2;
                    client.mapChangeOneRound_ = incomingFields.b5;
                    client.mapChangeOneKill_ = incomingFields.w6;
                    client.mapChangeOneGoal_ = incomingFields.w8;

                    const roomForMapUpdate = rooms.getRoomByAccount(Number(client.accountIndex_ || client.accountId_ || 1));
                    if (roomForMapUpdate) {
                        rooms.updateRoomMapSelection(roomForMapUpdate.id, {
                            mapId: incomingFields.w1,
                            playTime: incomingFields.w2,
                            playRound: incomingFields.b5,
                            mapChangeOneKill: incomingFields.w6,
                            mapChangeOneGoal: incomingFields.w8,
                        });
                    }
                }
                const outgoingFields = buildMapChangeOneSaFields(body, client);
                console.log(
                    `[ZGateGameDispatch] >> Room Map_Change_One_CQ ` +
                    `(b0=${incomingFields.b0}, w1=${incomingFields.w1}, w2=${incomingFields.w2}, ` +
                    `b5=${incomingFields.b5}, w6=${incomingFields.w6}, w8=${incomingFields.w8})`
                );
                const saHasSuccessHeader = true;
                const saBodySize = saHasSuccessHeader ? 0x10 : 0x0A;
                const saPayloadOffset = saHasSuccessHeader ? 0x06 : 0x00;
                const [msg, respBody] = getExactMessageBuffer(0x00220222, saBodySize);
                if (saHasSuccessHeader) {
                    respBody.writeUInt16LE(0, 0x00);
                    respBody.writeUInt32LE(0, 0x02);
                }
                writeMapChangeOneBody(respBody, outgoingFields, saPayloadOffset);
                client.send(msg);
                console.log(
                    `[ZGateGameDispatch] >> Sent Map_Change_One_SA 0x220222 ` +
                    `(mode=${MAP_CHANGE_ONE_SA_EXPERIMENT.mode}, bodySize=${saBodySize}, ` +
                    `b0=${outgoingFields.b0}, w1=${outgoingFields.w1}, w2=${outgoingFields.w2}, ` +
                    `b5=${outgoingFields.b5}, w6=${outgoingFields.w6}, w8=${outgoingFields.w8}, ` +
                    `hex=${respBody.toString('hex')})`
                );
                {
                    resendRoomMapOnly(client, 'after map-change-one cq');
                }

                {
                    const accountIdForBroadcast = Number(client.accountIndex_ || client.accountId_ || 1);
                    const roomForBroadcast = rooms.getRoomByAccount(accountIdForBroadcast);
                    if (roomForBroadcast && roomForBroadcast.hostAccountId === accountIdForBroadcast
                        && roomForBroadcast.members.size > 1) {
                        rooms.sendOthers(roomForBroadcast.id, accountIdForBroadcast, () => {
                            const [snMsg, snBody] = getExactMessageBuffer(0x00220223, 0x0A);
                            writeMapChangeOneBody(snBody, outgoingFields, 0);
                            return snMsg;
                        });
                        console.log(
                            `[ZGateGameDispatch] >> Broadcast Map_Change_One_SN 0x220223 to ` +
                            `${roomForBroadcast.members.size - 1} other room member(s) of Room #${roomForBroadcast.id} ` +
                            `(host=${accountIdForBroadcast})`
                        );
                    } else {
                        console.log(
                            `[ZGateGameDispatch] >> Skipped map-change broadcast (not host, no room, or no other members)`
                        );
                    }
                }
                return true;
            }

            case 0x00220234:
            {

                console.log(`[ZGateGameDispatch] >> 0x220234 (Leave_CQ): replying Leave_SA 0x220235`);
                const [msg, respBody] = client.getMessageBuffer(0x00220235, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);

                require('./room.dispatch').resetRoomSessionState(client);
                console.log(`[ZGateGameDispatch] >> Room state reset on Leave_CQ 0x220234`);

                leaveRoomAndNotify(Number(client.accountIndex_ || client.accountId_ || 1));
                setTimeout(() => {
                    try {
                        require('./room.dispatch').sendLobbyBootstrapAfterRoomLeave(client);
                    } catch (err) {
                        console.error(`[ZGateGameDispatch] >> Room leave lobby bootstrap error: ${err.message}`);
                    }
                }, 80);

                return true;
            }

            case 0x00220311:
            {
                const accountId = Number(client.accountIndex_ || client.accountId_ || 1);
                const room = rooms.getRoomByAccount(accountId);
                const member = room && room.members.get(accountId);
                const requestedTeam = body.length >= 2 ? body.readUInt16LE(0) : 0;
                const validTeamChange = !!room && !!member && rooms.isPvpRoom(room) && requestedTeam <= 1;

                if (validTeamChange) {
                    member.team = requestedTeam;
                    for (const roomMember of room.members.values()) {
                        if (roomMember.client) {
                            sendRoomUserPackets(roomMember.client, buildMemberUserCtx(member), getExactMessageBuffer, { includeMaster: false });
                        }
                    }
                }

                const [msg, respBody] = getExactMessageBuffer(0x00220312, 0x06);
                respBody.writeUint16LE(validTeamChange ? 0 : 1, 0x00);
                respBody.writeUint32LE(validTeamChange ? 0 : 1, 0x02);
                client.send(msg);
                console.log(`[ZGateGameDispatch] >> Team_Change_CQ 0x220311 (account=${accountId}, team=${requestedTeam}, ${validTeamChange ? 'updated' : 'rejected'})`);
                return true;
            }

            case 0x00220337:
            {

                const targetAccountId = body.length >= 2 ? body.readUInt16LE(0) : 0;
                const kickerAccountId = Number(client.accountIndex_ || client.accountId_ || 1);

                const sendKickoutSa = (ok) => {
                    const [msg, respBody] = getExactMessageBuffer(0x00220338, 0x06);
                    respBody.writeUInt16LE(ok ? 0 : 1, 0x00);
                    respBody.writeUInt32LE(ok ? 0 : 1, 0x02);
                    client.send(msg);
                    console.log(`[ZGateGameDispatch] >> Sent Kickout_SA 0x220338 (${ok ? 'success' : 'failure'}, kicker=${kickerAccountId}, target=${targetAccountId})`);
                };

                const room = rooms.getRoomByAccount(kickerAccountId);
                if (!room || room.hostAccountId !== kickerAccountId) {
                    console.log(`[ZGateGameDispatch] >> Kickout_CQ: account ${kickerAccountId} is not the host of any room, refusing`);
                    sendKickoutSa(false);
                    return true;
                }
                if (targetAccountId === kickerAccountId || !room.members.has(targetAccountId)) {
                    console.log(`[ZGateGameDispatch] >> Kickout_CQ: target ${targetAccountId} is not a kickable member of room #${room.id}`);
                    sendKickoutSa(false);
                    return true;
                }

                const targetClient = room.members.get(targetAccountId).client;

                sendKickoutSa(true);

                if (targetClient) {
                    const [leaveMsg, leaveBody] = getExactMessageBuffer(0x00220236, 0x03);
                    leaveBody.writeUInt16LE(targetAccountId, 0x00);
                    leaveBody.writeUInt8(1, 0x02);
                    targetClient.send(leaveMsg);

                    require('./room.dispatch').resetRoomSessionState(targetClient);
                }
                console.log(`[ZGateGameDispatch] >> Kickout_CQ: host ${kickerAccountId} kicked account ${targetAccountId} from room #${room.id}`);

                leaveRoomAndNotify(targetAccountId, { kickout: true });

                return true;
            }

            case CQ_ROOM_NAME_CHANGE:
            {

                const accountId = Number(client.accountIndex_ || client.accountId_ || 1);

                const requestedName = decodeAnsiBytes(body.subarray(0, Math.min(body.length, 25)));

                const sendNameChangeSa = (ok, name) => {
                    const [msg, respBody] = getExactMessageBuffer(SA_ROOM_NAME_CHANGE, 0x06);
                    respBody.writeUInt16LE(ok ? 0 : 1, 0x00);
                    respBody.writeUInt32LE(ok ? 0 : 1, 0x02);
                    client.send(msg);
                    console.log(`[ZGateGameDispatch] >> Sent Name_Change_SA 0x220219 (${ok ? 'success' : 'failure'}, account=${accountId}${ok ? `, name="${name}"` : ''})`);
                };

                const room = rooms.getRoomByAccount(accountId);
                if (!room || room.hostAccountId !== accountId) {
                    console.log(`[ZGateGameDispatch] >> Name_Change_CQ: account ${accountId} is not the host of any room, refusing`);
                    sendNameChangeSa(false);
                    return true;
                }
                if (!requestedName) {
                    console.log(`[ZGateGameDispatch] >> Name_Change_CQ: empty name from account ${accountId}, refusing`);
                    sendNameChangeSa(false);
                    return true;
                }

                room.name = requestedName;
                client.roomName_ = requestedName;
                sendNameChangeSa(true, requestedName);

                for (const member of room.members.values()) {
                    if (!member.client) continue;
                    sendRoomNameOnly(member.client, requestedName, getExactMessageBuffer);
                }
                console.log(`[ZGateGameDispatch] >> Broadcast Room_Name_SN 0x22021A to room #${room.id} (${room.members.size} member(s)) [rename]`);

                {
                    broadcastRoomListChange(rooms.getLobbyClients(), room, 2, getExactMessageBuffer);
                    console.log(`[ZGateGameDispatch] >> Broadcast room #${room.id} name change to the lobby`);
                }

                return true;
            }

            case 0x00220211:
            {
                const accountId = Number(client.accountIndex_ || client.accountId_ || 1);
                const room = rooms.getRoomByAccount(accountId);
                const requestedMaxPlayers = body.length > 0 ? body.readUInt8(0) : 0;
                const isPvpRoom = rooms.isPvpRoom(room);
                const validSize = [8, 16, 24, 32].includes(requestedMaxPlayers);
                const ok = isPvpRoom && room.hostAccountId === accountId && validSize && requestedMaxPlayers >= room.members.size;
                const [msg, respBody] = getExactMessageBuffer(0x00220212, 0x06);
                respBody.writeUint16LE(ok ? 0 : 1, 0x00);
                respBody.writeUint32LE(ok ? 0 : 1, 0x02);
                client.send(msg);
                if (!ok) {
                    console.log(`[ZGateGameDispatch] >> MaxUser_Change_CQ rejected (room=${!!room}, pvp=${isPvpRoom}, host=${!!room && room.hostAccountId === accountId}, requested=${requestedMaxPlayers}, members=${room ? room.members.size : 0})`);
                    return true;
                }

                room.maxPlayers = requestedMaxPlayers;
                room.maxPlayersWire = (requestedMaxPlayers / 2) - 1;
                for (const member of room.members.values()) {
                    if (!member.client) continue;
                    member.client.maxPlayers_ = room.maxPlayers;
                    member.client.maxPlayersWire_ = room.maxPlayersWire;
                    sendRoomStatePackets(member.client, buildRoomCtxFromRoom(room, member.accountId), getExactMessageBuffer);
                }
                broadcastRoomListChange(rooms.getLobbyClients(), room, 2, getExactMessageBuffer);
                console.log(`[ZGateGameDispatch] >> Updated room #${room.id} capacity (max=${room.maxPlayers}, size=${room.maxPlayersWire})`);
                return true;
            }

            // ==========================================
            // Room Option Change CQ
            // ==========================================
            case 0x00220215:
            {
                console.log(`[ZGateGameDispatch] >> Room Option_Change_CQ`);
                const accountId = Number(client.accountIndex_ || client.accountId_ || 1);
                const room = rooms.getRoomByAccount(accountId);
                const ok = !!room && room.hostAccountId === accountId && body.length >= 3;
                const [msg, respBody] = getExactMessageBuffer(0x00220216, 0x06);
                respBody.writeUint16LE(ok ? 0 : 1, 0x00);
                respBody.writeUint32LE(ok ? 0 : 1, 0x02);
                client.send(msg);
                if (!ok) {
                    console.log(`[ZGateGameDispatch] >> Option_Change_CQ rejected (room=${!!room}, host=${!!room && room.hostAccountId === accountId}, body=${body.length})`);
                    return true;
                }

                room.options.balance = body[1] !== 0;
                room.options.intrude = body[2] !== 0;
                for (const member of room.members.values()) {
                    if (member.client) sendRoomOptionOnly(member.client, room.options, getExactMessageBuffer);
                }
                console.log(`[ZGateGameDispatch] >> Stored and broadcast room options (balance=${room.options.balance}, intrude=${room.options.intrude}) in room #${room.id}`);
                return true;

            }

            case 0x00220505:
            case 0x00220503:
            {
                const accountId = Number(client.accountIndex_ || client.accountId_ || 1);

                const chatModeForType = (type === 0x00220505) ? "enabled" : "disabled";
                const room = (chatModeForType === 'enabled') ? rooms.getRoomByAccount(accountId) : undefined;

                if (!room) {

                    const [msg, respBody] = client.getMessageBuffer(type + 1, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                    return true;
                }

                const channelName = (type === 0x00220505) ? 'All' : 'Team';
                const textPreview = body.length > 2 ? body.subarray(2).toString('latin1').split('\0')[0] : '';
                console.log(`[ZGateGameDispatch] >> Room chat ${channelName} (0x${type.toString(16).padStart(8, '0')}): "${textPreview}" (${body.length} bytes)`);

                if (type === 0x00220505) {

                    rooms.sendAll(room.id, () => {
                        const [msg, respBody] = getExactMessageBuffer(type, body.length);
                        body.copy(respBody);
                        return msg;
                    });
                } else {

                    const sender = room.members.get(accountId);
                    const senderTeam = sender ? sender.team : 0;
                    for (const member of room.members.values()) {
                        if (member.team !== senderTeam) continue;
                        if (!member.client) continue;
                        const [msg, respBody] = getExactMessageBuffer(type, body.length);
                        body.copy(respBody);
                        member.client.send(msg);
                    }
                }
                return true;
            }

            case 0x00220507:
            case 0x00220509:
            {

                const channelName = (type === 0x00220507) ? 'Team' : 'All';
                const textPreview = body.length > 2 ? body.subarray(2).toString('latin1').split('\0')[0] : '';
                console.log(`[ZGateGameDispatch] >> In-game chat ${channelName} (0x${type.toString(16).padStart(8, '0')}): "${textPreview}" (${body.length} bytes)`);

                const [msg, respBody] = getExactMessageBuffer(type, body.length);
                body.copy(respBody);
                client.send(msg);
                return true;
            }

            default:
            {
                //Respond to unhandled CQ messages
                if (type % 2 === 1) {
                    const responseType = type + 1;
                    console.log(`[ZGateGameDispatch] >> Auto-responding with 0x${responseType.toString(16).padStart(8, '0')}`);
                    const [msg, respBody] = client.getMessageBuffer(responseType, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                }
                return true;
            }
        }
    }
};

module.exports.getGameInfoRound = getGameInfoRound;

module.exports.sendReadyHostSnToRoomMember = sendReadyHostSnToRoomMember;

module.exports.buildReadyHostSnMsg = buildReadyHostSnMsg;
