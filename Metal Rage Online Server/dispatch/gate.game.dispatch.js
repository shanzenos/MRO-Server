const NetworkClient = require("../client");

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
const MAP_CHANGE_ONE_RESEND_MODE = 'map_only'; // 'full_room' | 'map_only' | 'none'
const GAME_START_HANDSHAKE_MODE = 'ready_then_start'; // 'start_only' | 'ready_then_start'
const READY_HOST_GATE_PRIME_MODE = 'enabled'; // 'disabled' | 'enabled'
const GAME_WAIT_SN_EXPERIMENT_MODE = 'enabled'; // 'disabled' | 'enabled'
const POST_GAME_WAIT_READY_HOST_MODE = 'enabled'; // 'disabled' | 'enabled'
const GAME_INFO_SN_EXPERIMENT_MODE = 'enabled'; // 'disabled' | 'enabled'

let nextRoomIndex = 1;

// 0x220221 / 0x220222 experimental body layout (10 bytes total).
// We do not know the real semantics yet, so keep these as offset-based fields:
//   [0]    = b0
//   [1..2] = w1
//   [3..4] = w2
//   [5]    = b5
//   [6..7] = w6
//   [8..9] = w8
//
// Change only one field at a time while testing difficulty buttons.
const MAP_CHANGE_ONE_SA_EXPERIMENT = {
    mode: 'manual',  // SA에 현재 선택된 맵 캐시키를 반환
    manual: {
        b0: 0,
        w1: 'current_cache',  // CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID[mapId]로 resolve됨
        w2: 0,
        b5: 0,
        w6: 0,
        w8: 0,
    },
};
// Cache.Bin에서 추출한 맵 인덱스 매핑
// map_id(DB) → cacheIndex(Cache.Bin)
const CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID = {
    0: 1,   // Map_Ptuto  (튜토리얼)
    1: 8,   // Map_C01
    2: 34,  // Map_C02
    3: 83,  // Map_C03
    4: 32,  // Map_C04
    5: 58, // Map_PC01 (캠페인 기본 - Map_C05는 클라이언트에 없음)
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

function sendReadyHostSn(client)
{
    const ip = normalizeIpv4(client.socket_ && client.socket_.localAddress);
    const port = 30907;
    const mapCacheKey = Number(client.campaignMapCacheKey_) || 58;
    const mapName = CACHE_INDEX_TO_MAP_NAME_GG[mapCacheKey] || 'Map_PC01';
    // 실제 서버: IP:Port/MapName?team=0 형식으로 ClientTravel
    // ip 필드에 "IP/MapName" 형식으로 전달 시도
    const ipWithMap = ip + '/' + mapName;
    const [msg, respBody] = getExactMessageBuffer(0x00420115, 0x13);
    respBody.writeUInt16LE(port, 0x00);
    respBody.writeUInt8(0, 0x02);
    respBody.write(ipWithMap + '\0', 0x03, Math.min(Buffer.byteLength(ipWithMap) + 1, 0x10), 'ascii');
    client.send(msg);
    console.log(`[ZGateGameDispatch] >> Sent Ready_Host_SN 0x00420115 ip=${ipWithMap} port=${port}`);
}

function sendRoomGameWaitSn(client, tag)
{
    const [msg] = getExactMessageBuffer(0x00420111, 0x00);
    client.send(msg);
    console.log(`[ZGateGameDispatch] >> Sent Game_Wait_SN 0x00420111 [${tag}]`);
}

function sendGameInfoSn(client, tag)
{
    const BODY_SIZE = 0x1A;
    const [msg, body] = getExactMessageBuffer(0x00222111, BODY_SIZE);

    const mapId = Number(client.campaignMapCacheKey_ || CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID[client.mapId_] || client.mapId_ || 58) & 0xFFFF;  // Cache.Bin 인덱스로 전송
    const userIndex = Number(client.accountIndex_ || client.accountId_ || 1) & 0xFFFF;
    const battleIndex = 1;
    const redTeamIndex = 1;
    const blueTeamIndex = 0;
    const clanFlag = 0;
    const quarterIndex = 1;

    // Experimental Game_Info_SN body.
    // Confirmed fields exist, but semantics are still partial.
    // Static analysis shows:
    //   packet+0x10 -> logged as Battle
    //   packet+0x14 -> logged as RedTeamIndex
    //   packet+0x16 -> logged as BlueTeamIndex
    //   packet+0x1E -> logged as Clan
    //   packet+0x1F -> compared with 2, logged as a boolean-like Quarter flag
    // Keep map and player hints in later fields until their exact semantics are
    // confirmed, so we do not poison team/map selection again.
    body.writeUInt32LE(battleIndex, 0x00);      // packet+0x10 Battle
    body.writeUInt16LE(redTeamIndex, 0x04);     // packet+0x14 RedTeamIndex
    body.writeUInt16LE(blueTeamIndex, 0x06);    // packet+0x16 BlueTeamIndex
    body.writeUInt16LE(mapId, 0x0A);            // packet+0x1A candidate map/battle field
    body.writeUInt16LE(0, 0x0C);                // packet+0x1C candidate mode/round field
    body.writeUInt8(clanFlag, 0x0E);            // packet+0x1E Clan
    body.writeUInt16LE(2, 0x0F);                // packet+0x1F confirmed == 2 check
    body.writeUInt16LE(userIndex, 0x11);        // packet+0x21 user/account hint
    body.writeUInt16LE(quarterIndex, 0x13);     // packet+0x23 candidate quarter/round index
    body.writeUInt8(0, 0x15);                   // packet+0x25 candidate flag
    body.writeUInt16LE(0, 0x16);                // packet+0x26 candidate field
    body.writeUInt16LE(0, 0x18);                // packet+0x28 candidate field

    client.send(msg);
    console.log(
        `[ZGateGameDispatch] >> Sent Game_Info_SN 0x00222111 [${tag}] ` +
        `(battle=${battleIndex}, red=${redTeamIndex}, blue=${blueTeamIndex}, map=${mapId}, clan=${clanFlag}, user=${userIndex}, quarter=${quarterIndex}, body=${body.toString('hex')})`
    );
}

function scheduleGameWaitSnExperiment(client)
{
    if (GAME_WAIT_SN_EXPERIMENT_MODE !== 'enabled') {
        return;
    }
    if (!client.campaignStarted_) {
        console.log(`[ZGateGameDispatch] >> Skipped Game_Wait_SN experiment (campaignStarted_=false)`);
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
    if (POST_GAME_WAIT_READY_HOST_MODE !== 'enabled') {
        return;
    }
    if (!client.campaignStarted_) {
        console.log(`[ZGateGameDispatch] >> Skipped post-Game_Wait Ready_Host (campaignStarted_=false)`);
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
    if (GAME_INFO_SN_EXPERIMENT_MODE !== 'enabled') {
        return;
    }
    if (!client.campaignStarted_) {
        console.log(`[ZGateGameDispatch] >> Skipped Game_Info_SN experiment (campaignStarted_=false)`);
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
    if (READY_HOST_GATE_PRIME_MODE !== 'enabled') {
        return;
    }
    if (!client.campaignStarted_) {
        console.log(`[ZGateGameDispatch] >> Skipped Ready_Host prime (campaignStarted_=false)`);
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

function writeMapChangeOneBody(body, fields)
{
    body.writeUInt8(fields.b0 & 0xFF, 0);
    body.writeUInt16LE(fields.w1 & 0xFFFF, 1);
    body.writeUInt16LE(fields.w2 & 0xFFFF, 3);
    body.writeUInt8(fields.b5 & 0xFF, 5);
    body.writeUInt16LE(fields.w6 & 0xFFFF, 6);
    body.writeUInt16LE(fields.w8 & 0xFFFF, 8);
}

function buildMapChangeOneSaFields(body, client)
{
    const incoming = parseMapChangeOneBody(body);
    if (MAP_CHANGE_ONE_SA_EXPERIMENT.mode === 'echo') {
        return incoming;
    }
    if (MAP_CHANGE_ONE_SA_EXPERIMENT.mode === 'manual') {
        return {
            rawHex: null,
            b0: resolveExperimentValue(MAP_CHANGE_ONE_SA_EXPERIMENT.manual.b0, client),
            w1: resolveExperimentValue(MAP_CHANGE_ONE_SA_EXPERIMENT.manual.w1, client),
            w2: resolveExperimentValue(MAP_CHANGE_ONE_SA_EXPERIMENT.manual.w2, client),
            b5: resolveExperimentValue(MAP_CHANGE_ONE_SA_EXPERIMENT.manual.b5, client),
            w6: resolveExperimentValue(MAP_CHANGE_ONE_SA_EXPERIMENT.manual.w6, client),
            w8: resolveExperimentValue(MAP_CHANGE_ONE_SA_EXPERIMENT.manual.w8, client),
        };
    }
    return {
        rawHex: null,
        b0: 0,
        w1: 0,
        w2: 0,
        b5: 0,
        w6: 0,
        w8: 0,
    };
}

function resendRoomState(client, tag)
{
    try {
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
        if (!client.isTrueCampaign_) {
            console.log(`[ZGateGameDispatch] >> Skipped map-only resend [${tag}] (not true campaign room)`);
            return;
        }

        const { sendRoomMapPackets, sendCampaignBootstrap } = require('./room/room-map.sender');
        // sendRoomState와 동일한 맵 목록 사용 (CAMPAIGN_MAP_ALL_HINTS)
        const campaignMapAllHints = [8, 37, 30, 34, 43, 6, 2, 26, 36, 43, 16, 24, 45, 47, 49, 14, 10, 22, 52, 30, 18];
        const roomDefaultEntryHints = [8, 37, 30, 34, 6, 2];
        const mapId = client.createdMapId_ || client.mapId_ || 1;
        const campaignMapCacheKey = client.campaignMapCacheKey_ || CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID[mapId] || 8;
        const ctx = {
            campaignMapCacheKey,
            roomDefaultEntryHints,
            campaignMapHints: campaignMapAllHints,
        };
        sendRoomMapPackets(client, ctx, getExactMessageBuffer);
        sendCampaignBootstrap(client, getExactMessageBuffer);
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

                const roomIndex = nextRoomIndex++;
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
                    ? body.subarray(14, Math.min(body.length, 39)).toString('ascii').split('\0').shift()
                    : '';
                const roomName = rawName || `${nickname}`;
                const hasPassword = body.length > 39 ? body[39] : 0;
                const roomPassword = hasPassword
                    ? body.subarray(40, Math.min(body.length, 51)).toString('ascii').split('\0').shift()
                    : '';
                // isCampaignLike: roomType 1(캠페인)과 2(PvP) 모두 최대 8명 슬롯 유지용
                const isCampaignLike = (roomType === 1) || (roomType === 2) || (gameMode === 4 || gameMode === 5);
                const effectiveRoomType = isCampaignLike ? 2 : roomType;
                const maxPlayers = isCampaignLike
                    ? 8
                    : Math.min(Math.max(roomNumberValue || 1, 1), 8);
                // isTrueCampaign: 실제 캠페인 방 여부 (PvP는 false)
                const isTrueCampaign = (roomType === 1) || (gameMode === 4 || gameMode === 5);

                console.log(`[ZGateGameDispatch] >> Creating room #${roomIndex} (type=${roomType}->${effectiveRoomType}, map=${mapId}, opt1=0x${createWord1.toString(16)}, opt2=0x${createWord2.toString(16)}, max=${maxPlayers}, mode=${gameMode}, valueFlag=${roomNumberFlag}, value=${roomNumberValue}) for "${nickname}"`);

                // Store room info on client for other dispatchers to reference
                client.createdRoomIndex_ = roomIndex;
                client.roomIndex_ = enterRoomIndex;
                client.roomType_ = effectiveRoomType;
                client.rawRoomType_ = roomType;
                client.mapId_ = mapId;
                client.createByte1_ = createByte1;
                client.createWord1_ = createWord1;
                client.createWord2_ = createWord2;
                client.createWord3_ = createWord3;
                client.createWord4_ = createWord4;
                client.roomNumberFlag_ = roomNumberFlag;
                client.roomNumberValue_ = roomNumberValue;
                client.roomName_ = roomName;
                client.roomPassword_ = roomPassword;
                client.maxPlayers_ = maxPlayers;
                client.gameMode_ = gameMode;
                client.mapSeed_ = (createWord2 << 16) | createWord1;
                client.campaignRoom_ = isCampaignLike;
                client.isTrueCampaign_ = isTrueCampaign;  // 실제 캠페인 여부 (PvP=false)
                client.createdMapId_ = mapId;
                client.campaignMapCacheKey_ = CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID[mapId] || 8;
                client.readyHostHandshakeSent_ = false;
                client.gameUserBootstrapSent_ = false;
                client.waitingGameInfoExperimentSent_ = false;
                client.gameWaitExperimentSent_ = false;
                client.postGameWaitReadyHostSent_ = false;

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
                    respBody.write(roomName + '\0', 0x0E, Math.min(Buffer.byteLength(roomName) + 1, 0x19), 'ascii');
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
                        } catch (err) {
                            console.error(`[ZGateGameDispatch] >> Error sending room state:`, err.message);
                        }
                    }, delay);
                    client.roomStateRetryTimers_.push(timer);
                };
                sendRoomStateDelayed(350, 'delayed');
                sendRoomStateDelayed(1200, 'retry after scene change');
                sendRoomStateDelayed(2500, 'late room scene retry');
                sendRoomStateDelayed(5000, 'final room scene retry');

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
            // Room Enter CN (씬 로드 완료 알림)
            // 클라이언트가 방 씬 로드 후 반복 전송 — 방 상태 재전송으로 응답
            // ==========================================
            case 0x00222101:
            {
                console.log(`[ZGateGameDispatch] >> Room Enter CN (0x00222101) — ACK only`);
                sendOkSa(client, 0x00222102, 'Room_Enter_SN');
                // 최초 1회만 방 상태 재전송, 이후는 ACK만
                if (!client.roomEnterAcked_) {
                    client.roomEnterAcked_ = true;
                    resendRoomState(client, 'room-enter cn (first)');
                }
                return true;
            }

            // ==========================================
            // Room Game Start CQ
            // ==========================================
            case 0x00222103:
            {
                // Static analysis confirms both Game_Ready_SN (0x222102) and
                // Game_Start_SN (0x222104) consume the same simple SA body and
                // emit NETWORK_ROOM_GAME_READY. Current runtime only sending
                // 0x222104 did not progress beyond that point, so keep a narrow
                // experiment that can also send 0x222102 first.
                console.log(`[ZGateGameDispatch] >> Room Game_Start_CQ`);
                clearPendingRoomStateRetries(client, 'game-start cq');
                client.gameStarted_ = true;
                client.campaignStarted_ = (Number(client.rawRoomType_) === 1) ||
                    (Number(client.gameMode_) === 4 || Number(client.gameMode_) === 5);
                console.log(`[ZGateGameDispatch] >> Armed gameStarted_=${client.gameStarted_} campaignStarted_=${client.campaignStarted_}`);
                if (READY_HOST_GATE_PRIME_MODE === 'enabled' && client.campaignStarted_) {
                    sendReadyHostSq(client);
                }
                // Game_Info_SN을 먼저 보내고, 그 다음 Game_Ready_SN + Game_Start_SN
                // 클라이언트가 Game_Info_SN의 mapId를 읽어서 ClientTravel 대상 맵을 결정하기 때문
                scheduleGameInfoSnExperiment(client);
                setTimeout(() => {
                    if (GAME_START_HANDSHAKE_MODE === 'ready_then_start') {
                        sendOkSa(client, 0x00222102, 'Game_Ready_SN');
                        setTimeout(() => {
                            sendOkSa(client, 0x00222104, 'Game_Start_SN');
                            primeReadyHostHandshake(client);
                            scheduleGameWaitSnExperiment(client);
                            schedulePostGameWaitReadyHost(client);
                        }, 100);
                    } else {
                        sendOkSa(client, 0x00222104, 'Game_Start_SN');
                        primeReadyHostHandshake(client);
                        scheduleGameWaitSnExperiment(client);
                        schedulePostGameWaitReadyHost(client);
                    }
                }, 400); // Game_Info_SN 전송 후 400ms 대기
                return true;
            }

            // ==========================================
            // Room Map Change One CQ
            // ==========================================
            case 0x00220221:
            {
                clearPendingRoomStateRetries(client, 'map-change-one cq');
                // Static analysis for ZDispatchRoom::Map_Change_One_CQ/SA shows
                // the SA uses a 0x1A packet (0x0A body), not the generic 6-byte OK.
                // When the body begins with zeroed status fields, the client-side
                // SA path falls back to its retained room-map state and proceeds.
                const incomingFields = parseMapChangeOneBody(body);
                const outgoingFields = buildMapChangeOneSaFields(body, client);
                console.log(
                    `[ZGateGameDispatch] >> Room Map_Change_One_CQ ` +
                    `(b0=${incomingFields.b0}, w1=${incomingFields.w1}, w2=${incomingFields.w2}, ` +
                    `b5=${incomingFields.b5}, w6=${incomingFields.w6}, w8=${incomingFields.w8})`
                );
                const [msg, respBody] = getExactMessageBuffer(0x00220222, 0x0A);
                writeMapChangeOneBody(respBody, outgoingFields);
                client.send(msg);
                console.log(
                    `[ZGateGameDispatch] >> Sent Map_Change_One_SA 0x220222 ` +
                    `(mode=${MAP_CHANGE_ONE_SA_EXPERIMENT.mode}, ` +
                    `b0=${outgoingFields.b0}, w1=${outgoingFields.w1}, w2=${outgoingFields.w2}, ` +
                    `b5=${outgoingFields.b5}, w6=${outgoingFields.w6}, w8=${outgoingFields.w8}, ` +
                    `hex=${respBody.toString('hex')})`
                );
                if (MAP_CHANGE_ONE_RESEND_MODE === 'full_room') {
                    resendRoomState(client, 'after map-change-one cq');
                } else if (MAP_CHANGE_ONE_RESEND_MODE === 'map_only') {
                    resendRoomMapOnly(client, 'after map-change-one cq');
                } else {
                    console.log(`[ZGateGameDispatch] >> Skipped resend after map-change-one cq (mode=${MAP_CHANGE_ONE_RESEND_MODE})`);
                }
                return true;
            }

            // ==========================================
            // Room Option Change CQ
            // ==========================================
            case 0x00220215:
            {
                console.log(`[ZGateGameDispatch] >> Room Option_Change_CQ`);
                const [msg, respBody] = getExactMessageBuffer(0x00220216, 0x06);
                respBody.writeUint16LE(0, 0x00);
                respBody.writeUint32LE(0, 0x02);
                client.send(msg);
                console.log(`[ZGateGameDispatch] >> Sent Option_Change_SA 0x220216 (status=0, result=0)`);
                resendRoomState(client, 'after option-change cq');
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
