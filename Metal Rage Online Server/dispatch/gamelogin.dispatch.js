const NetworkClient = require("../client");
const db = require('../database/db');

const { clampMoney, moneyBigInt } = require('./money');

const { writeRecordInfoBody } = require('./record-info.builder');
const authTokens = require('../auth-tokens');

const whitelist = require('../config/whitelist.js');

const rooms = require('../rooms.js');
const { sendFullRoomList } = require('./room/room-list.sender');
const { resolveRealMapIds, sendMapInfoSN } = require('./map-info.sender');

// Game server login handler
// After connecting to the game server (port 30907), the client sends
// 0x00110124 (CQ) to authenticate/enter. We respond with 0x00110125 (SA).
// Then replay account data from the database.

const CQ_GAME_LOGIN = 0x00110124;
const SA_GAME_LOGIN = 0x00110125;

const SN_DEFAULT_INFO  = 0x00210101;
const SN_RECORD_INFO   = 0x00210103;
const SN_MECH_LEVEL    = 0x00210104;
const SN_GRADE_INFO    = 0x00510101;
const SN_WEAR_INFO     = 0x00210113;   // DLL: WearInfo_SN (0x210112 = ExpirationItem_SN)
const SN_COMPLETE      = 0x00210121;
const SA_LOBBY_ENTER   = 0x00230112;
const SN_LICENSE_INFO  = 0x00260101;   // must be sent before SN_COMPLETE / lobby enter
const { MAX_MECH_COUNT, MAX_SLOT_COUNT } = require('../datatypes/enums');

function getExactMessageBuffer(type, bodySize) {
    const msg = Buffer.alloc(0x10 + bodySize);
    msg.writeUint16BE(msg.length, 0x6);
    msg.writeUint32BE(type, 0xC);
    return [msg, msg.subarray(0x10)];
}

const ACCOUNT_LEVEL_STR = { 0: '0\0', 1: '1\0', 2: '2\0', 3: '3\0', 4: '4\0' };

const cacheIndex = require('./cache-index');

module.exports =
class ZGameLoginDispatch
{
    dispatch(client, type, body)
    {
        //Handle known messages
        if (type !== CQ_GAME_LOGIN && type !== 0x00220111)
            return false;

        console.log(`[ZGameLoginDispatch] Message 0x${type.toString(16).padStart(8, '0')} (${body.length} bytes)`);
        if (body.length > 0)
            console.log(`[ZGameLoginDispatch] Body:`, body.toString('hex'));

        switch (type)
        {
            case CQ_GAME_LOGIN:
                return this.handleGameLogin(client, body).then(() => true);

            case 0x00220111:
                return this.handleChannelEnter(client, body).then(() => true);

            default:
                return false;
        }
    }

    async handleGameLogin(client, body)
    {
        try {
            console.log(`[ZGameLoginDispatch] >> Game server login request`);

            if (body.length < 8) { client.disconnect(); return; }
            const accountId = authTokens.lookup(body.readUInt32LE(0), body.readUInt32LE(4));
            if (accountId === null) { client.disconnect(); return; }
            const account = await db.getAccountById(accountId);
            if (!account || !whitelist.isAllowed(account.username)) { client.disconnect(); return; }
            let tutorials = [];
            const [loginMsg, loginBody] = client.getMessageBuffer(SA_GAME_LOGIN, 0x6);
            loginBody.writeUInt16LE(0, 0);
            loginBody.writeUInt32LE(0, 2);
            client.send(loginMsg);

            {
                // Store account info on the client for other dispatchers
                client.accountId_ = account.id;
                client.nickname_ = account.nickname;
                client.username_ = account.username;
                client.pilot_ = Number(account.pilot) || 101;
                client.point_ = clampMoney(account.point, 100000);
                client.cash_ = clampMoney(account.cash, 0);
                client.coupon_ = clampMoney(account.coupon, 0);

                const [record, mechLevels, dbItems, licenses, tutorialsResult] = await Promise.all([
                    db.getRecord(account.id),
                    db.getMechLevels(account.id),
                    db.getItems(account.id),
                    db.getMechLicenses(account.id),
                    db.getTutorials(account.id),
                ]);
                tutorials = tutorialsResult || [];
                const items = dbItems;
                const equipmentItems = dbItems.filter(item => Number(item.part_slot) !== 0);

                const levelStr = ACCOUNT_LEVEL_STR[account.account_level] || '1\0';

                // SN_DEFAULT_INFO
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_DEFAULT_INFO, 0x1b);
                    respBody.write(levelStr, 0);
                    respBody.write(account.nickname + '\0', 2);
                    client.send(msg);
                }

                // SN_PLAY_INFO (critical for room creation)
                {
                    const [msg, respBody] = client.getMessageBuffer(0x00210102, 0x16);
                    respBody.writeUint32LE(0, 0);
                    respBody.writeUint32LE(0, 4);
                    respBody.writeUint8(0, 8);
                    respBody.writeUint8(1, 9);
                    respBody.writeInt32LE(1, 0x0A);
                    respBody.writeUint16LE(1, 0x0E);
                    respBody.writeUint16LE(0, 0x10);
                    respBody.writeInt32LE(0, 0x12);
                    client.send(msg);
                }

                // SN_RECORD_INFO — corrected field layout from DLL analysis
                if (record) {
                    const [msg, respBody] = client.getMessageBuffer(SN_RECORD_INFO, 0x60);
                    writeRecordInfoBody(respBody, {
                        level: record.level,
                        coupon: account.coupon,
                        point: account.point,
                        wins: record.wins,
                        draws: record.draws,
                        losses: record.losses,
                        kills: record.kills,
                        deaths: record.deaths,
                        exp: record.exp,
                    });
                    client.send(msg);
                }

                // SN_GRADE_INFO (value=11 → grade 1)
                {
                    const gradeValue = 0;
                    if (gradeValue !== 0) {
                        console.error(`[ZGameLoginDispatch] !! Grade_Info_SN assertion failed: value=${gradeValue}, must be 0 -- refusing to send`);
                    } else {
                        const [msg, respBody] = client.getMessageBuffer(SN_GRADE_INFO, 4);
                        respBody.writeUInt32LE(gradeValue, 0);
                        client.send(msg);
                    }
                }

                // SN_MECH_LEVEL — DLL reads u8 count, then 28-byte entries
                if (mechLevels.length > 0) {
                    const MECH_RECORD_SIZE = 0x1c;
                    const [msg, respBody] = client.getMessageBuffer(SN_MECH_LEVEL, 1 + (MECH_RECORD_SIZE * mechLevels.length));
                    respBody.writeUint8(mechLevels.length, 0);
                    let offset = 1;
                    for (const mech of mechLevels) {
                        respBody.writeUint32LE(mech.mech_type, offset);
                        respBody.writeUint32LE(mech.level, offset + 4);
                        respBody.writeBigUint64LE(BigInt(mech.exp), offset + 8);
                        respBody.writeUint32LE(mech.kills, offset + 16);
                        respBody.writeUint32LE(mech.deaths, offset + 20);
                        respBody.writeUint32LE(mech.sorties, offset + 24);
                        offset += MECH_RECORD_SIZE;
                    }
                    client.send(msg);
                }

                await require('./item-info.sender').sendItemInfo(client, items, account.id, 'gamelogin');

                // SN_WEAR_INFO (0x210113) — DLL: WearInfo_SN
                // Header: [u8 suc][u8 cnt][u32 pilotSerialIndex][u32 pilotItemIndex][u32 selectedMechType]

                // Slot 0=Mech(body), 1=MainWeapon, 2=LeftWeapon, 3=RightWeapon, 4=Equipment, 5=Skin
                {
                    const ENTRY_SIZE = 52;
                    const HEADER_SIZE = 14;
                    const defaultMech = 1;

                    const mechSlots = {};
                    for (let m = 1; m <= MAX_MECH_COUNT; m++) {
                        mechSlots[m] = Array.from({length: 6}, () => ({uniqueKey: 0, itemIndex: 0}));
                    }

                    const wearItems = await db.getItemsWithEquipViews(account.id);

                    // All items: slot 0 = body/chassis, slots 1-5 = weapons/equipment
                    for (const item of wearItems) {
                        if (item.equipped && item.mech_type >= 1 && item.mech_type <= MAX_MECH_COUNT) {
                            const slot = Number(item.part_slot);
                            if (slot >= 0 && slot < 6 && mechSlots[item.mech_type]) {
                                const rawId = Number(item.item_id) || 0;
                                const girIndex = null;
                                const itemIndex = girIndex != null ? girIndex : rawId;
                                mechSlots[item.mech_type][slot] = {
                                    uniqueKey: item.id || 0,
                                    itemIndex: itemIndex,
                                };
                            }
                        }
                    }

                    const mechEntries = [];
                    for (let m = 1; m <= MAX_MECH_COUNT; m++) {
                        mechEntries.push({mechType: m, slots: mechSlots[m]});
                    }

                    {
                        const [msg, respBody] = client.getMessageBuffer(SN_WEAR_INFO,
                            HEADER_SIZE + (ENTRY_SIZE * mechEntries.length));
                        respBody.writeUint8(1, 0);
                        respBody.writeUint8(mechEntries.length, 1);
                        respBody.writeUint32LE(0, 2);           // pilotSerialIndex
                        respBody.writeUint32LE(client.pilot_, 6); // pilotItemIndex
                        respBody.writeUint32LE(defaultMech, 10); // selectedMechType (1-based)

                        let offset = HEADER_SIZE;
                        for (const entry of mechEntries) {
                            respBody.writeUint32LE(entry.mechType, offset);
                            for (let s = 0; s < 6; s++) {
                                respBody.writeUint32LE(entry.slots[s].itemIndex, offset + 4 + s * 8);
                                respBody.writeUint32LE(entry.slots[s].uniqueKey, offset + 8 + s * 8);
                            }
                            offset += ENTRY_SIZE;
                        }
                        client.send(msg);
                        const bodySlotCount = mechEntries.filter(e => e.slots[0].itemIndex !== 0).length;
                        console.log(`[ZGameLoginDispatch] >> Sent SN_WEAR_INFO: ${mechEntries.length} mechs, default=${defaultMech}, pilot=${client.pilot_}, bodySlots=${bodySlotCount}`);
                    }
                }

                // SN_LICENSE_INFO — DLL: [u8 hdr][u8 count] + 9-byte entries [u32 mech][u8 pad][u32 type]
                // type: 1=permanent, 2=timed
                {
                    const licList = licenses.length > 0
                        ? licenses
                        : Array.from({length: MAX_SLOT_COUNT}, (_, i) => ({mech_type: i+1, license_type: 0}));
                    const [msg, respBody] = client.getMessageBuffer(SN_LICENSE_INFO, 0x2 + (9 * licList.length));
                    let offset = 0;
                    respBody[offset++] = 0x00;
                    respBody[offset++] = licList.length;
                    for (const lic of licList) {
                        respBody.writeUint32LE(lic.mech_type, offset);
                        respBody.writeUint8(0, offset + 4);
                        respBody.writeUint32LE(lic.license_type || 1, offset + 5);
                        offset += 9;
                    }
                    client.send(msg);
                    console.log(`[ZGameLoginDispatch] >> Sent SN_LICENSE_INFO: ${licList.length} licenses`);
                }

                {
                    const dbMaps = await db.getMaps(account.id);
                    const fallbackIds = dbMaps.map((map) => map.map_id);
                    sendMapInfoSN(client, resolveRealMapIds() || fallbackIds);
                    console.log(`[ZGameLoginDispatch] >> Sent SN_MAP_INFO (mapInfoOnGameLoginMode): ${(resolveRealMapIds() || fallbackIds).length} maps`);
                }

                console.log(`[ZGameLoginDispatch] >> Sent DB account data for "${account.nickname}"`);

            }

            // SN_COMPLETE
            {
                const done = (tutorials || []).filter(t => t.completed).map(t => t.tutorial_id);
                let bitmask = 0;
                for (const id of done) bitmask |= (1 << (id - 1));
                const [msg, respBody] = client.getMessageBuffer(SN_COMPLETE, 0x100);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeInt32LE(0x0000, 2);
                respBody.writeUint8(bitmask, 6);
                client.send(msg);
                console.log(`[ZGameLoginDispatch] >> Sent SN_COMPLETE: tutorials bitmask=0x${bitmask.toString(16)} done=[${done.join(',')}]`);
            }

            // Lobby Enter
            {
                const [msg, respBody] = client.getMessageBuffer(SA_LOBBY_ENTER, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
            }

            console.log(`[ZGameLoginDispatch] >> Sent account data + lobby enter`);

        } catch (err) {
            console.error('[ZGameLoginDispatch] Login failed:', err.message);
            client.disconnect();
        }
    }

    async handleChannelEnter(client, body)
    {
        const channel = body.length > 0 ? body[0] : 0;
        console.log(`[ZGameLoginDispatch] >> Channel enter request (channel ${channel})`);

        {
            const [msg, respBody] = client.getMessageBuffer(0x00220112, 0x6);
            respBody.writeUint16LE(0x0000, 0);
            respBody.writeUint32LE(0x0000, 2);
            client.send(msg);
        }

        {
            const [msg, respBody] = client.getMessageBuffer(SA_LOBBY_ENTER, 0x6);
            respBody.writeUint16LE(0x0000, 0);
            respBody.writeUint32LE(0x0000, 2);
            client.send(msg);
        }

        {
            const gradeValue = 0;
            if (gradeValue !== 0) {
                console.error(`[ZGameLoginDispatch] !! Grade_Info_SN assertion failed: value=${gradeValue}, must be 0 -- refusing to send`);
            } else {
                const [msg, respBody] = client.getMessageBuffer(SN_GRADE_INFO, 4);
                respBody.writeUInt32LE(gradeValue, 0);
                client.send(msg);
                console.log(`[ZGameLoginDispatch] >> Sent SN_GRADE_INFO: value=0 (normal)`);
            }
        }

        {
            sendFullRoomList(client, rooms.listRooms(), getExactMessageBuffer);
        }
    }
};
