const NetworkClient = require("../client");
const { MAX_MAP_COUNT, MAX_MECH_COUNT, MAX_SLOT_COUNT } = require('../datatypes/enums');
const db = require('../database/db');
const serverConfig = require('../config/server');
const whitelist = require('../config/whitelist');

const { writeRecordInfoBody } = require('./record-info.builder');

const CQ_LOGIN_WASABII = 0x00110151;
const CQ_CREATE = 0x210201;

// Tutorial completion request from client (opcode candidates — log confirms which one fires)
const CQ_COMPLETE_A = 0x210122;
const CQ_COMPLETE_B = 0x210131;
const CQ_COMPLETE_C = 0x210132;
const CQ_COMPLETE_D = 0x210141;

const SA_LOGIN_WASABII = 0x00110152;
const SA_CREATE = 0x210202;

const SN_WAIT = 0x110131;
const SN_MAP_INFO = 0x210115;
const SN_LICENSE_INFO = 0x260101;
const SN_GRADE_INFO = 0x00510101;

const SN_DEFAULT_INFO = 0x210101;
const SN_PLAY_INFO = 0x210102;
const SN_RECORD_INFO = 0x210103;
const SN_MECH_LEVEL = 0x210104;
const SN_ITEM_INFO = 0x210111;
const SN_WEAR_INFO = 0x210113;         // DLL: WearInfo_SN
const SN_EXPIRATION_ITEM = 0x210112;   // DLL: ExpirationItem_SN
const SN_COMPLETE = 0x210121;

const { resolveRealMapIds, sendMapInfoSN } = require('./map-info.sender');

// ZDispatchGate
const CQ_LEAVE = 0x220131;

const SN_SERVER_ADD = 0x220101;
const SN_CHANNEL_ADD = 0x220102;

const SA_LEAVE = 0x220132;

const ACCOUNT_LEVEL_STR = { 0: '0\0', 1: '1\0', 2: '2\0', 3: '3\0', 4: '4\0' };

const cacheIndex = require('./cache-index');

module.exports =
class ZAccountDispatch
{
    dispatch(client, type, body)
    {
        switch (type)
        {
            case CQ_CREATE:
                return this.handleCreate(client, body).then(() => true);

            case CQ_LOGIN_WASABII:
                return this.handleLogin(client, body).then(() => true);

            case CQ_COMPLETE_A:
            case CQ_COMPLETE_B:
            case CQ_COMPLETE_C:
            case CQ_COMPLETE_D:
                return this.handleTutorialComplete(client, body, type).then(() => true);

            default: return false;
        }
    }

      /**
     * Handle tutorial completion packet from client.
     * Saves the completed tutorial to DB and refreshes SN_COMPLETE.
     */
    async handleTutorialComplete(client, body, opcode)
    {
        try {
            const tutorialId = body.length >= 1 ? body.readUint8(0) : 0;
            console.log(`[ZDispatchAccount::CQ_COMPLETE] opcode=0x${opcode.toString(16)} tutorialId=${tutorialId} body=${body.toString('hex')}`);

            if (client.accountId_ && tutorialId >= 1 && tutorialId <= 4) {
                await db.completeTutorial(client.accountId_, tutorialId);
                console.log(`[ZDispatchAccount::CQ_COMPLETE] Tutorial ${tutorialId} marked complete for account #${client.accountId_}`);
            }
        } catch (err) {
            console.error(`[ZDispatchAccount::CQ_COMPLETE] Error:`, err.message);
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

            if (!whitelist.isAllowed(username, client.socket_ && client.socket_.remoteAddress)) {
                client.disconnect();
                return;
            }

            //Store username on client
            client.username_ = username;

            const account = await db.getAccountByUsername(username);
            let resolvedAccount = account;
            if (!resolvedAccount) {
                if (!username || username.length > 25) {
                    client.disconnect();
                    return;
                }
                try {
                    const accountId = await db.createAccount(username, username, 101);
                    resolvedAccount = await db.getAccountById(accountId);
                    console.log(`[ZDispatchAccount::CQ_LOGIN_WASABII] Auto-registered account #${accountId} "${username}"`);
                } catch (err) {
                    if (err.code !== 'ER_DUP_ENTRY') throw err;
                    resolvedAccount = await db.getAccountByUsername(username);
                    if (!resolvedAccount) {
                        const nickname = `${username.slice(0, 14)}_${Date.now().toString(36)}`;
                        const accountId = await db.createAccount(username, nickname, 101);
                        resolvedAccount = await db.getAccountById(accountId);
                        console.log(`[ZDispatchAccount::CQ_LOGIN_WASABII] Auto-registered account #${accountId} "${username}"`);
                    }
                }
            }

            // Account exists - send full data from DB
            console.log(`[ZDispatchAccount::CQ_LOGIN_WASABII] Found account #${resolvedAccount.id} "${resolvedAccount.nickname}"`);
            await db.updateLastLogin(resolvedAccount.id);
            client.accountId_ = resolvedAccount.id;
            client.nickname_ = resolvedAccount.nickname;

            {
                const [msg, respBody] = client.getMessageBuffer(SA_LOGIN_WASABII, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
            }

            await this.sendAccountData(client, resolvedAccount);

        } catch (err) {

            const username = client.username_ || 'Player';
            console.error(`[ZDispatchAccount::CQ_LOGIN_WASABII] ERROR: DB failure for "${username}" at step=login (post-ack) code=${err.code} - disconnecting instead of faking login success:`, err.message);
            client.disconnect();
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
        client.pilot_ = Number(account.pilot) || 101;

        // Load all data from DB in parallel
        const [record, mechLevels, licenses, maps, tutorials, items] = await Promise.all([
            db.getRecord(accountId),
            db.getMechLevels(accountId),
            db.getMechLicenses(accountId),
            db.getMaps(accountId),
            db.getTutorials(accountId),
            db.getItems(accountId),
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
            writeRecordInfoBody(body, {
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

        // SN_GRADE_INFO — ZDispatchCommunity::Grade_Info_SN calls Account_Grade_Set(grade).
        // Account_Grade_Set sets nMedalLevel (offset 0x448) in ZNetwork_DJ.
        // Without this, nMedalLevel stays at default 255 → szMedalLevel[255] OOB crash.
        // Grade_Info_SN reads u32 at body[0], subtracts 11, switch(0..3) → grade 1-4.
        // value 11 → grade 1 (lowest valid tier).

        {
            const gradeValue = 0;
            if (gradeValue !== 0) {
                console.error(`[ZDispatchAccount] !! Grade_Info_SN assertion failed: value=${gradeValue}, must be 0 -- refusing to send`);
            } else {
                const [msg, body] = client.getMessageBuffer(SN_GRADE_INFO, 4);
                body.writeUInt32LE(gradeValue, 0);
                client.send(msg);
                console.log(`[ZDispatchAccount] >> Sent SN_GRADE_INFO: value=0 (normal)`);
            }
        }

        // SN_MECH_LEVEL — DLL reads u8 count (NOT u16), then 28-byte entries
        // Entry: [u32 mechType][u32 level][i64 exp][u32 kills][u32 deaths][u32 sorties]
        if (mechLevels.length > 0) {
            const MECH_RECORD_SIZE = 0x1c;
            const [msg, body] = client.getMessageBuffer(SN_MECH_LEVEL, 1 + (MECH_RECORD_SIZE * mechLevels.length));
            body.writeUint8(mechLevels.length, 0);
            let offset = 1;
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
            console.log(`[ZDispatchAccount] >> Sent SN_MECH_LEVEL: ${mechLevels.length} mechs`);
        }

        // SN_MAP_INFO
        {
            const fallbackIds = maps.map((map) => map.map_id);
            sendMapInfoSN(client, resolveRealMapIds() || fallbackIds);
        }

        // SN_LICENSE_INFO — DLL reads 9-byte entries as [u32 mechType][u8 pad][u32 type]
        // DLL switch: type==1 → permanent(2), type==2 → timed(1), else → none(0)
        if (licenses.length > 0) {
            const [msg, body] = client.getMessageBuffer(SN_LICENSE_INFO, 0x2 + (9 * licenses.length));
            let offset = 0;
            body[offset++] = 0x00;
            body[offset++] = licenses.length;
            for (const lic of licenses) {
                body.writeUint32LE(lic.mech_type, offset);
                body.writeUint8(0, offset + 4);
                body.writeUint32LE(lic.license_type || 1, offset + 5);
                offset += 9;
            }
            client.send(msg);
            console.log(`[ZDispatchAccount] >> Sent SN_LICENSE_INFO: ${licenses.length} licenses (type=${licenses[0].license_type||1})`);
        }

        await require('./item-info.sender').sendItemInfo(client, items, accountId, 'account');

        // SN_WEAR_INFO (0x210113) — DLL: WearInfo_SN
        // Header: [u8 success][u8 count][u32 pilotSerialIndex][u32 pilotItemIndex][u32 selectedMechType]

        // Slot 0=Mech(body/chassis), 1=MainWeapon, 2=LeftWeapon, 3=RightWeapon, 4=Equipment, 5=Skin
        {
            const ENTRY_SIZE = 52;
            const HEADER_SIZE = 14;
            const defaultMech = 1;

            const mechSlots = {};
            for (let m = 1; m <= MAX_MECH_COUNT; m++) {
                mechSlots[m] = Array.from({length: 6}, () => ({uniqueKey: 0, itemIndex: 0}));
            }

            const wearItems = await db.getItemsWithEquipViews(accountId);

            // All items: part_slot 0 = body/chassis → slot 0; 1-5 → slots 1-5
            for (const item of wearItems) {
                if (item.equipped && item.mech_type >= 1 && item.mech_type <= MAX_MECH_COUNT) {
                    const slot = Number(item.part_slot);
                    if (slot >= 0 && slot < 6 && mechSlots[item.mech_type]) {
                        const rawId = Number(item.item_id) || 0;
                        // body 슬롯(slot=0)은 Cache.Bin 인덱스로 변환 (body slot (slot=0) is converted to Cache.Bin index)
                        const BODY_IDX = {
                            11100101:84, 12100101:97, 13100101:110,
                            14200101:123, 14300101:130, 15200101:136,
                            16200101:149, 17100101:162, 18100101:175,
                        };
                        let itemIndex = rawId;
                        if (slot === 0) {
                            const girIndex = null;
                            if (girIndex != null) {
                                itemIndex = girIndex;
                            } else if (BODY_IDX[rawId] != null) {
                                itemIndex = BODY_IDX[rawId];
                            }
                        }
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
                const [msg, body] = client.getMessageBuffer(SN_WEAR_INFO,
                    HEADER_SIZE + (ENTRY_SIZE * mechEntries.length));

                body.writeUint8(1, 0);
                body.writeUint8(mechEntries.length, 1);
                body.writeUint32LE(0, 2);           // pilotSerialIndex
                body.writeUint32LE(client.pilot_, 6); // pilotItemIndex
                body.writeUint32LE(defaultMech, 10); // selectedMechType (1-based)

                let offset = HEADER_SIZE;
                for (const entry of mechEntries) {
                    body.writeUint32LE(entry.mechType, offset);
                    for (let s = 0; s < 6; s++) {

                        body.writeUint32LE(entry.slots[s].itemIndex, offset + 4 + s * 8);
                        body.writeUint32LE(entry.slots[s].uniqueKey, offset + 8 + s * 8);
                    }
                    offset += ENTRY_SIZE;
                }

                client.send(msg);
                const bodySlotCount = mechEntries.filter(e => e.slots[0].itemIndex !== 0).length;
                console.log(`[ZDispatchAccount] >> Sent SN_WEAR_INFO: ${mechEntries.length} mechs, default=${defaultMech}, pilot=${client.pilot_}, bodySlots=${bodySlotCount}`);
            }
        }

        // SN_COMPLETE — signals client that all account data has been sent.
        {
            const done = (tutorials || []).filter(t => t.completed).map(t => t.tutorial_id);
            const [msg, body] = client.getMessageBuffer(SN_COMPLETE, 0x100);
            body.writeUint16LE(0x0000, 0);
            body.writeInt32LE(0x0000, 2);
            let bitmask = 0;
            for (const id of done) bitmask |= (1 << (id - 1));
            body.writeUint8(bitmask, 6);
            client.send(msg);
            console.log(`[ZDispatchAccount] >> Sent SN_COMPLETE: tutorials bitmask=0x${bitmask.toString(16)} done=[${done.join(',')}]`);
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

            body.write(serverConfig.getPublicHost(), offset + 0x5);
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
