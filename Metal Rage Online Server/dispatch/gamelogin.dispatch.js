const NetworkClient = require("../client");
const db = require('../database/db');

// Game server login handler
// After connecting to the game server (port 30907), the client sends
// 0x00110124 (CQ) to authenticate/enter. We respond with 0x00110125 (SA).
// Then replay account data from the database.

const CQ_GAME_LOGIN = 0x00110124;
const SA_GAME_LOGIN = 0x00110125;

const SN_DEFAULT_INFO = 0x00210101;
const SN_RECORD_INFO = 0x00210103;
const SN_MECH_LEVEL  = 0x00210104;
const SN_WEAR_INFO   = 0x00210112;
const SN_COMPLETE    = 0x00210121;
const SA_LOBBY_ENTER = 0x00230112;
const { MAX_MECH_COUNT } = require('../datatypes/enums');

const ACCOUNT_LEVEL_STR = { 1: '1\0', 2: '2\0', 3: '3\0', 4: '4\0' };

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

                const [record, mechLevels, items] = await Promise.all([
                    db.getRecord(account.id),
                    db.getMechLevels(account.id),
                    db.getItems(account.id),
                ]);

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

                // SN_RECORD_INFO
                if (record) {
                    const [msg, respBody] = client.getMessageBuffer(SN_RECORD_INFO, 0x60);
                    respBody.writeUint32LE(record.level, 0);
                    respBody.writeBigUint64LE(BigInt(record.exp), 4);
                    respBody.writeBigUint64LE(BigInt(record.exp_max), 12);
                    respBody.writeUint32LE(record.wins, 20);
                    respBody.writeUint32LE(record.losses, 24);
                    respBody.writeUint32LE(record.draws, 28);
                    respBody.writeUint32LE(record.kills, 32);
                    respBody.writeUint32LE(record.deaths, 36);
                    client.send(msg);
                }

                // SN_MECH_LEVEL
                if (mechLevels.length > 0) {
                    const MECH_RECORD_SIZE = 0x1c;
                    const [msg, respBody] = client.getMessageBuffer(SN_MECH_LEVEL, 0x2 + (MECH_RECORD_SIZE * mechLevels.length));
                    respBody.writeUint16LE(mechLevels.length, 0);
                    let offset = 2;
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

                // SN_ITEM_INFO — mech equipment/inventory (35-byte per-item format)
                {
                    const ITEM_RECORD_SIZE = 35;
                    const headerSize = 6;
                    const [msg, respBody] = client.getMessageBuffer(0x00210111, headerSize + (ITEM_RECORD_SIZE * items.length));
                    respBody.writeUint8(1, 0);                         // SuccessFlag
                    respBody.writeUint8(items.length, 1);              // ItemCount
                    respBody.writeUint32LE(account.id || 0, 2);        // AccountKey
                    let offset = headerSize;
                    for (const item of items) {
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
                }

                // SN_WEAR_INFO — which items are equipped on which mech
                {
                    const ENTRY_SIZE = 52;
                    const HEADER_SIZE = 14;
                    const defaultMech = 1;  // DefaultMechType (1-8), NOT pilot skin ID

                    const mechSlots = {};
                    for (let m = 1; m <= MAX_MECH_COUNT; m++) {
                        mechSlots[m] = Array.from({length: 6}, () => ({uniqueKey: 0, itemIndex: 0}));
                    }
                    for (const item of items) {
                        if (item.equipped && item.mech_type >= 1 && item.mech_type <= MAX_MECH_COUNT) {
                            const slot = item.part_slot;
                            if (slot >= 0 && slot < 6) {
                                mechSlots[item.mech_type][slot] = {
                                    uniqueKey: item.id || 0,
                                    itemIndex: item.item_id || 0,
                                };
                            }
                        }
                    }

                    const mechEntries = [];
                    for (let m = 1; m <= MAX_MECH_COUNT; m++) {
                        if (mechSlots[m].some(s => s.itemIndex !== 0)) {
                            mechEntries.push({mechType: m, slots: mechSlots[m]});
                        }
                    }

                    if (mechEntries.length > 0) {
                        const [msg, respBody] = client.getMessageBuffer(SN_WEAR_INFO,
                            HEADER_SIZE + (ENTRY_SIZE * mechEntries.length));
                        respBody.writeUint8(1, 0);
                        respBody.writeUint8(mechEntries.length, 1);
                        respBody.writeUint32LE(account.id || 0, 2);
                        respBody.writeUint32LE(0, 6);
                        respBody.writeUint32LE(defaultMech, 10);

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
                        console.log(`[ZGameLoginDispatch] >> Sent SN_WEAR_INFO: ${mechEntries.length} mechs`);
                    }
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

                {
                    const MAX_NUM_MECHS = 8;
                    const MECH_RECORD_SIZE = 0x1c;
                    const [msg, respBody] = client.getMessageBuffer(SN_MECH_LEVEL, 0x2 + (MECH_RECORD_SIZE * MAX_NUM_MECHS));
                    respBody.writeUint16LE(MAX_NUM_MECHS, 0);
                    let offset = 2;
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
                const [msg, respBody] = client.getMessageBuffer(SN_COMPLETE, 0x100);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeInt32LE(0x0000, 2);
                client.send(msg);
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

    handleChannelEnter(client, body)
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
    }
};
