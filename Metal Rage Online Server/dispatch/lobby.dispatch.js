const NetworkClient = require("../client");

// ZDispatchLobby - Handles lobby operations after entering a channel
//
// Known methods from ZNetwork.dll:
//   Enter_CQ/SA        - Enter lobby
//   Leave_CQ/SA        - Leave lobby
//   Create_CQ/SA       - Create a room
//   Request_CQ/SA      - Request room/channel list
//   Room_List_SN       - Room list notification
//   Channel_Add_SN     - Channel add notification
//   Server_Add_SN      - Server add notification
//   User_Add_SN        - User joined lobby notification
//   User_Delete_SN     - User left lobby notification
//   User_Nick_Change_SN
//   User_Clan_Info_SN
//   User_Clan_Clear_SN
//
// Confirmed message ID range: 0x00230101 through 0x00230152 (30 IDs total)
// All 0x23XXXX messages belong to this dispatch.

// All known lobby message IDs from the dispatch table in ZNetwork.dll
const LOBBY_IDS = [
    0x00230101, 0x00230102, 0x00230103, 0x00230104, 0x00230105,
    0x00230106, 0x00230107, 0x00230108, 0x00230109, 0x0023010A,
    0x00230111, 0x00230112, 0x00230121, 0x00230122, 0x00230131,
    0x00230132, 0x00230141, 0x00230142, 0x00230143, 0x00230144,
    0x00230145, 0x00230146, 0x00230147, 0x00230148, 0x00230149,
    0x0023014A, 0x00230151, 0x00230152,
];

//Possible message IDs:
// Gate: 0x220101=SN_SERVER_ADD, 0x220102=SN_CHANNEL_ADD, 0x220131=CQ_LEAVE, 0x220132=SA_LEAVE
// Following the same structure for Lobby (0x23):
//   0x230101 = Room_List_SN or Enter-related
//   0x230111/12 = Enter_CQ/SA
//   0x230121/22 = Leave_CQ/SA
//   0x230131/32 = Create_CQ/SA
//   0x230141/42 = Request_CQ/SA

module.exports =
class ZLobbyDispatch
{
    /**
     * @param {NetworkClient} client
     * @param {number} type
     * @param {Buffer} body
     * @returns {boolean}
     */
    dispatch(client, type, body)
    {
        // Catch ALL messages in the 0x0023XXXX range
        if ((type & 0x00FF0000) !== 0x00230000)
            return false;

        console.log(`[ZLobbyDispatch] Message 0x${type.toString(16).padStart(8, '0')} (${body.length} bytes)`);
        if (body.length > 0) {
            console.log(`[ZLobbyDispatch] Body:`, body.toString('hex'));
            // Try to extract readable strings from the body
            const ascii = body.toString('ascii').replace(/[^\x20-\x7e]/g, '.');
            if (ascii.replace(/\./g, '').length > 2) {
                console.log(`[ZLobbyDispatch] ASCII:`, ascii);
            }
        }

        switch (type)
        {
            // Lobby Enter - the first message a client sends after connecting to game server
            // Trying 0x00230111 based on the CQ/SA pattern (X111/X112)
            case 0x00230111:
            {
                console.log(`[ZLobbyDispatch] >> Lobby Enter CQ (guessed)`);

                {
                    const [msg, respBody] = client.getMessageBuffer(0x00230112, 0x6);
                    respBody.writeUint16LE(0x0000, 0); // EventMessage = OK
                    respBody.writeUint32LE(0x0000, 2); // ErrorMessage = OK
                    client.send(msg);
                }

                this.sendEmptyRoomList(client);

                return true;
            }

            //Enter might be 0x00230101/02 ?
            case 0x00230101:
            {
                console.log(`[ZLobbyDispatch] >> Possible Lobby Enter/Request CQ (0x230101)`);

                {
                    const [msg, respBody] = client.getMessageBuffer(0x00230102, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                }

                this.sendEmptyRoomList(client);
                return true;
            }

            // Lobby Leave
            case 0x00230121:
            {
                console.log(`[ZLobbyDispatch] >> Lobby Leave CQ (guessed)`);
                const [msg, respBody] = client.getMessageBuffer(0x00230122, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
                return true;
            }

            // Lobby Room Create
            case 0x00230131:
            {
                console.log(`[ZLobbyDispatch] >> Lobby Room Create CQ (guessed)`);
                const [msg, respBody] = client.getMessageBuffer(0x00230132, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
                return true;
            }

            // Lobby Request (room list)
            case 0x00230141:
            {
                console.log(`[ZLobbyDispatch] >> Lobby Request CQ (guessed)`);
                const [msg, respBody] = client.getMessageBuffer(0x00230142, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);

                this.sendEmptyRoomList(client);
                return true;
            }

            default:
            {
                //Generic OK Response to keep client from crashing / hanging
                    const responseType = type + 1;
                    console.log(`[ZLobbyDispatch] >> Auto-responding with 0x${responseType.toString(16).padStart(8, '0')}`);
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
     * Sends an empty room list to the client
     * @param {NetworkClient} client
     */
    sendEmptyRoomList(client)
    {
        //Possibly 0x220101 = SN_SERVER_ADD, lobby might use 0x230103 or similar.
        //Test 0x00230103 as Room_List_SN.
        const [msg, body] = client.getMessageBuffer(0x00230103, 0x4);
        body[0] = 0x00; // No more messages following
        body[1] = 0x00; // Room count = 0
        body.writeUint16LE(0, 2);
        client.send(msg);
    }
};
