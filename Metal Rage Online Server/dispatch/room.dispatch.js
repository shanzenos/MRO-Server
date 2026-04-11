const NetworkClient = require("../client");

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

// Notification IDs must match the valid IDs in ZNetwork.dll dispatch table
// Valid Room SN IDs: 0x240511, 0x240512, 0x240513, 0x240521, 0x240522
// Valid User SN IDs: 0x240601, 0x240602, 0x240603, 0x240611, 0x240612, ...
const SN_ROOM_DEFAULT  = 0x00240511;
const SN_ROOM_STATE    = 0x00240512;
const SN_ROOM_NAME     = 0x00240513;
const SN_USER_DEFAULT  = 0x00240601;
const SN_USER_STATE    = 0x00240602;
const SN_USER_MASTER   = 0x00240603;

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
                console.log(`[ZRoomDispatch] >> Room Enter/Info CQ`);
                // Pre-creation lobby query. DO NOT send room state here —
                // the room doesn't exist yet. Just acknowledge with SA.
                // Room state is sent ONLY after SA_CREATE in gate.game.dispatch.js.
                {
                    const [msg, respBody] = client.getMessageBuffer(0x00240102, 0x6);
                    respBody.writeUint16LE(0x0000, 0);   // EventMessage = OK
                    respBody.writeUint32LE(0x0000, 2);   // ErrorMessage = OK
                    client.send(msg);
                }
                return true;
            }

            // ==========================================
            // Room Member List / Room Detail request
            // ==========================================
            case 0x00240103:
            {
                console.log(`[ZRoomDispatch] >> Room Member/Detail CQ`);
                //Pre-creation lobby query
                {
                    const [msg, respBody] = client.getMessageBuffer(0x00240104, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                }
                return true;
            }

            // ==========================================
            // Game Ready (CN - client notification)
            // Player toggled ready state
            // ==========================================
            case 0x00240201:
            {
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

                // Respond with Game Start SN
                {
                    const [msg, respBody] = client.getMessageBuffer(0x00240302, 0x10);
                    respBody.writeUint16LE(0x0000, 0);   // OK
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                }

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
        // SN_ROOM_DEFAULT - room settings (0x240511)
        // Body is ~32 bytes of fixed fields (EBX-based reads from disasm).
        // Reads at 0x70/0x74/0xBC were from ECX/ESI (Room struct), NOT body.
        {
            // The client may zero-index rooms internally even though SA_CREATE
            // sends a 1-based RoomIndex. Try 0 to match the internal Room object.
            const roomIndex = 0;
            const roomType = client.roomType_ || 0;
            const mapId = client.mapId_ || 1;

            const bodySize = 0x30;  // 48 bytes — fixed fields + room name
            const [msg, respBody] = client.getMessageBuffer(SN_ROOM_DEFAULT, bodySize);
            respBody.writeUint16LE(roomIndex, 0x00);  // RoomIndex (echo from CQ_CREATE)
            respBody.writeUint16LE(roomType, 0x02);   // RoomType (echo from CQ_CREATE!)
            respBody.writeUint8(1, 0x04);             // MapIndex (1-6 valid, 0=INVALID per switch!)
            respBody.writeUint16LE(mapId & 0xFFFF, 0x05); // MapId
            respBody.writeUint8(8, 0x07);             // MaxPlayers
            respBody.writeUint8(0, 0x08);             // GameMode
            respBody.writeUint8(3, 0x09);             // RoundCount (valid range 3-7 per handler)
            respBody.writeUint8(0, 0x0A);             // TimeLimit
            respBody.writeUint8(0, 0x0B);             // Flag bit 0 of room options bitfield
            respBody.writeUint8(0, 0x0C);             // Flag bit 1 (TeamBalance)
            respBody.writeUint8(0, 0x0D);             // Flag bit 2 (FriendlyFire)
            respBody.writeUint8(0, 0x0E);             // Flag bit 5 (WeaponRestrict)
            respBody.writeUint16LE(100, 0x10);        // ScoreLimit
            respBody.writeUint16LE(0, 0x12);          // Unknown
            // 0x14-0x1B gap (no handler reads here)
            respBody.writeUint8(0, 0x1C);             // Password flag
            respBody.writeUint8(0, 0x1D);
            respBody.writeUint8(0, 0x1E);
            respBody.writeUint8(0, 0x1F);
            client.send(msg);
        }

        // SN_USER_DEFAULT - user in room (0x240601)
        // Complex handler uses indirect reads, format not fully decoded yet.
        //Send nickname and basic stats.
        {
            const nickname = client.nickname_ || 'Player';
            const [msg, respBody] = client.getMessageBuffer(SN_USER_DEFAULT, 0x80);
            let offset = 0;
            respBody.writeUint16LE(0, offset);          // User slot index (u16)
            offset += 2;
            respBody.write(nickname + '\0', offset);    // Nickname
            offset = 0x20;                              // Align to fixed position
            respBody.writeUint8(0, offset);             // Team (0=red)
            offset += 1;
            respBody.writeUint8(1, offset);             // MechType (1=Light)
            offset += 1;
            respBody.writeUint32LE(1, offset);          // Level
            offset += 4;
            respBody.writeUint8(0, offset);             // Ready state (0=not ready)
            offset += 1;
            respBody.writeUint8(1, offset);             // Pilot type
            client.send(msg);
        }

        // SN_USER_MASTER - who is the host (0x240603)
        // Body: u16 slotIndex, u32 data
        {
            const [msg, respBody] = client.getMessageBuffer(SN_USER_MASTER, 0x10);
            respBody.writeUint16LE(0, 0);           // Slot 0 = master
            respBody.writeUint32LE(0, 2);           // Extra data
            client.send(msg);
        }

        // SN_ROOM_STATE - room waiting state (0x240512)
        // Body: u8 state, u8 flags
        {
            const [msg, respBody] = client.getMessageBuffer(SN_ROOM_STATE, 0x10);
            respBody.writeUint8(0, 0);              // State: 0 = waiting
            respBody.writeUint8(0, 1);              // Flags
            client.send(msg);
        }
    }
};
