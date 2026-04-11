const NetworkClient = require("../client");

// ZGateGameDispatch - Handles Gate-range (0x22XXXX) messages on the GAME server
//
// Key messages:
//   0x00220201 (CQ_CREATE)  - Room creation from lobby
//   0x00220121              - Player name/presence lookup
//   0x00220141              - Gate social request
//   0x00221221              - Hardware/config report (CN - no response needed)
// SA_Create struct:
//   unsigned char m_byResult;  // 0=SUCCESS, 1=FAIL
//   unsigned char m_byTeam;    // 0=RED, 1=BLUE (creator always RED)
//   int           m_nIndex;    // room index (4 bytes LE)
//
// via 0x24XXXX messages so the client can populate the room UI.

const CQ_CREATE = 0x00220201;
const SA_CREATE = 0x00220202;

let nextRoomIndex = 1;

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
                const nickname = client.nickname_ || 'Player';

                // Parse CQ_CREATE body — echo settings back in Room_Default_SN
                // Body layout (51 bytes observed):
                //   [0x00] u8   roomType (0=Normal, 1=ClanWar, 2=Campaign, 3=QuickMatch)
                //   [0x01] u8   ??? (0x10 = 16)
                //   [0x02] u32  mapId or seed (0x00031B63)
                //   [0x06] u32  ??? (2)
                //   [0x0A] u8   ??? (0)
                //   [0x0B] u8   maxPlayers or settings
                //   [0x0C] u8   gameMode
                //   Rest: room name + options (null-padded)
                const roomType = body.length > 0 ? body[0] : 0;
                const mapId = body.length >= 6 ? body.readUint32LE(2) : 1;
                const maxPlayers = body.length > 0x0B ? body[0x0B] : 8;

                console.log(`[ZGateGameDispatch] >> Creating room #${roomIndex} (type=${roomType}, map=0x${mapId.toString(16)}, max=${maxPlayers}) for "${nickname}"`);

                // Store room info on client for other dispatchers to reference
                client.roomIndex_ = roomIndex;
                client.roomType_ = roomType;
                client.mapId_ = mapId;

                // 	ZNetwork.dll (0x107E3E60):
                //   [esi+0x10] = u16 EventMessage (must be 0)
                //   [esi+0x12] = u32 ErrorMessage (must be 0)
                //   [esi+0x16] = u16 RoomIndex (movzx word!)
                //
                // Body is exactly 8 bytes. No extra data.
                // After success, client calls SetScene(5) = Room transition.
                //
                // RoomIndex is uint16
                {
                    const [msg, respBody] = client.getMessageBuffer(SA_CREATE, 0x8);
                    respBody.writeUint16LE(0x0000, 0);            // EventMessage = OK
                    respBody.writeUint32LE(0x0000, 2);            // ErrorMessage = OK
                    respBody.writeUint16LE(roomIndex, 6);         // Room index
                    client.send(msg);
                    console.log(`[ZGateGameDispatch] >> Sent SA_CREATE {EventMsg=0, ErrMsg=0, RoomIdx=${roomIndex} (u16)}`);
                }

                console.log(`[ZGateGameDispatch] >> Room creation response sent (8-byte body, confirmed from disasm)`);

                //Delay room state notifications by 2 seconds to create the room
                setTimeout(() => {
                    try {
                        const ZRoomDispatch = require('./room.dispatch');
                        const roomDispatch = new ZRoomDispatch();
                        roomDispatch.sendRoomState(client);
                        console.log(`[ZGateGameDispatch] >> Sent room state notifications (0x2405XX/0x2406XX) [delayed]`);
                    } catch (err) {
                        console.error(`[ZGateGameDispatch] >> Error sending room state:`, err.message);
                    }
                }, 2000);

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
