const NetworkClient = require("../client");
const db = require('../database/db');

// Game server login handler
// After connecting to the game server (port 30907), the client sends
// 0x00110124 (CQ) to authenticate/enter. We respond with 0x00110125 (SA).
// Then replay account data from the database.

const CQ_GAME_LOGIN = 0x00110124;
const SA_GAME_LOGIN = 0x00110125;

const SN_DEFAULT_INFO  = 0x00210101;
const SN_RECORD_INFO   = 0x00210103;
const SN_MECH_LEVEL    = 0x00210104;
const SN_GRADE_INFO    = 0x00510101;   // ZDispatchCommunity::Grade_Info_SN → Account_Grade_Set → nMedalLevel
const SN_WEAR_INFO     = 0x00210113;   // DLL: WearInfo_SN (0x210112 = ExpirationItem_SN)
const SN_COMPLETE      = 0x00210121;
const SA_LOBBY_ENTER   = 0x00230112;
const SN_LICENSE_INFO  = 0x00260101;   // must be sent before SN_COMPLETE / lobby enter
const { MAX_MECH_COUNT, MAX_SLOT_COUNT } = require('../datatypes/enums');

const ACCOUNT_LEVEL_STR = { 1: '1\0', 2: '2\0', 3: '3\0', 4: '4\0' };
const BODY_CACHE_INDEX_BY_ITEM_ID = {
    11100101: 84,
    12100101: 97,
    13100101: 110,
    14200101: 123,
    14300101: 130,
    15200101: 136,
    16200101: 149,
    17100101: 162,
    18100101: 175,
};

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
                this.handleGameLogin(client, body);
                return true;

            case 0x00220111:
                this.handleChannelEnter(client, body);
                return true;

            default:
                return false;
        }
    }

    async handleGameLogin(client, body)
    {
        try {
            console.log(`[ZGameLoginDispatch] >> Game server login request`);

            // SA_GAME_LOGIN - success
            {
                const [msg, respBody] = client.getMessageBuffer(SA_GAME_LOGIN, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
            }

            // Load the most recently logged-in account
            // The game server is a separate TCP connection from the dispatch server,
            // Use last_login to find who just authenticated.
            let account = null;
            let tutorials = [];   // declared here so SN_COMPLETE can always access it
            {
                const [rows] = await db.pool.execute(
                    'SELECT * FROM accounts ORDER BY last_login DESC LIMIT 1'
                );
                if (rows.length > 0) account = rows[0];
            }

            if (account) {
                // Store account info on the client for other dispatchers
                client.accountId_ = account.id;
                client.nickname_ = account.nickname;
                client.pilot_ = Number(account.pilot) || 101;

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
                    for (let i = 0; i < 0x60; i += 4) respBody.writeUint32LE(0, i);
                    respBody.writeUint32LE(record.level, 0x00);
                    respBody.writeUint32LE(record.wins, 0x14);
                    respBody.writeUint32LE(record.draws, 0x18);
                    respBody.writeUint32LE(record.losses, 0x1C);
                    respBody.writeUint32LE(record.kills, 0x20);
                    respBody.writeUint32LE(record.deaths, 0x24);
                    respBody.writeBigUint64LE(BigInt(record.exp), 0x40);
                    respBody.writeBigUint64LE(BigInt(record.exp_max), 0x48);
                    client.send(msg);
                }

                // SN_GRADE_INFO (value=11 → grade 1)
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_GRADE_INFO, 4);
                    respBody.writeUInt32LE(11, 0);
                    client.send(msg);
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


                // SN_ITEM_INFO — equipment only. Body rows disconnect in
                // ItemInfo_SN/Item_Add and are only referenced by WearInfo.
                {
                    const ITEM_RECORD_SIZE = 35;
                    const headerSize = 6;
                    const [msg, respBody] = client.getMessageBuffer(0x00210111, headerSize + (ITEM_RECORD_SIZE * equipmentItems.length));
                    respBody.writeUint8(1, 0);                         // SuccessFlag
                    respBody.writeUint8(equipmentItems.length, 1);      // ItemCount
                    respBody.writeUint32LE(account.id || 0, 2);        // AccountKey
                    let offset = headerSize;
                    for (const item of equipmentItems) {
                        respBody.writeUint32LE(item.id || 0, offset);
                        respBody.writeUint32LE(item.item_id, offset + 0x04);
                        respBody.writeUint32LE(item.equipped ? 1 : 0, offset + 0x08);
                        respBody.writeUint32LE(0, offset + 0x0C);
                        respBody.writeUint16LE(item.mech_type || 0, offset + 0x10);
                        respBody.writeUint32LE(item.part_slot || 0, offset + 0x12);
                        respBody.writeUint8(item.equipped ? 2 : 0, offset + 0x16);  // use type: 2=equipment
                        respBody.writeUint32LE(item.quantity || 1, offset + 0x17);
                        respBody.writeUint32LE(0xFFFFFFFF, offset + 0x1B);         // expiration = permanent
                        respBody.writeUint32LE(0xFFFFFFFF, offset + 0x1F);         // expiration2 = permanent
                        offset += ITEM_RECORD_SIZE;
                    }
                    client.send(msg);
                    console.log(`[ZGameLoginDispatch] >> Sent SN_ITEM_INFO: ${equipmentItems.length} items (equipment only)`);
                }

                // SN_WEAR_INFO (0x210113) — DLL: WearInfo_SN
                // Header: [u8 suc][u8 cnt][u32 pilotSerialIndex][u32 pilotItemIndex][u32 selectedMechType]
                // Entry (52 bytes): [u32 mechType] + 6 x [u32 serialIndex, u32 itemIndex]
                // Slot 0=Mech(body), 1=MainWeapon, 2=LeftWeapon, 3=RightWeapon, 4=Equipment, 5=Skin
                {
                    const ENTRY_SIZE = 52;
                    const HEADER_SIZE = 14;
                    const defaultMech = 1;

                    const mechSlots = {};
                    for (let m = 1; m <= MAX_MECH_COUNT; m++) {
                        mechSlots[m] = Array.from({length: 6}, () => ({uniqueKey: 0, itemIndex: 0}));
                    }

                    // All items: slot 0 = body/chassis, slots 1-5 = weapons/equipment
                    for (const item of items) {
                        if (item.equipped && item.mech_type >= 1 && item.mech_type <= MAX_MECH_COUNT) {
                            const slot = Number(item.part_slot);
                            if (slot >= 0 && slot < 6 && mechSlots[item.mech_type]) {
                                mechSlots[item.mech_type][slot] = {
                                    uniqueKey: item.id || 0,
                                    itemIndex: item.item_id || 0,
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
                                respBody.writeUint32LE(entry.slots[s].uniqueKey, offset + 4 + s * 8);
                                respBody.writeUint32LE(entry.slots[s].itemIndex, offset + 4 + s * 8 + 4);
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

                console.log(`[ZGameLoginDispatch] >> Sent DB account data for "${account.nickname}"`);

            } else {
                // No DB record — fallback to minimal data so the client doesn't hang
                console.log(`[ZGameLoginDispatch] >> No DB account found, sending defaults`);
                client.nickname_ = 'Player';

                {
                    const [msg, respBody] = client.getMessageBuffer(SN_DEFAULT_INFO, 0x1b);
                    respBody.write('4\0', 0);
                    respBody.write('Player\0', 2);
                    client.send(msg);
                }

                // SN_PLAY_INFO (critical for room creation)
                {
                    const [msg, respBody] = client.getMessageBuffer(0x00210102, 0x16);
                    respBody.writeUint32LE(0, 0); respBody.writeUint32LE(0, 4);
                    respBody.writeUint8(0, 8); respBody.writeUint8(1, 9);
                    respBody.writeInt32LE(1, 0x0A); respBody.writeUint16LE(1, 0x0E);
                    respBody.writeUint16LE(0, 0x10); respBody.writeInt32LE(0, 0x12);
                    client.send(msg);
                }

                {
                    const [msg, respBody] = client.getMessageBuffer(SN_RECORD_INFO, 0x60);
                    respBody.writeUint32LE(1, 0);
                    client.send(msg);
                }

                // SN_GRADE_INFO (value=11 → grade 1)
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_GRADE_INFO, 4);
                    respBody.writeUInt32LE(11, 0);
                    client.send(msg);
                }

                {
                    const MAX_NUM_MECHS = 8;
                    const MECH_RECORD_SIZE = 0x1c;
                    const [msg, respBody] = client.getMessageBuffer(SN_MECH_LEVEL, 1 + (MECH_RECORD_SIZE * MAX_NUM_MECHS));
                    respBody.writeUint8(MAX_NUM_MECHS, 0);
                    let offset = 1;
                    for (let i = 0; i < MAX_NUM_MECHS; ++i) {
                        respBody.writeUint32LE(i + 1, offset);
                        respBody.writeUint32LE(1, offset + 4);
                        offset += MECH_RECORD_SIZE;
                    }
                    client.send(msg);
                }

                // SN_ITEM_INFO (empty inventory — correct header format)
                {
                    const [msg, respBody] = client.getMessageBuffer(0x00210111, 0x6);
                    respBody.writeUint8(1, 0);      // SuccessFlag
                    respBody.writeUint8(0, 1);      // ItemCount = 0
                    respBody.writeUint32LE(0, 2);   // AccountKey
                    client.send(msg);
                }
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
            console.error(`[ZGameLoginDispatch] >> DB Error:`, err.message);
            //Send minimal hardcoded data to prevent crash
            {
                const [msg, respBody] = client.getMessageBuffer(SN_DEFAULT_INFO, 0x1b);
                respBody.write('4\0', 0);
                respBody.write('Player\0', 2);
                client.send(msg);
            }
            {
                const [msg, respBody] = client.getMessageBuffer(0x00210102, 0x16);
                respBody.writeUint32LE(0, 0); respBody.writeUint32LE(0, 4);
                respBody.writeUint8(0, 8); respBody.writeUint8(1, 9);
                respBody.writeInt32LE(1, 0x0A); respBody.writeUint16LE(1, 0x0E);
                respBody.writeUint16LE(0, 0x10); respBody.writeInt32LE(0, 0x12);
                client.send(msg);
            }
            {
                const [msg, respBody] = client.getMessageBuffer(SN_RECORD_INFO, 0x60);
                respBody.writeUint32LE(1, 0);
                client.send(msg);
            }
            // SN_GRADE_INFO (value=11 → grade 1)
            {
                const [msg, respBody] = client.getMessageBuffer(SN_GRADE_INFO, 4);
                respBody.writeUInt32LE(11, 0);
                client.send(msg);
            }
            {
                const [msg, respBody] = client.getMessageBuffer(0x00210111, 0x6);
                respBody.writeUint8(1, 0);      // SuccessFlag
                respBody.writeUint8(0, 1);      // ItemCount = 0
                respBody.writeUint32LE(0, 2);   // AccountKey
                client.send(msg);
            }
            {
                const [msg, respBody] = client.getMessageBuffer(SN_COMPLETE, 0x100);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeInt32LE(0x0000, 2);
                client.send(msg);
            }
            {
                const [msg, respBody] = client.getMessageBuffer(SA_LOBBY_ENTER, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
            }
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
            const [msg, respBody] = client.getMessageBuffer(SN_GRADE_INFO, 4);
            respBody.writeUInt32LE(11, 0);
            client.send(msg);
            console.log(`[ZGameLoginDispatch] >> Sent SN_GRADE_INFO: value=11 (grade=1)`);
        }

    }
};
