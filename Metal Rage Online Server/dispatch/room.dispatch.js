const NetworkClient = require("../client");
const db = require('../database/db');
const ZCommunityDispatch = require('./community.dispatch');
const { sendRoomStatePackets } = require('./room/room-state.sender');
const { sendRoomUserPackets } = require('./room/room-user.sender');
const { sendRoomMapPackets, sendCampaignBootstrap } = require('./room/room-map.sender');
const { sendGameUserBootstrap } = require('./room/room-game-user.sender');
const { MAX_SLOT_COUNT } = require('../datatypes/enums');
const fs = require('fs');
const path = require('path');

// ZDispatchRoom - Handles room operations
//
// Confirmed message ID range: 0x00240101 through 0x00240711 (70 IDs total)
// All 0x24XXXX messages belong to this dispatch.
//
// Known methods from ZNetwork.dll strings:
//   Game_Ready_CN/SN, Game_Start_CN/SN, Game_Wait_SN
//   Leave_CQ/SA/SN, Leave_Timeout_CQ, Kickout_CQ/SA
//   Team_Change_CQ/SA/SN, Team_Change_All_SN
//   Map_Change_All_CQ/SA/SN, Map_Change_One_CQ/SA/SN
//   Master_Change_CQ/SA, Name_Change_CQ/SA, Password_Change_CQ/SA
//   Option_Change_CQ/SA, MaxUser_Change_CQ/SA
//   Matching_Start_CN/SN, Matching_Break_CN/SN, Matching_Complete_SN
//   Invite_Open_CQ/SA, Invite_User_Default_SN, Invite_User_Clan_SN
//   Room_Default_SN, Room_Boundary_SN, Room_Name_SN, Room_Option_SN, Room_State_SN
//   User_Default_SN, User_Master_SN, User_Name_SN, User_State_SN
//   User_Score_SN, User_Pilot_SN, User_Levelup_SN
//   Reward_Coupon_SN, Reward_Record_User_SN, Reward_Record_Mech_SN
//   Reward_Levelup_User_SN, Reward_Levelup_Mech_SN, Reward_FirstReceiveExp_User_SN
//   Rotate_Next_SN, Rotate_Stop_CQ/SA/SN
//
// Message ID mapping:
//   0x240101/02 = Enter_CQ/SA (or Room_Info request)
//   0x240103/04 = Member_List or Room_Detail
//   0x240111/12 = Leave_CQ/SA
//   0x240201/02 = Game_Ready_CN/SN
//   0x240301/02 = Game_Start_CN/SN
//   0x240501    = Room_Default_SN
//   0x240509    = Room_State_SN
//   0x240601    = User_Default_SN
//   0x240603    = User_Master_SN

// Room SN opcodes are routed by ZDispatchRoom's switch in znetwork.
// These are not the 0x2405xx/0x2406xx descriptor/opcode-array values:
//   0x220203 Room_Default_SN
//   0x220213 Room_Boundary_SN
//   0x220214 Room_State_SN
//   0x220217 Room_Option_SN
//   0x22021A Room_Name_SN
//   0x220233 User_Default_SN
//   0x220319 User_Master_SN
//   0x220401 User_State_SN
//   0x220402 User_Pilot_SN
//   0x220421 User_Name_SN
// Hangar package opcodes are mapped through the client SN dispatch table:
// 0x240131 Packege_Item_SN, 0x240132 Packege_Point_SN, 0x240133 Packege_Coupon_SN.
// The 0x2405xx descriptors exist elsewhere, but the received SN dispatcher
// does not route 0x240521 to Packege_Item_SN.
// Valid User SN IDs: 0x240601, 0x240602, 0x240603, 0x240611, 0x240612, ...
const SN_ROOM_DEFAULT  = 0x00220203;
const SN_ROOM_BOUNDARY = 0x00220213;
const SN_ROOM_STATE    = 0x00220214;
const SN_ROOM_OPTION   = 0x00220217;
const SN_ROOM_NAME     = 0x0022021A;
const SN_MAP_CHANGE_ALL = 0x00220226;
const SN_MAP_CHANGE_ONE = 0x00220223;
const SN_CAMPAIGN      = 0x0023013A;
const SN_USER_DEFAULT  = 0x00220233;
const SN_USER_STATE    = 0x00220401;
const SN_USER_MASTER   = 0x00220319;
const SN_USER_NAME     = 0x00220421;
const SN_USER_PILOT    = 0x00220402;
const SN_ITEM_INFO     = 0x00210111;
const SN_WEAR_INFO     = 0x00210113;
const SN_PACKAGE_ITEM  = 0x00240131;
const SN_PACKAGE_POINT = 0x00240132;
const SN_PACKAGE_COUPON = 0x00240133;
const SN_SHOP_LIST     = 0x00240241;
const SN_CASH_SHOP     = 0x00240242;
const HANGAR_POINT_BALANCE = 100000;
const HANGAR_COUPON_BALANCE = 1000;
// Cache.Bin inspection:
//   entry 6  -> Map_C06
//   entry 8  -> Map_C01
//   entry 30 -> Map_C03
//   entry 34 -> Map_C04
//   entry 37 -> Map_C02
//   entry 43 -> Map_C05
// Campaign room map packets and Room_Default_SN map-entry tables should use
// cache-entry indexes, not body/item cache indexes.
const CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID = {
    1: 8,   // Map_C01
    2: 37,  // Map_C02
    3: 30,  // Map_C03
    4: 34,  // Map_C04
    5: 58,  // Map_PC01 (C05 대응)
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
// Campaign map cache indices for SN_MAP_CHANGE_ALL (campaign-only, no PvP PC-maps)
const CAMPAIGN_MAP_ALL_HINTS = [8, 37, 30, 34, 43, 6, 2, 26, 36, 43, 16, 24, 45, 47, 49, 14, 10, 22, 52, 30, 18];
const ROOM_DEFAULT_ENTRY_HINTS = [8, 37, 30, 34, 6, 2]; // mech slot entries for SN_ROOM_DEFAULT
const CAMPAIGN_GAME_USER_BOOTSTRAP_MODE = 'enabled'; // 'disabled' | 'enabled'
const CACHE_INDEX_BY_ITEM_ID = loadCacheIndexByItemId();

function loadCacheIndexByItemId() {
    const map = {};
    try {
        // Cache.Bin 탐색: 상위 디렉토리 순회 + 절대경로 폴백
        let cachePath = null;
        // 1. __dirname 기준 상위 10단계까지 탐색
        let searchDir = __dirname;
        for (let i = 0; i < 10; i++) {
            const parent = path.dirname(searchDir);
            if (parent === searchDir) break; // 루트 도달
            searchDir = parent;
            const candidate = path.join(searchDir, 'MetalRage', 'Data', 'System', 'Cache.Bin');
            if (fs.existsSync(candidate)) { cachePath = candidate; break; }
        }
        // 2. process.cwd() 기준도 탐색
        if (!cachePath) {
            let cwdDir = process.cwd();
            for (let i = 0; i < 10; i++) {
                const candidate = path.join(cwdDir, 'MetalRage', 'Data', 'System', 'Cache.Bin');
                if (fs.existsSync(candidate)) { cachePath = candidate; break; }
                const parent = path.dirname(cwdDir);
                if (parent === cwdDir) break;
                cwdDir = parent;
            }
        }
        if (!cachePath) cachePath = path.resolve(__dirname, '..', '..', 'MetalRage', 'Data', 'System', 'Cache.Bin');
        // Desktop 직접 경로 추가
        if (!cachePath || !fs.existsSync(cachePath)) {
            const homeDir = require("os").homedir();
            const desktopCand = path.join(homeDir, "Desktop", "MetalRage", "Data", "System", "Cache.Bin");
            if (fs.existsSync(desktopCand)) cachePath = desktopCand;
        }
        console.log();
        const bytes = fs.readFileSync(cachePath);
        const headerSize = 82;
        const entrySize = 103;
        const itemIdOffset = 96;
        for (let i = 0; headerSize + (i * entrySize) + itemIdOffset + 4 <= bytes.length; i++) {
            const itemId = bytes.readInt32LE(headerSize + (i * entrySize) + itemIdOffset);
            if (itemId > 0 && map[itemId] == null) {
                map[itemId] = i;
            }
        }
        console.log(`[ZRoomDispatch] Loaded ${Object.keys(map).length} Cache.Bin item indexes`);
    } catch (err) {
        console.warn(`[ZRoomDispatch] Cache.Bin index load failed: ${err.message}`);
    }
    return map;
}

function getExactMessageBuffer(type, bodySize) {
    const msg = Buffer.alloc(0x10 + bodySize);
    msg.writeUint16BE(msg.length, 0x6);
    msg.writeUint32BE(type, 0xC);
    return [msg, msg.subarray(0x10)];
}

function resetRoomSessionState(client) {
    client.roomIndex_ = 0;
    client.createdRoomIndex_ = null;
    client.roomType_ = 0;
    client.rawRoomType_ = 0;
    client.mapId_ = 0;
    client.createdMapId_ = 0;
    client.maxPlayers_ = 0;
    client.gameMode_ = 0;
    client.campaignRoom_ = false;
    client.campaignStarted_ = false;
    client.gameStarted_ = false;
    client.readyHostHandshakeSent_ = false;
    client.gameUserBootstrapSent_ = false;
    client.waitingGameInfoExperimentSent_ = false;
}

function sendLobbyBootstrapAfterRoomLeave(client) {
    // Same connection stays alive when returning from room to lobby, so push the
    // minimal lobby-enter success + empty room list that the client already accepts
    // during game login / lobby refresh.
    {
        const [msg, respBody] = getExactMessageBuffer(0x00230112, 0x6);
        respBody.writeUint16LE(0x0000, 0);
        respBody.writeUint32LE(0x0000, 2);
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent Lobby Enter SA 0x230112 after room leave`);
    }

    {
        const [msg, body] = getExactMessageBuffer(0x00230103, 0x4);
        body.writeUint8(0, 0);
        body.writeUint8(0, 1);
        body.writeUint16LE(0, 2);
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent Lobby Room_List_SN 0x230103 after room leave`);
    }
}

function writeShopListBody(body, shopItems, currencyCode) {
    const ENTRY_SIZE = 20;
    body.writeUint8(1, 0);
    body.writeUint8(0, 1);
    body.writeUint8(shopItems.length, 2);

    for (let i = 0; i < shopItems.length; i++) {
        const off = 3 + i * ENTRY_SIZE;
        const { item, index } = shopItems[i];
        const gold = catalogGoldPrice(item);
        const discRaw = Number(item.discount_price);
        const disc = (Number.isFinite(discRaw) && discRaw > 0) ? (discRaw >>> 0) : gold;
        const itemId = Number(item.item_id) || 0;
        const itemIndex = itemId;
        const isShow = 1;
        const isNew = item.is_new == null ? 0 : (Number(item.is_new) ? 1 : 0);
        const isHot = item.is_hot == null ? 0 : (Number(item.is_hot) ? 1 : 0);

        body.writeInt32LE(itemIndex, off + 0x00);
        body.writeInt32LE(disc,      off + 0x04);
        body.writeInt32LE(gold,      off + 0x08);
        body.writeUint8(0,           off + 0x0C);
        body.writeUint8(isShow,      off + 0x0D);
        body.writeUint8(isNew,       off + 0x0E);
        body.writeUint8(isHot,       off + 0x0F);
        body.writeUint8(1,           off + 0x10);
        body.writeUint8(currencyCode.charCodeAt(0), off + 0x11);
        body.writeUint8(0,           off + 0x12);
        body.writeUint8(0,           off + 0x13);
    }
}

// Cache.Bin item nCategory (Engine UCacheManager) ??shop tabs filter on this
const SHOP_CATEGORY_TYPE = {
    MainWeapon: 2,
    AssistWeapon: 3,
    Booster: 7,
    Support: 8,
};

function catalogCategoryType(row)
{
    const fromDb = Number(row.category_type);
    if (Number.isFinite(fromDb) && fromDb > 0)
        return fromDb >>> 0;
    const key = String(row.category || '').trim();
    return (SHOP_CATEGORY_TYPE[key] || 2) >>> 0;
}

function catalogGoldPrice(row)
{
    const p = Number(row.price);
    if (Number.isFinite(p) && p > 0)
        return p >>> 0;
    return 1000;
}

function interleaveShopFamilies(shopItems)
{
    const groups = new Map();
    for (const entry of dedupeShopModels(shopItems)) {
        const family = Math.floor((Number(entry.item.item_id) || 0) / 100000);
        if (!groups.has(family)) {
            groups.set(family, []);
        }
        groups.get(family).push(entry);
    }

    const queues = [...groups.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, entries]) => entries);
    const result = [];
    let added = true;
    while (added) {
        added = false;
        for (const queue of queues) {
            if (queue.length > 0) {
                result.push(queue.shift());
                added = true;
            }
        }
    }
    return result;
}

function dedupeShopModels(shopItems)
{
    const byModel = new Map();
    for (const entry of shopItems) {
        const itemId = Number(entry.item.item_id) || 0;
        const modelKey = Math.floor(itemId / 100);
        const previous = byModel.get(modelKey);
        if (!previous || preferShopRepresentative(entry.item, previous.item)) {
            byModel.set(modelKey, entry);
        }
    }
    return [...byModel.values()].sort((a, b) => Number(a.item.item_id) - Number(b.item.item_id));
}

function preferShopRepresentative(candidate, current)
{
    const candidateId = Number(candidate.item_id) || 0;
    const currentId = Number(current.item_id) || 0;
    const candidateLevel = candidateId % 100;
    const currentLevel = currentId % 100;

    if (candidateLevel === 1 && currentLevel !== 1) return true;
    if (candidateLevel !== 1 && currentLevel === 1) return false;

    const candidatePrice = catalogGoldPrice(candidate);
    const currentPrice = catalogGoldPrice(current);
    if (candidatePrice !== currentPrice) return candidatePrice < currentPrice;

    return candidateId < currentId;
}

function needsPostSelectShopRefresh(slot)
{
    return false;
}

module.exports =
class ZRoomDispatch
{
    dispatch(client, type, body)
    {
        // Catch ALL messages in the 0x0024XXXX range
        if ((type & 0x00FF0000) !== 0x00240000)
            return false;

        console.log(`[ZRoomDispatch] Message 0x${type.toString(16).padStart(8, '0')} (${body.length} bytes)`);
        if (body.length > 0) {
            console.log(`[ZRoomDispatch] Body:`, body.toString('hex'));
            const ascii = body.toString('ascii').replace(/[^\x20-\x7e]/g, '.');
            if (ascii.replace(/\./g, '').length > 2) {
                console.log(`[ZRoomDispatch] ASCII:`, ascii);
            }
        }

        switch (type)
        {
            // ==========================================
            // Room Enter / Room Info request
            // Client sends this when entering or refreshing room state
            // ==========================================
            case 0x00240101:
            {
                if (client.campaignRoom_ && client.createdRoomIndex_ != null) {
                    const [msg, respBody] = getExactMessageBuffer(0x00240102, 0x0E);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x00000000, 0x02);
                    respBody.writeUint32LE(0x00000000, 0x06);
                    respBody.writeUint32LE(0x00000000, 0x0A);
                    client.send(msg);
                    console.log(`[ZRoomDispatch] >> Suppressed Hangar bootstrap in campaign room (sent minimal 0x240102 only)`);
                    return true;
                }

                if (!client.roomIndex_) {
                    client.roomIndex_ = 1;
                    client.roomType_ = 2;
                    client.mapId_ = 1;
                }

                // Hangar Open_SA. The client handler reads 14 body bytes:
                // u16 status + u32 result + u32 point + u32 cash.
                {
                    const [msg, respBody] = getExactMessageBuffer(0x00240102, 0x0E);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x00000000, 0x02);
                    // The client displays offsets 0x06/0x0A as one 64-bit cash
                    // value in this path, so keep Open_SA money fields clear.
                    respBody.writeUint32LE(0x00000000, 0x06);
                    respBody.writeUint32LE(0x00000000, 0x0A);
                    client.send(msg);
                    console.log(`[ZRoomDispatch] >> Sent Hangar Open_SA 0x240102 (14 bytes)`);
                }

                setTimeout(async () => {
                    this.sendPackageMoney(client);
                    await this.sendPackageItems(client);
                    await this.sendHangarWearInfo(client);

                    // 기본 슬롯 1번 지정 — 새 계정에서 클라가 슬롯을 모를 때 트리거
                    {
                        const [msg, respBody] = getExactMessageBuffer(0x00240113, 0x0A);
                        respBody.writeUInt16LE(0, 0x00);
                        respBody.writeUInt32LE(0, 0x02);
                        respBody.writeUInt32LE(1, 0x06); // slot=1
                        client.send(msg);
                        console.log(`[ZRoomDispatch] >> Sent DefaultSlot_Change_SA 0x240113: slot=1`);
                    }

                    await this.sendShopList(client, 1);
                    this.scheduleShopListRefresh(client, 1, 150, 'initial default');
                    this.scheduleShopListRefresh(client, 1, 500, 'initial default');
                }, 50);

                // Slot_Change_SA 딜레이 전송 — 클라가 0x240107 CQ를 안 보낼 경우 강제 렌더링
                setTimeout(async () => {
                    try {
                        // 클라가 이미 슬롯 선택했으면 스킵
                        if (client.currentHangarSlot_) return;
                        const slotPayload = await this.buildSlotChangePayload(client, Buffer.alloc(0x1C));
                        slotPayload.writeUInt32LE(1, 0);
                        const [msg, respBody] = getExactMessageBuffer(0x00240108, 0x22);
                        respBody.writeUInt16LE(0, 0x00);
                        respBody.writeUInt32LE(0, 0x02);
                        slotPayload.copy(respBody, 0x06, 0x00, 0x1C);
                        client.send(msg);
                        client.currentHangarSlot_ = 1;
                        console.log(`[ZRoomDispatch] >> Sent initial Slot_Change_SA 0x240108: slot=1`);
                    } catch (err) {
                        console.error(`[ZRoomDispatch] >> Initial slot change error:`, err.message);
                    }
                }, 800);
                return true;
            }

            // ==========================================
            // Room Member List / Room Detail request
            // ==========================================
            case 0x00240103:
            {
                console.log(`[ZRoomDispatch] >> Room Member/Detail CQ`);
                // SA ?묐떟
                {
                    const [msg, respBody] = getExactMessageBuffer(0x00240104, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                    console.log(`[ZRoomDispatch] >> Sent Room Member/Detail SA 0x240104 (6 bytes)`);
                }
                return true;
            }

            // ==========================================
            // Game Ready (CN - client notification)
            // Player toggled ready state
            // ==========================================
            case 0x00240201:
            {
                if (body.length >= 5) {
                    const purchaseItemId = body.readUInt32LE(1);
                    if (purchaseItemId >= 10000000) {
                        (async () => {
                            await this.handleShopPurchase(client, purchaseItemId, body);
                        })().catch(err => {
                            console.error(`[ZRoomDispatch] >> Shop purchase error:`, err.message);
                        });
                        return true;
                    }
                }

                console.log(`[ZRoomDispatch] >> Game Ready CN`);

                // Echo back as SN so the client sees the state change
                {
                    const [msg, respBody] = client.getMessageBuffer(0x00240202, 0x10);
                    respBody.writeUint32LE(0, 0);   // Slot index
                    respBody.writeUint8(1, 4);      // Ready = true
                    client.send(msg);
                }

                return true;
            }

            // ==========================================
            // Game Start (CN - client notification)
            // Host pressed start
            // ==========================================
            case 0x00240301:
            {
                console.log(`[ZRoomDispatch] >> Game Start CN - HOST WANTS TO START!`);
                console.log(`[ZRoomDispatch] >> Body: ${body.toString('hex')}`);

                client.gameStarted_ = true;
                client.campaignStarted_ = (Number(client.rawRoomType_) === 1) ||
                    (Number(client.gameMode_) === 4 || Number(client.gameMode_) === 5);
                if (client.campaignStarted_) {
                    console.log(`[ZRoomDispatch] >> Campaign solo start armed: room=${client.roomIndex_ || 0}, map=${client.mapId_ || 0}`);
                }

                // Game Start SA
                {
                    const [msg, respBody] = client.getMessageBuffer(0x00240302, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                    console.log(`[ZRoomDispatch] >> Sent 0x00240302 (Game Start SA)`);
                }

                // BeginRound_SN (0x00230152) - start round after ready ack
                setTimeout(() => {
                    try {
                        // Ready_Success_SN
                        {
                            const [msg, respBody] = client.getMessageBuffer(0x00420116, 0x6);
                            respBody.writeUint16LE(0x0000, 0);
                            respBody.writeUint32LE(0x0000, 2);
                            client.send(msg);
                            console.log(`[ZRoomDispatch] >> Sent 0x00420116 (Ready_Success_SN)`);
                        }
                        // BeginRound_SN
                        {
                            const [msg, respBody] = client.getMessageBuffer(0x00230152, 0x6);
                            respBody.writeUint16LE(0x0000, 0);
                            respBody.writeUint32LE(0x0000, 2);
                            client.send(msg);
                            console.log(`[ZRoomDispatch] >> Sent 0x00230152 (BeginRound_SN)`);
                        }
                    } catch(e) {
                        console.error(`[ZRoomDispatch] >> Game start error:`, e.message);
                    }
                }, 1000);

                return true;
            }

            // ==========================================
            // Room Leave
            // ==========================================
            case 0x00240111:
            {
                console.log(`[ZRoomDispatch] >> Room Leave CQ`);
                const [msg, respBody] = client.getMessageBuffer(0x00240112, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
                resetRoomSessionState(client);
                setTimeout(() => {
                    try {
                        sendLobbyBootstrapAfterRoomLeave(client);
                    } catch (err) {
                        console.error(`[ZRoomDispatch] >> Room leave lobby bootstrap error:`, err.message);
                    }
                }, 80);
                return true;
            }

            // ==========================================
            // Hangar default slot select request.
            // execHangar_Slot_Select -> DefaultSlot_Change_CQ sends 0x240112.
            // The CQ buffer carries a 1-based slot number. The SA uses the
            // standard u16 origin + u32 result header, followed by the slot.
            // ==========================================
            case 0x00240112:
            {
                const requestedSlot = body.length >= 4 ? body.readUInt32LE(0) : 1;
                const slot = Math.min(Math.max(requestedSlot, 1), 8);
                const [msg, respBody] = getExactMessageBuffer(0x00240113, 0x0A);
                respBody.writeUInt16LE(0, 0x00);
                respBody.writeUInt32LE(0, 0x02);
                respBody.writeUInt32LE(slot, 0x06);
                client.send(msg);
                console.log(`[ZRoomDispatch] >> Sent DefaultSlot_Change_SA 0x240113: defaultMech=${slot}`);
                return true;
            }

            // ==========================================
            // Hangar slot change request.
            // The client CQ sends 7 dwords:
            //   slot, mech, main, left, right, equipment, skin.
            // ZDispatchHangar::Slot_Change_SA expects the normal SA header
            // before the same 7 dwords: u16 origin + u32 result + payload.
            // ==========================================
            case 0x00240107:
            {
                if (body.length >= 0x1C) {
                    const slot = body.readUInt32LE(0x00);
                    client.currentHangarSlot_ = slot; // 현재 선택 슬롯 기억
                    (async () => {
                        const slotPayload = await this.buildSlotChangePayload(client, body);
                        const [msg, respBody] = getExactMessageBuffer(0x00240108, 0x22);
                        respBody.writeUInt16LE(0, 0x00);
                        respBody.writeUInt32LE(0, 0x02);
                        slotPayload.copy(respBody, 0x06, 0x00, 0x1C);
                        if (needsPostSelectShopRefresh(slot)) {
                            client.send(msg);
                            console.log(`[ZRoomDispatch] >> Sent Slot_Change_SA 0x240108 before shop refresh: slot=${slot}`);
                            this.scheduleShopListRefresh(client, slot, 30, 'post select prime');
                            this.scheduleShopListRefresh(client, slot, 180, 'post select repaint');
                            this.scheduleShopListRefresh(client, slot, 500, 'post select repaint');
                        } else {
                            await this.sendShopList(client, slot);
                            client.send(msg);
                            console.log(`[ZRoomDispatch] >> Sent Slot_Change_SA 0x240108 after preloaded shop: slot=${slot}`);
                            this.scheduleShopListRefresh(client, slot, 80, 'post slot change');
                        }
                    })().catch(err => {
                        console.error(`[ZRoomDispatch] >> Slot shop preload error:`, err.message);
                    });
                } else {
                    const [msg, respBody] = client.getMessageBuffer(0x00240108, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                    console.log(`[ZRoomDispatch] >> Sent Slot_Change_SA 0x240108 fallback`);
                }
                return true;
            }

            default:
            {
                // Auto-respond to CQ messages with OK
                if (type % 2 === 1) {
                    const responseType = type + 1;
                    console.log(`[ZRoomDispatch] >> Auto-responding with 0x${responseType.toString(16).padStart(8, '0')}`);
                    const [msg, respBody] = client.getMessageBuffer(responseType, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                }
                return true;
            }
        }
    }

    async buildSlotChangePayload(client, requestBody)
    {
        const payload = Buffer.alloc(0x1C);
        requestBody.copy(payload, 0, 0, Math.min(requestBody.length, payload.length));

        const slot = payload.readUInt32LE(0);
        if (!client.accountId_ || slot < 1 || slot > 8) {
            return payload;
        }

        try {
            const items = await db.getItems(client.accountId_);
            const equipped = new Map();
            for (const item of items) {
                if (Number(item.mech_type) !== Number(slot) || Number(item.equipped) !== 1) {
                    continue;
                }
                const part = Number(item.part_slot);
                if (part >= 0 && part <= 5 && !equipped.has(part)) {
                    equipped.set(part, Number(item.id) || 0);
                }
            }

            // Slot_Change_SA payload: slot, body, main, left, right, equipment/booster, skin.
            for (let part = 0; part <= 5; part++) {
                const serial = equipped.get(part);
                if (serial) {
                    payload.writeUInt32LE(serial >>> 0, 4 + part * 4);
                }
            }

            console.log(`[ZRoomDispatch] >> Slot_Change_SA payload fill: slot=${slot} body=${payload.readUInt32LE(4)} main=${payload.readUInt32LE(8)} left=${payload.readUInt32LE(12)} right=${payload.readUInt32LE(16)} equip=${payload.readUInt32LE(20)} skin=${payload.readUInt32LE(24)}`);
        } catch (err) {
            console.error(`[ZRoomDispatch] >> buildSlotChangePayload error:`, err.message);
        }

        return payload;
    }

    async handleShopPurchase(client, itemId, requestBody)
    {
        console.log(`[ZRoomDispatch] >> Shop Buy CQ 0x240201: item_id=${itemId} body=${requestBody.toString('hex')}`);

        let result = 0;
        if (!client.accountId_) {
            result = 1;
        } else {
            try {
                const catalog = await db.getItemCatalog();
                const item = catalog.find(row => Number(row.item_id) === Number(itemId));
                if (!item) {
                    result = 1;
                } else {
                    const catType = catalogCategoryType(item);
                    // category_type → part_slot 매핑
                    // 2=주무기→1, 3=보조무기→2, 4=부스터→4, 5=스킨→5, 6=장비→4, 7=부스터→4, 8=지원→5
                    const partSlotMap = { 2: 1, 3: 2, 4: 4, 5: 4, 6: 4, 7: 4, 8: 4 };
                    const partSlot = partSlotMap[catType] ?? 1;
                    const mechType = Number(item.mech_type) || 0;
                    await db.pool.execute(
                        'INSERT INTO items (account_id, item_id, slot, mech_type, part_slot, quantity, equipped) VALUES (?, ?, ?, ?, ?, 1, 0)',
                        [client.accountId_, itemId, partSlot, mechType, partSlot]
                    );
                    console.log(`[ZRoomDispatch] >> Shop Buy stored item: account=${client.accountId_} item_id=${itemId} mech=${mechType} part=${partSlot}`);
                }
            } catch (err) {
                result = 1;
                console.error(`[ZRoomDispatch] >> Shop Buy DB error:`, err.message);
            }
        }

        const [msg, body] = getExactMessageBuffer(0x00240202, 0x06);
        body.writeUInt16LE(0, 0x00);
        body.writeUInt32LE(result, 0x02);
        client.send(msg);
        console.log(`[ZRoomDispatch] >> Sent Shop Buy SA 0x240202: result=${result}`);

        if (result === 0) {
            this.sendPackageMoney(client);
            await this.sendPackageItems(client);
            await this.sendHangarWearInfo(client);  // 구매 후 슬롯 즉시 갱신
            // 현재 슬롯 상점도 갱신해서 구매한 아이템 반영
            const currentSlot = client.currentHangarSlot_ || 1;
            this.scheduleShopListRepaint(client, currentSlot, 100, 'post purchase');
        }
    }

    scheduleShopListRefresh(client, slot, delayMs, reason)
    {
        setTimeout(() => {
            this.sendShopList(client, slot)
                .then(() => {
                    console.log(`[ZRoomDispatch] >> Delayed ShopList refresh (${reason}) slot=${slot} after ${delayMs}ms`);
                })
                .catch(err => {
                    console.error(`[ZRoomDispatch] >> Delayed ShopList refresh error:`, err.message);
                });
        }, delayMs);
    }

    scheduleShopListRepaint(client, slot, delayMs, reason)
    {
        setTimeout(() => {
            try {
                this.sendEmptyShopList(client, `${reason} clear`);
                setTimeout(() => {
                    this.sendShopList(client, slot)
                        .then(() => {
                            console.log(`[ZRoomDispatch] >> Repaint ShopList fill (${reason}) slot=${slot} after ${delayMs}ms`);
                        })
                        .catch(err => {
                            console.error(`[ZRoomDispatch] >> Repaint ShopList fill error:`, err.message);
                        });
                }, 80);
            } catch (err) {
                console.error(`[ZRoomDispatch] >> Repaint ShopList clear error:`, err.message);
            }
        }, delayMs);
    }

    sendEmptyShopList(client, reason)
    {
        const [msg, body] = getExactMessageBuffer(SN_SHOP_LIST, 3);
        body.writeUint8(1, 0);
        body.writeUint8(0, 1);
        body.writeUint8(0, 2);
        client.send(msg);

        const [msg2, body2] = getExactMessageBuffer(SN_CASH_SHOP, 3);
        body2.writeUint8(1, 0);
        body2.writeUint8(0, 1);
        body2.writeUint8(0, 2);
        client.send(msg2);

        console.log(`[ZRoomDispatch] >> Sent empty ShopList/CashShopList (${reason})`);
    }

    async sendHangarWearInfo(client)
    {
        try {
            if (!client.accountId_) return;
            const { MAX_MECH_COUNT } = require('../datatypes/enums');
            const ENTRY_SIZE = 52;
            const HEADER_SIZE = 14;
            const defaultMech = 1;

            const items = await db.getItems(client.accountId_);
            const mechSlots = {};
            for (let m = 1; m <= MAX_MECH_COUNT; m++) {
                mechSlots[m] = Array.from({length: 6}, () => ({uniqueKey: 0, itemIndex: 0}));
            }
            for (const item of items) {
                if (item.equipped && item.mech_type >= 1 && item.mech_type <= MAX_MECH_COUNT) {
                    const slot = Number(item.part_slot);
                    if (slot >= 0 && slot < 6) {
                        mechSlots[item.mech_type][slot] = {
                            uniqueKey: item.id || 0,
                            itemIndex: slot === 0 ? (CACHE_INDEX_BY_ITEM_ID[Number(item.item_id)] ?? Number(item.item_id) ?? 0) : (Number(item.item_id) || 0),
                        };
                    }
                }
            }

            const [msg, body] = getExactMessageBuffer(SN_WEAR_INFO,
                HEADER_SIZE + ENTRY_SIZE * MAX_MECH_COUNT);
            body.writeUint8(1, 0);
            body.writeUint8(MAX_MECH_COUNT, 1);
            body.writeUint32LE(0, 2);            // pilotSerialIndex
            body.writeUint32LE(Number(client.pilot_) || 101, 6); // pilotItemIndex
            body.writeUint32LE(defaultMech, 10); // selectedMechType

            let offset = HEADER_SIZE;
            for (let m = 1; m <= MAX_MECH_COUNT; m++) {
                body.writeUint32LE(m, offset);
                for (let s = 0; s < 6; s++) {
                    body.writeUint32LE(mechSlots[m][s].uniqueKey, offset + 4 + s * 8);
                    body.writeUint32LE(mechSlots[m][s].itemIndex, offset + 4 + s * 8 + 4);
                }
                offset += ENTRY_SIZE;
            }
            client.send(msg);
            const bodySlots = Object.values(mechSlots).filter(s => s[0].itemIndex !== 0).length;
            console.log(`[ZRoomDispatch] >> Sent SN_WEAR_INFO (hangar): ${MAX_MECH_COUNT} mechs, pilot=${Number(client.pilot_) || 101}, bodySlots=${bodySlots}`);
        } catch (err) {
            console.error(`[ZRoomDispatch] >> sendHangarWearInfo error:`, err.message);
        }
    }

    async sendShopList(client, selectedSlot = 0, categoryType = 2)
    {
        try {
            const catalog = await db.getItemCatalog();
            if (catalog.length === 0) return;

            const ENTRY_SIZE = 20;
            const HEADER_SIZE = 3;
            const CAT_LIMIT = { 2: 10, 3: 20, 4: 10, 5: 25, 6: 25 };

            const allItems = await this.buildShopItems(client, catalog, selectedSlot, categoryType);

            const groups = new Map();
            for (const entry of allItems) {
                const cat = Number(entry.item.category_type);
                if (!groups.has(cat)) groups.set(cat, []);
                groups.get(cat).push(entry);
            }

            for (const [cat, items] of [...groups.entries()].sort(([a],[b]) => a - b)) {
                const count = Math.min(items.length, CAT_LIMIT[cat] || 25);
                const sendItems = items.slice(0, count);

                const [msg, respBody] = getExactMessageBuffer(SN_SHOP_LIST,
                    HEADER_SIZE + (ENTRY_SIZE * count));
                writeShopListBody(respBody, sendItems, 'P');
                client.send(msg);

                const [msg2, body2] = getExactMessageBuffer(SN_CASH_SHOP,
                    HEADER_SIZE + (ENTRY_SIZE * count));
                writeShopListBody(body2, sendItems, 'C');
                client.send(msg2);

                console.log(`[ZRoomDispatch] >> Sent ShopList_SN cat=${cat}: ${count} items`);
            }

            console.log(`[ZRoomDispatch] >> Sent ShopList_SN 0x240241: ${allItems.length} total items in ${groups.size} tabs (rawItemId/show/P)`);
            console.log(`[ZRoomDispatch] >> Sent CashShopList_SN 0x240242: ${allItems.length} total items (rawItemId/show/C)`);
        } catch (err) {
            console.error(`[ZRoomDispatch] >> ShopList error:`, err.message);
        }
    }

    async buildShopItems(client, catalog, selectedSlot = 0, categoryType = 2)
    {
        const weaponItems = catalog
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => Number(item.category_type) >= 2 && Number(item.category_type) <= 6);

        if (!selectedSlot || !client.accountId_) {
            return weaponItems;
        }

        try {
            const items = await db.getItems(client.accountId_);
            const mechItems = weaponItems.filter(({ item }) => Number(item.mech_type) === Number(selectedSlot));
            if (mechItems.length > 0) {
                console.log(`[ZRoomDispatch] >> Shop refresh for slot=${selectedSlot}: catalogMech=${selectedSlot}, items=${mechItems.length}`);
                return interleaveShopFamilies(mechItems);
            }

            const equippedMain = items.find(item =>
                Number(item.mech_type) === Number(selectedSlot) &&
                Number(item.part_slot) === 1 &&
                Number(item.equipped) === 1
            );

            const mainItemId = Number(equippedMain && equippedMain.item_id) || 0;
            const mainFamily = mainItemId ? Math.floor(mainItemId / 100000) : 0;
            if (mainFamily) {
                const familyItems = weaponItems.filter(({ item }) =>
                    Math.floor((Number(item.item_id) || 0) / 100000) === mainFamily
                );
                if (familyItems.length > 0) {
                    console.log(`[ZRoomDispatch] >> Shop refresh for slot=${selectedSlot}: mainFamily=${mainFamily}, items=${familyItems.length}`);
                    return interleaveShopFamilies(familyItems);
                }
            }
        } catch (err) {
            console.error(`[ZRoomDispatch] >> buildShopItems error:`, err.message);
        }

        return weaponItems;
    }

    async sendPackageItems(client)
    {
        try {
            if (!client.accountId_) {
                console.log(`[ZRoomDispatch] >> No accountId; skipping package items`);
                return;
            }

            const items = await db.getItems(client.accountId_);
            const count = Math.min(items.length, 63);
            const [msg, body] = getExactMessageBuffer(SN_PACKAGE_ITEM, 1 + (count * 8));
            body.writeUint8(count, 0);

            let offset = 1;
            for (let i = 0; i < count; i++) {
                const item = items[i];
                const itemId = Number(item.item_id) || 0;
                const itemIndex = itemId;
                body.writeUint32LE(item.id || 0, offset);
                body.writeUint32LE(itemIndex, offset + 4);
                if (i < 10) {
                    console.log(`[ZRoomDispatch] >> Package item[${i}]: serial=${item.id || 0} item_id=${item.item_id} itemIndex=${itemIndex}`);
                }
                offset += 8;
            }

            client.send(msg);
            const bodyCount = items.slice(0, count).filter(item => Number(item.part_slot) === 0).length;
            console.log(`[ZRoomDispatch] >> Sent Packege_Item_SN 0x240131: ${count} items (${bodyCount} body rows, rawItemId)`);
        } catch (err) {
            console.error(`[ZRoomDispatch] >> Packege_Item_SN error:`, err.message);
        }
    }

    sendPackageMoney(client)
    {
        const point = HANGAR_POINT_BALANCE;
        const coupon = HANGAR_COUPON_BALANCE;

        {
            const [msg, body] = getExactMessageBuffer(SN_PACKAGE_POINT, 12);
            body.writeUint32LE(point, 0x00);
            body.writeUint32LE(point, 0x04);
            body.writeUint32LE(0, 0x08);
            client.send(msg);
        }

        {
            const [msg, body] = getExactMessageBuffer(SN_PACKAGE_COUPON, 12);
            body.writeUint32LE(coupon, 0x00);
            body.writeUint32LE(coupon, 0x04);
            body.writeUint32LE(0, 0x08);
            client.send(msg);
        }

        console.log(`[ZRoomDispatch] >> Sent Packege_Point_SN 0x240132: point=${point}`);
        console.log(`[ZRoomDispatch] >> Sent Packege_Coupon_SN 0x240133: coupon=${coupon}`);
    }

    async sendHangarItemInfo(client)
    {
        try {
            if (!client.accountId_) {
                console.log(`[ZRoomDispatch] >> No accountId; skipping hangar ItemInfo resend`);
                return;
            }

            const items = await db.getItems(client.accountId_);
            const bodyCount = items.filter(item => Number(item.part_slot) === 0).length;
            const ITEM_RECORD_SIZE = 35;
            const headerSize = 6;
            const [msg, body] = getExactMessageBuffer(SN_ITEM_INFO,
                headerSize + (ITEM_RECORD_SIZE * items.length));

            body.writeUint8(1, 0);
            body.writeUint8(items.length, 1);
            body.writeUint32LE(client.accountId_ || 0, 2);

            let offset = headerSize;
            for (const item of items) {
                body.writeUint32LE(item.id || 0, offset + 0x00);
                body.writeUint32LE(Number(item.item_id) || 0, offset + 0x04);
                body.writeUint32LE(item.equipped ? 1 : 0, offset + 0x08);
                body.writeUint32LE(0, offset + 0x0C);
                body.writeUint16LE(item.mech_type || 0, offset + 0x10);
                body.writeUint32LE(item.part_slot || 0, offset + 0x12);
                body.writeUint8(item.equipped ? 2 : 0, offset + 0x16);
                body.writeUint32LE(item.quantity || 1, offset + 0x17);
                body.writeUint32LE(0xFFFFFFFF, offset + 0x1B);
                body.writeUint32LE(0xFFFFFFFF, offset + 0x1F);
                offset += ITEM_RECORD_SIZE;
            }

            client.send(msg);
            console.log(`[ZRoomDispatch] >> Resent Account ItemInfo_SN 0x210111 after Hangar Open: ${items.length} items (${bodyCount} body rows, ItemInfo only)`);
        } catch (err) {
            console.error(`[ZRoomDispatch] >> Hangar ItemInfo resend error:`, err.message);
        }
    }

    async sendHangarAccountData(client)
    {
        try {
            if (!client.accountId_) {
                console.log(`[ZRoomDispatch] >> No accountId; skipping hangar account data`);
                return;
            }

            const [items, catalog] = await Promise.all([
                db.getItems(client.accountId_),
                db.getItemCatalog(),
            ]);
            const bodyItems = items.filter(item => Number(item.part_slot) === 0);
            const equipmentItems = items.filter(item => Number(item.part_slot) !== 0);
            const hangarItems = [...equipmentItems, ...bodyItems];

            // SN_ITEM_INFO registers owned items. The client debug string calls this
            // ItemIndex, but the login path only kept mech thumbnails stable with
            // raw item_id values, so keep inventory/wear on the same identifier.
            {
                const ITEM_RECORD_SIZE = 35;
                const headerSize = 6;
                const [msg, body] = getExactMessageBuffer(SN_ITEM_INFO,
                    headerSize + (ITEM_RECORD_SIZE * hangarItems.length));
                body.writeUint8(1, 0);
                body.writeUint8(hangarItems.length, 1);
                body.writeUint32LE(client.accountId_ || 0, 2);

                let offset = headerSize;
                for (const item of hangarItems) {
                    const isBodyItem = Number(item.part_slot) === 0;
                    body.writeUint32LE(item.id || 0, offset);
                    body.writeUint32LE(Number(item.item_id) || 0, offset + 0x04);
                    body.writeUint32LE(item.equipped ? 1 : 0, offset + 0x08);
                    body.writeUint32LE(0, offset + 0x0C);
                    body.writeUint16LE(item.mech_type || 0, offset + 0x10);
                    body.writeUint32LE(isBodyItem ? 1 : (item.part_slot || 0), offset + 0x12);
                    body.writeUint8(item.equipped ? 2 : 0, offset + 0x16);
                    body.writeUint32LE(item.quantity || 1, offset + 0x17);
                    body.writeUint32LE(0xFFFFFFFF, offset + 0x1B);
                    body.writeUint32LE(0xFFFFFFFF, offset + 0x1F);
                    offset += ITEM_RECORD_SIZE;
                }
                client.send(msg);
            }

            // SN_WEAR_INFO references the items registered above.
            let bodyWearSlot0 = 0;
            {
                const ENTRY_SIZE = 52;
                const HEADER_SIZE = 14;
                const defaultMech = 1;
                const mechSlots = {};
                for (let m = 1; m <= MAX_SLOT_COUNT; m++) {
                    mechSlots[m] = Array.from({length: 6}, () => ({uniqueKey: 0, itemIndex: 0}));
                }

                for (const item of bodyItems) {
                    const mechType = Number(item.mech_type);
                    if (item.equipped && mechType >= 1 && mechType <= MAX_SLOT_COUNT) {
                        mechSlots[mechType][0] = {
                            uniqueKey: item.id || 0,
                            itemIndex: slot === 0 ? (CACHE_INDEX_BY_ITEM_ID[Number(item.item_id)] ?? Number(item.item_id) ?? 0) : (Number(item.item_id) || 0),
                        };
                        bodyWearSlot0++;
                    }
                }
                for (const item of equipmentItems) {
                    if (item.equipped && item.mech_type >= 1 && item.mech_type <= MAX_SLOT_COUNT) {
                        const slot = Number(item.part_slot);
                        if (slot >= 0 && slot < 6 && mechSlots[item.mech_type]) {
                            const wearEntry = {
                                uniqueKey: item.id || 0,
                                itemIndex: slot === 0 ? (CACHE_INDEX_BY_ITEM_ID[Number(item.item_id)] ?? Number(item.item_id) ?? 0) : (Number(item.item_id) || 0),
                            };
                            mechSlots[item.mech_type][slot] = wearEntry;
                        }
                    }
                }

                const [msg, body] = getExactMessageBuffer(SN_WEAR_INFO,
                    HEADER_SIZE + (ENTRY_SIZE * MAX_SLOT_COUNT));
                body.writeUint8(1, 0);
                body.writeUint8(MAX_SLOT_COUNT, 1);
                body.writeUint32LE(0, 2);  // pilotItemIndex
                body.writeUint32LE(0, 6);  // pilotSerialIndex
                body.writeUint32LE(defaultMech, 10);

                let offset = HEADER_SIZE;
                for (let m = 1; m <= MAX_SLOT_COUNT; m++) {
                    body.writeUint32LE(m, offset);
                    for (let s = 0; s < 6; s++) {
                        body.writeUint32LE(mechSlots[m][s].uniqueKey, offset + 4 + s * 8);
                        body.writeUint32LE(mechSlots[m][s].itemIndex, offset + 4 + s * 8 + 4);
                    }
                    offset += ENTRY_SIZE;
                }
                client.send(msg);
            }

            console.log(`[ZRoomDispatch] >> Resent hangar account data: ${hangarItems.length} items (${bodyItems.length} body rows registered as part_slot=1, bodyWearSlot0=${bodyWearSlot0})`);
        } catch (err) {
            console.error(`[ZRoomDispatch] >> Hangar account data error:`, err.message);
        }
    }

    /**
     * Sends full room state to a client (room info + user info + master + state)
     * @param {NetworkClient} client
     *
     * Room_Default_SN body format (from ZNetwork.dll disassembly at 0x107EA3E0):
     *   [0x00] u16  RoomIndex
     *   [0x02] u16  RoomType (0=Normal, 1=ClanWar, 2=Campaign, 3=QuickMatch)
     *   [0x04] u8   MapIndex
     *   [0x05] u16  MapId (or sub-map)
     *   [0x07] u8   MaxPlayers
     *   [0x08] u8   GameMode
     *   [0x09] u8   RoundCount
     *   [0x0A] u8   TimeLimit
     *   [0x0B] u8   RespawnTime
     *   [0x0C] u8   TeamBalance
     *   [0x0D] u8   FriendlyFire
     *   [0x0E] u8   WeaponRestrict
     *   [0x10] u16  ScoreLimit
     *   [0x12] u16  Unknown
     *   [0x1C] u8   Password flag
     *   [0x1D] u8   Unknown
     *   [0x1E] u8   Unknown
     *   [0x1F] u8   Unknown
     *   Room name at some offset (variable length string)
     *   Total body: up to ~192 bytes
     */
    sendRoomState(client)
    {
        const roomIndex = client.roomIndex_ || 0;
        const accountIndex = client.accountIndex_ || client.accountId_ || 1;
        // Room_Default_SN raw type is not the same thing as the effective room type
        // chosen during CQ_CREATE handling. Static analysis shows:
        //   raw 1 -> internal 2
        //   raw 2 -> internal 1
        // When we sent type=2 here, the client switched the room shell to a PvP
        // layout (Red/Blue team, team-balance options, broad map categories).
        // Campaign room creation still needs the raw create-type value here.
        const rawRoomType = typeof client.rawRoomType_ === 'number' ? client.rawRoomType_ : (client.roomType_ || 1);
        const roomType = rawRoomType === 0 ? 2 : rawRoomType;
        const mapId = client.mapId_ || 1;
        const maxPlayers = Math.max(client.maxPlayers_ || 1, 1);
        const currentUsers = 1;
        const gameMode = client.gameMode_ || 0;
        const mapIndex = client.campaignRoom_
            ? 1
            : Math.min(Math.max(Number(mapId) || 1, 1), 6);
        const roomName = (client.roomName_ || client.nickname_ || 'Room').slice(0, 25);
        const nickname = (client.nickname_ || 'Player').slice(0, 25);
        const pilotId = client.pilot_ || 101;
        const userLevelText = '1';
        // record+0x10 is consumed separately from the textual level and feeds
        // the room-user classification path. Use raw 2 as the first explicit
        // non-default candidate instead of mirroring the display level "1".
        const userLevelType = 2;
        // Re-reading User_Default_SN shows the team word is forwarded directly
        // into Room_User_Add, unlike the separate mapped state fields.
        // team=0 for RED team (first slot); matches 2011 log team=0 URL param.
        const teamIndex = 0;
        // record+0x0C in User_Default_SN is a separate dword field, not the
        // visible room state printed from record+0x13. Keep it neutral.
        const userHiddenRaw = 0;
        // Keep the user state aligned with the room's waiting/idle state rather
        // than the old playing-ish value 2.
        const userStateRaw = 1;
        const packedIp = 0x0100007F;
        const selectedMech = 1;
        const primaryMapCacheIndex = CAMPAIGN_MAP_CACHE_INDEX_BY_MAP_ID[mapId] || ROOM_DEFAULT_ENTRY_HINTS[0] || 8;
        const campaignMapCacheKey = primaryMapCacheIndex;
        const roomSettingGoal = client.campaignRoom_ ? 0 : currentUsers;
        const roomSettingTime = client.campaignRoom_ ? 0 : maxPlayers;
        const roomSettingRound = client.campaignRoom_ ? 1 : 0;
        const roomDefaultEntryCount = client.campaignRoom_
            ? ROOM_DEFAULT_ENTRY_HINTS.length
            : Math.min(Math.max(maxPlayers, 1), ROOM_DEFAULT_ENTRY_HINTS.length);
        const ctx = {
            roomIndex,
            accountIndex,
            roomType,
            mapId,
            maxPlayers,
            currentUsers,
            gameMode,
            mapIndex,
            roomName,
            nickname,
            pilotId,
            userLevelText,
            userLevelType,
            teamIndex,
            userHiddenRaw,
            userStateRaw,
            packedIp,
            selectedMech,
            primaryBodyCacheIndex: primaryMapCacheIndex,
            campaignMapCacheKey,
            roomSettingGoal,
            roomSettingTime,
            roomSettingRound,
            roomDefaultEntryCount,
            roomDefaultEntryHints: ROOM_DEFAULT_ENTRY_HINTS,
            campaignMapHints: CAMPAIGN_MAP_ALL_HINTS,
        };
        console.log(`[ZRoomDispatch] >> sendRoomState 호출 (mapId=${mapId}, cacheIndex=${primaryMapCacheIndex})`);
        sendRoomStatePackets(client, ctx, getExactMessageBuffer);
        sendRoomMapPackets(client, ctx, getExactMessageBuffer);
        sendRoomUserPackets(client, ctx, getExactMessageBuffer);
        if (CAMPAIGN_GAME_USER_BOOTSTRAP_MODE === 'enabled' && client.campaignRoom_) {
            Promise.resolve(sendGameUserBootstrap(client, ctx, getExactMessageBuffer)).catch((err) => {
                console.error(`[ZRoomDispatch] >> Game_User_SN bootstrap error: ${err.message}`);
            });
        }
        if (client.campaignRoom_) {
            this.sendCampaignBootstrap(client);
        }

        console.log(`[ZRoomDispatch] >> sendRoomState 완료`);
    }

    sendCampaignBootstrap(client)
    {
        sendCampaignBootstrap(client, getExactMessageBuffer);
    }
};
