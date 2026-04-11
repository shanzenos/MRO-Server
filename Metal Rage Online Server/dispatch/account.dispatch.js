const NetworkClient = require("../client");
const { MAX_MAP_COUNT, MAX_MECH_COUNT, MAX_SLOT_COUNT } = require('../datatypes/enums');
const db = require('../database/db');

const CQ_LOGIN_WASABII = 0x00110151;
const CQ_CREATE = 0x210201;

const SA_LOGIN_WASABII = 0x00110152;
const SA_CREATE = 0x210202;

const SN_WAIT = 0x110131;
const SN_MAP_INFO = 0x210115;
const SN_LICENSE_INFO = 0x260101;

const SN_DEFAULT_INFO = 0x210101;
const SN_PLAY_INFO = 0x210102;
const SN_RECORD_INFO = 0x210103;
const SN_MECH_LEVEL = 0x210104;
const SN_RANK = 0x210105;
const SN_ITEM_INFO = 0x210111;
const SN_WEAR_INFO = 0x210112;    // Was mislabeled as SN_EXPIRATION_ITEM — this is WearInfo_SN!
const SN_EXPIRATION_ITEM = 0x210113;  // Actual ExpirationItem is the next ID
const SN_COMPLETE = 0x210121;


// ZDispatchGate
const CQ_LEAVE = 0x220131;

const SN_SERVER_ADD = 0x220101;
const SN_CHANNEL_ADD = 0x220102;

const SA_LEAVE = 0x220132;

const ACCOUNT_LEVEL_STR = { 1: '1\0', 2: '2\0', 3: '3\0', 4: '4\0' };

module.exports =
class ZAccountDispatch
{
    dispatch(client, type, body)
    {
        switch (type)
        {
            case CQ_CREATE:
                this.handleCreate(client, body);
                return true;

            case CQ_LOGIN_WASABII:
                this.handleLogin(client, body);
                return true;

            default: return false;
        }
    }

    /**
     * Handle character creation - create or update account in DB.
     * If the account was auto-created during login, update its nickname and pilot.
     * If no account exists yet, create one.
     */
    async handleCreate(client, body)
    {
        try {
            if (body.length != 0x1d) {
                client.disconnect();
                return;
            }

            const PILOT_ONE = 101;
            const PILOT_TWO = 102;

            const pilot = body.readUint32LE(0);
            if (pilot != PILOT_ONE && pilot != PILOT_TWO) {
                client.disconnect();
                return;
            }

            const nickname = body.subarray(4).toString('ascii').split('\0').shift();
            if (nickname.length < 2) {
                client.disconnect();
                return;
            }

            const username = client.username_ || nickname;

            // Check if nickname is avaliable
            const existing = await db.getAccountByNickname(nickname);
            if (existing && existing.username !== username) {
                console.log(`[ZDispatchAccount::CQ_CREATE] Nickname "${nickname}" already taken`);
                const [msg, respBody] = client.getMessageBuffer(SA_CREATE, 0x6);
                respBody.writeUint16LE(0x0001, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
                return;
            }

            // Update auto-created account or create a new one
            const autoCreated = await db.getAccountByUsername(username);
            if (autoCreated) {
                await db.pool.execute(
                    'UPDATE accounts SET nickname = ?, pilot = ? WHERE id = ?',
                    [nickname, pilot, autoCreated.id]
                );
                console.log(`[ZDispatchAccount::CQ_CREATE] Updated auto-created account #${autoCreated.id}: nickname="${nickname}", pilot=${pilot}`);
            } else {
                const accountId = await db.createAccount(username, nickname, pilot);
                console.log(`[ZDispatchAccount::CQ_CREATE] Created account #${accountId} for "${nickname}" (pilot ${pilot})`);
            }

            // Success response
            {
                const [msg, respBody] = client.getMessageBuffer(SA_CREATE, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
            }

            // Send account data so client transitions into lobby
            const account = await db.getAccountByUsername(username);
            await this.sendAccountData(client, account);

        } catch (err) {
            console.error(`[ZDispatchAccount::CQ_CREATE] Error:`, err.message);
            client.disconnect();
        }
    }

    /**
     * Handle login - look up account in DB, send data or wait for creation
     */
    async handleLogin(client, body)
    {
        try {
            if (body.length != 0x381) {
                client.disconnect();
                return;
            }

            const username = body.subarray(0, 0x19).toString('ascii').split('\0').shift();
            console.log(`[ZDispatchAccount::CQ_LOGIN_WASABII] Processing login for "${username}"`);

            //Store username on client
            client.username_ = username;

            //SA_LOGIN_WASABII - always succeed (no auth)
            {
                const [msg, respBody] = client.getMessageBuffer(SA_LOGIN_WASABII, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
            }

            let account = await db.getAccountByUsername(username);

            if (!account) {
                //Auto-create account on first login
                // Client may skip CQ_CREATE if it has cached or existing profile data
                console.log(`[ZDispatchAccount::CQ_LOGIN_WASABII] No account for "${username}" - auto-creating with defaults`);

                try {
                    const accountId = await db.createAccount(username, username, 101);
                    console.log(`[ZDispatchAccount::CQ_LOGIN_WASABII] Auto-created account #${accountId} for "${username}"`);
                    account = await db.getAccountByUsername(username);
                } catch (dbErr) {
                    console.error(`[ZDispatchAccount::CQ_LOGIN_WASABII] DB auto-create failed:`, dbErr.message);
                    // Fall through - account will still be null and we'll use the existing flow
                }
            }

            if (!account) {
                //If database fails, send default data so client doesn't crash or hang
                console.log(`[ZDispatchAccount::CQ_LOGIN_WASABII] DB unavailable - sending hardcoded defaults`);
                client.nickname_ = username;

                // SN_DEFAULT_INFO
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_DEFAULT_INFO, 0x1b);
                    respBody.write('1\0', 0);
                    respBody.write(username + '\0', 2);
                    client.send(msg);
                }

                // SN_PLAY_INFO (critical for room creation)
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_PLAY_INFO, 0x16);
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

                // SN_RECORD_INFO (empty/level 1)
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_RECORD_INFO, 0x60);
                    respBody.writeUint32LE(1, 0);
                    client.send(msg);
                }

                // SN_MECH_LEVEL (all mechs level 1)
                {
                    const MAX_NUM_MECHS = 8;
                    const MECH_RECORD_SIZE = 0x1c;
                    const [msg, respBody] = client.getMessageBuffer(SN_MECH_LEVEL, 0x2 + (MECH_RECORD_SIZE * MAX_NUM_MECHS));
                    respBody.writeUint16LE(MAX_NUM_MECHS, 0);
                    let offset = 0;
                    for (let i = 0; i < MAX_NUM_MECHS; ++i) {
                        respBody.writeUint32LE(i + 1, offset);
                        respBody.writeUint32LE(1, offset + 4);
                        offset += MECH_RECORD_SIZE;
                    }
                    client.send(msg);
                }

                // SN_MAP_INFO
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_MAP_INFO, 0x2 + (4 * MAX_MAP_COUNT));
                    let offset = 0;
                    respBody[offset++] = 0x00;
                    respBody[offset++] = MAX_MAP_COUNT;
                    for (let i = 0; i < MAX_MAP_COUNT; ++i, offset += 4)
                        respBody.writeUint32LE(i, offset);
                    client.send(msg);
                }

                // SN_LICENSE_INFO
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_LICENSE_INFO, 0x2 + (9 * MAX_SLOT_COUNT));
                    let offset = 0;
                    respBody[offset++] = 0x00;
                    respBody[offset++] = MAX_SLOT_COUNT;
                    for (let i = 0; i < MAX_SLOT_COUNT; ++i, offset += 9) {
                        respBody.writeUint32LE(i + 1, offset);
                        respBody.writeUint32LE(1, offset + 5);
                    }
                    client.send(msg);
                }

                // SN_ITEM_INFO (empty inventory — correct header format)
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_ITEM_INFO, 0x6);
                    respBody.writeUint8(1, 0);      // SuccessFlag = 1 (valid)
                    respBody.writeUint8(0, 1);      // ItemCount = 0
                    respBody.writeUint32LE(0, 2);   // AccountKey = 0
                    client.send(msg);
                }

                // SN_COMPLETE
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_COMPLETE, 0x100);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeInt32LE(0x0000, 2);
                    client.send(msg);
                }

                // Gate info
                this.sendGateInfo(client);
                return;
            }

            // Account exists - send full data from DB
            console.log(`[ZDispatchAccount::CQ_LOGIN_WASABII] Found account #${account.id} "${account.nickname}"`);
            await db.updateLastLogin(account.id);
            client.accountId_ = account.id;
            client.nickname_ = account.nickname;

            await this.sendAccountData(client, account);

        } catch (err) {
            console.error(`[ZDispatchAccount::CQ_LOGIN_WASABII] Error:`, err.message);
            console.log(`[ZDispatchAccount::CQ_LOGIN_WASABII] DB unavailable - sending hardcoded defaults`);

            try {
                const username = client.username_ || 'Player';
                client.nickname_ = username;

                // SA_LOGIN_WASABII - success
                {
                    const [msg, respBody] = client.getMessageBuffer(SA_LOGIN_WASABII, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                }

                // SN_DEFAULT_INFO
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_DEFAULT_INFO, 0x1b);
                    respBody.write('1\0', 0);
                    respBody.write(username + '\0', 2);
                    client.send(msg);
                }

                // SN_PLAY_INFO (critical for room creation)
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_PLAY_INFO, 0x16);
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

                // SN_RECORD_INFO
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_RECORD_INFO, 0x60);
                    respBody.writeUint32LE(1, 0);
                    client.send(msg);
                }

                // SN_MECH_LEVEL
                {
                    const MAX_NUM_MECHS = 8;
                    const MECH_RECORD_SIZE = 0x1c;
                    const [msg, respBody] = client.getMessageBuffer(SN_MECH_LEVEL, 0x2 + (MECH_RECORD_SIZE * MAX_NUM_MECHS));
                    respBody.writeUint16LE(MAX_NUM_MECHS, 0);
                    let offset = 0;
                    for (let i = 0; i < MAX_NUM_MECHS; ++i) {
                        respBody.writeUint32LE(i + 1, offset);
                        respBody.writeUint32LE(1, offset + 4);
                        offset += MECH_RECORD_SIZE;
                    }
                    client.send(msg);
                }

                // SN_MAP_INFO
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_MAP_INFO, 0x2 + (4 * MAX_MAP_COUNT));
                    let offset = 0;
                    respBody[offset++] = 0x00;
                    respBody[offset++] = MAX_MAP_COUNT;
                    for (let i = 0; i < MAX_MAP_COUNT; ++i, offset += 4)
                        respBody.writeUint32LE(i, offset);
                    client.send(msg);
                }

                // SN_LICENSE_INFO
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_LICENSE_INFO, 0x2 + (9 * MAX_SLOT_COUNT));
                    let offset = 0;
                    respBody[offset++] = 0x00;
                    respBody[offset++] = MAX_SLOT_COUNT;
                    for (let i = 0; i < MAX_SLOT_COUNT; ++i, offset += 9) {
                        respBody.writeUint32LE(i + 1, offset);
                        respBody.writeUint32LE(1, offset + 5);
                    }
                    client.send(msg);
                }

                // SN_ITEM_INFO (empty)
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_ITEM_INFO, 0x6);
                    respBody.writeUint8(1, 0);
                    respBody.writeUint8(0, 1);
                    respBody.writeUint32LE(0, 2);
                    client.send(msg);
                }

                // SN_COMPLETE
                {
                    const [msg, respBody] = client.getMessageBuffer(SN_COMPLETE, 0x100);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeInt32LE(0x0000, 2);
                    client.send(msg);
                }

                // Gate info
                this.sendGateInfo(client);
            } catch (e2) {
                console.error(`[ZDispatchAccount] Fallback also failed:`, e2.message);
                client.disconnect();
            }
        }
    }

    /**
     * Send full account data from database to client
     */
    async sendAccountData(client, account)
    {
        const accountId = account.id;
        client.accountId_ = accountId;
        client.nickname_ = account.nickname;

        // Load all data from DB in parallel
        const [record, mechLevels, licenses, maps] = await Promise.all([
            db.getRecord(accountId),
            db.getMechLevels(accountId),
            db.getMechLicenses(accountId),
            db.getMaps(accountId),
        ]);

        // SN_DEFAULT_INFO
        {
            const levelStr = ACCOUNT_LEVEL_STR[account.account_level] || '1\0';
            const [msg, body] = client.getMessageBuffer(SN_DEFAULT_INFO, 0x1b);
            body.write(levelStr, 0);
            body.write(account.nickname + '\0', 2);
            client.send(msg);
        }

        // SN_PLAY_INFO
        // ZNetwork.dll - ZDispatchAccount::PlayInfo_SN
        // calls SetField3F8(1) unconditionally, then adds entries to the room data table
        //
        // Body: i64 playTime(8) + u8 pad(1) + u8 entryCount(1) + entries(12 each)
        // Entry: i32 value1 + u16 value2 + u16 value3 + i32 value4
        {
            const entryCount = 1;
            const bodySize = 0x0A + (entryCount * 0x0C);
            const [msg, body] = client.getMessageBuffer(SN_PLAY_INFO, bodySize);
            // PlayTime (int64 LE) — 0 for now
            body.writeUint32LE(0, 0);
            body.writeUint32LE(0, 4);
            // Padding byte
            body.writeUint8(0, 8);
            // Entry count (must be above 1)
            body.writeUint8(entryCount, 9);
            // Entry[0]: 12 bytes
            body.writeInt32LE(1, 0x0A);     // value1 (level/exp)
            body.writeUint16LE(1, 0x0E);    // value2 (mech type?)
            body.writeUint16LE(0, 0x10);    // value3 (flag)
            body.writeInt32LE(0, 0x12);     // value4
            client.send(msg);
        }

        // SN_RECORD_INFO
        if (record) {
            const [msg, body] = client.getMessageBuffer(SN_RECORD_INFO, 0x60);
            body.writeUint32LE(record.level, 0);
            body.writeBigUint64LE(BigInt(record.exp), 4);
            body.writeBigUint64LE(BigInt(record.exp_max), 12);
            body.writeUint32LE(record.wins, 20);
            body.writeUint32LE(record.losses, 24);
            body.writeUint32LE(record.draws, 28);
            body.writeUint32LE(record.kills, 32);
            body.writeUint32LE(record.deaths, 36);
            client.send(msg);
        }

        // SN_MECH_LEVEL
        if (mechLevels.length > 0) {
            const MECH_RECORD_SIZE = 0x1c;
            const [msg, body] = client.getMessageBuffer(SN_MECH_LEVEL, 0x2 + (MECH_RECORD_SIZE * mechLevels.length));
            let offset = 0;

            body.writeUint16LE(mechLevels.length, 0);
            for (const mech of mechLevels) {
                body.writeUint32LE(mech.mech_type, offset);
                body.writeUint32LE(mech.level, offset + 4);
                body.writeBigUint64LE(BigInt(mech.exp), offset + 8);
                body.writeUint32LE(mech.kills, offset + 16);
                body.writeUint32LE(mech.deaths, offset + 20);
                body.writeUint32LE(mech.sorties, offset + 24);
                offset += MECH_RECORD_SIZE;
            }
            client.send(msg);
        }

        // SN_MAP_INFO
        {
            const mapCount = maps.length || MAX_MAP_COUNT;
            const [msg, body] = client.getMessageBuffer(SN_MAP_INFO, 0x2 + (4 * mapCount));
            let offset = 0;
            body[offset++] = 0x00;
            body[offset++] = mapCount;
            for (const map of maps) {
                body.writeUint32LE(map.map_id, offset);
                offset += 4;
            }
            client.send(msg);
        }

        // SN_LICENSE_INFO
        if (licenses.length > 0) {
            const [msg, body] = client.getMessageBuffer(SN_LICENSE_INFO, 0x2 + (9 * licenses.length));
            let offset = 0;
            body[offset++] = 0x00;
            body[offset++] = licenses.length;
            for (const lic of licenses) {
                body.writeUint32LE(lic.mech_type, offset);
                body.writeUint32LE(lic.license_type, offset + 5);
                offset += 9;
            }
            client.send(msg);
        }

        // SN_ITEM_INFO — Equipment/inventory data.
        // ZNetwork.dll (ZDispatchAccount::ItemInfo_SN):
        //
        // Header:
        //   u8  SuccessFlag  (non-zero = valid)
        //   u8  ItemCount
        //   u32 AccountKey   (skipped by handler)
        //
        // Per-item record: 35 bytes (0x23)
        //   u32 UniqueKey    (item instance ID)
        //   u32 ItemIndex    (item type code)
        //   u32 EquipStatus  (1 = equipped)
        //   u32 (padding)
        //   u16 Field_10
        //   u32 Field_12
        //   u8  Field_16
        //   u32 Field_17
        //   u32 Field_1B
        //   u32 Field_1F
        //
        // Debug string confirms: "UniqueKey : %d, ItemIndex : %d"
        {
            const items = await db.getItems(accountId);
            const ITEM_RECORD_SIZE = 35;
            const headerSize = 6; // u8 + u8 + u32
            const [msg, body] = client.getMessageBuffer(SN_ITEM_INFO, headerSize + (ITEM_RECORD_SIZE * items.length));

            body.writeUint8(1, 0);                        // SuccessFlag = 1 (valid)
            body.writeUint8(items.length, 1);              // ItemCount
            body.writeUint32LE(accountId || 0, 2);         // AccountKey

            let offset = headerSize;
            for (const item of items) {
                body.writeUint32LE(item.id || 0, offset);           // UniqueKey (DB auto-increment ID)
                body.writeUint32LE(item.item_id, offset + 0x04);    // ItemIndex (item type code)
                body.writeUint32LE(item.equipped ? 1 : 0, offset + 0x08); // EquipStatus
                body.writeUint32LE(0, offset + 0x0C);               // padding
                body.writeUint16LE(item.mech_type || 0, offset + 0x10);  // Field_10 (mech type?)
                body.writeUint32LE(item.part_slot || 0, offset + 0x12);  // Field_12 (part slot?)
                body.writeUint8(item.equipped ? 2 : 0, offset + 0x16); // Field_16 (use type: 2=equipment)
                body.writeUint32LE(item.quantity || 1, offset + 0x17);   // Field_17 (quantity)
                body.writeUint32LE(0xFFFFFFFF, offset + 0x1B);      // Field_1B (expiration — 0xFFFFFFFF = permanent)
                body.writeUint32LE(0xFFFFFFFF, offset + 0x1F);      // Field_1F (expiration2 — 0xFFFFFFFF = permanent)
                offset += ITEM_RECORD_SIZE;
            }
            client.send(msg);
        }

        // SN_WEAR_INFO — Equipment loadout per mech.
        // ZNetwork.dll (ZDispatchAccount::WearInfo_SN):
        //
        // Header (14 bytes):
        //   u8   SuccessFlag
        //   u8   EntryCount (N — one per mech type)
        //   u32  AccountKey
        //   u32  Unknown (init value, 0 is safe)
        //   u32  DefaultMechType (1-8, sets active mech)
        //
        // Per-mech entry (52 bytes each):
        //   u32  MechType (1-8)
        //   For each of 6 part slots (Body, Primary, SubL, SubR, Booster, Equipment):
        //     u32  UniqueKey (item instance ID)
        //     u32  ItemIndex (item type code, used by EquipPart)
        {
            const items = await db.getItems(accountId);
            const ENTRY_SIZE = 52;  // 4 + 6 * (4 + 4)
            const HEADER_SIZE = 14;
            const defaultMech = 1;  // DefaultMechType (1-8), NOT pilot skin ID

            //Build mech equipment map from itemID's
            const mechSlots = {};  // mechType -> [6 pairs of {uniqueKey, itemIndex}]
            for (let m = 1; m <= MAX_MECH_COUNT; m++) {
                mechSlots[m] = Array.from({length: 6}, () => ({uniqueKey: 0, itemIndex: 0}));
            }

            for (const item of items) {
                if (item.equipped && item.mech_type >= 1 && item.mech_type <= MAX_MECH_COUNT) {
                    const slot = item.part_slot;
                    if (slot >= 0 && slot < 6 && mechSlots[item.mech_type]) {
                        mechSlots[item.mech_type][slot] = {
                            uniqueKey: item.id || 0,
                            itemIndex: item.item_id || 0,
                        };
                    }
                }
            }

            //Count how many mechs have any equipped items
            const mechEntries = [];
            for (let m = 1; m <= MAX_MECH_COUNT; m++) {
                const slots = mechSlots[m];
                if (slots.some(s => s.itemIndex !== 0)) {
                    mechEntries.push({mechType: m, slots});
                }
            }

            if (mechEntries.length > 0) {
                const [msg, body] = client.getMessageBuffer(SN_WEAR_INFO,
                    HEADER_SIZE + (ENTRY_SIZE * mechEntries.length));

                //Header
                body.writeUint8(1, 0);                              // SuccessFlag
                body.writeUint8(mechEntries.length, 1);             // EntryCount
                body.writeUint32LE(accountId || 0, 2);              // AccountKey
                body.writeUint32LE(0, 6);                           // Unknown
                body.writeUint32LE(defaultMech, 10);                // DefaultMechType

                //Per-mech entries
                let offset = HEADER_SIZE;
                for (const entry of mechEntries) {
                    body.writeUint32LE(entry.mechType, offset);     // MechType
                    for (let s = 0; s < 6; s++) {
                        body.writeUint32LE(entry.slots[s].uniqueKey, offset + 4 + s * 8);
                        body.writeUint32LE(entry.slots[s].itemIndex, offset + 4 + s * 8 + 4);
                    }
                    offset += ENTRY_SIZE;
                }

                client.send(msg);
                console.log(`[ZDispatchAccount] >> Sent SN_WEAR_INFO: ${mechEntries.length} mechs, default=${defaultMech}`);
            }
        }

        // SN_COMPLETE
        {
            const [msg, body] = client.getMessageBuffer(SN_COMPLETE, 0x100);
            body.writeUint16LE(0x0000, 0);
            body.writeInt32LE(0x0000, 2);
            client.send(msg);
        }

        // Gate server/channel info
        this.sendGateInfo(client);
    }

    /**
     * Send server and channel list for the gate UI
     */
    sendGateInfo(client)
    {
        // SN_SERVER_ADD
        {
            const [msg, body] = client.getMessageBuffer(SN_SERVER_ADD, 0x2 + 0xd2);
            body[0] = 0x00;
            body[1] = 0x01;

            let offset = 0x2;
            body.write('Dev0', offset + 0x0);
            body.write('127.0.0.1', offset + 0x5);
            body.write('Developer Gate', offset + 0x15);
            body.write('GS', offset + 0xad);

            body.writeUint32LE(3, offset + 0xB0);
            body.writeUint16LE(30907, offset + 0xB8);
            body.writeUint16LE(128, offset + 0xBA);
            body.writeUint32LE(1, offset + 0xCC);
            body.writeUint16LE(0, offset + 0xD0);

            client.send(msg);
        }

        // SN_CHANNEL_ADD
        {
            const [msg, body] = client.getMessageBuffer(SN_CHANNEL_ADD, 0x2 + 0x5 + 0x37);
            body[0] = 0x00;
            body[1] = 0x01;

            body.write('Dev0', 0x2);
            let offset = 0x2 + 0x5;

            body[offset] = 1;
            body.writeUint16LE(0, offset + 0x1);
            body.writeUint16LE(128, offset + 0x3);
            body.writeUint32LE(1024, offset + 0x11);
            body[offset + 0x15] = 0;
            body[offset + 0x1a] = 1;
            body.write('Developer Channel', offset + 0x1e);

            client.send(msg);
        }
    }
};
