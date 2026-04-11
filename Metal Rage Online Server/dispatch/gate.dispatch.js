const NetworkClient = require("../client");

// ZDispatchGate - Handles server/channel gateway
//
// Known methods from ZNetwork.dll strings:
//   Enter_CQ/SA           - Enter the gate
//   Leave_CQ/SA           - Leave the gate (to connect to game server)
//   Server_Add_SN         - Server list notification
//   Server_Online_SN      - Server came online
//   Server_Offline_SN     - Server went offline
//   Server_Unknown_SN     - Server status unknown
//   Channel_Add_SN        - Channel list notification
//   Channel_Update_SN     - Channel info updated

const CQ_ENTER = 0x220111;  // Guessed - gate enter might use this pattern
const SA_ENTER = 0x220112;  // Guessed

const CQ_LEAVE = 0x220131;
const SA_LEAVE = 0x220132;

const SN_SERVER_ADD = 0x220101;
const SN_CHANNEL_ADD = 0x220102;

module.exports =
class ZGateDispatch
{
    /**
     * Handles a client network message
     * @param {NetworkClient} client - The network client that sent the message
     * @param {number} type  - The type of message sent
     * @param {Buffer} body  - The data contained in the message
     * @returns {boolean} - Whether or not the message was handled in this service
     */
    dispatch(client, type, body)
    {
        switch (type)
        {
            case CQ_ENTER:
            {
                console.log(`[ZGateDispatch] Gate enter request (${body.length} bytes)`);
                if (body.length > 0) {
                    console.log(`[ZGateDispatch] Body:`, body.toString('hex'));
                }

                // Respond with success + account index
                {
                    const [msg, respBody] = client.getMessageBuffer(SA_ENTER, 0x10);
                    respBody.writeUint16LE(0x0000, 0); // EventMessage = OK
                    respBody.writeUint32LE(0x0000, 2); // ErrorMessage = OK
                    //send (0xDEADBEEF) as account index to test response from (0x00110124)
                    respBody.writeUint32LE(0xDEADBEEF, 6);
                    client.send(msg);
                }

                return true;
            }

            case CQ_LEAVE:
            {
                console.log(`[ZGateDispatch] Gate leave request (${body.length} bytes)`);

                const [msg, respBody] = client.getMessageBuffer(SA_LEAVE, 0xE);
                respBody.writeUint16LE(0x0000, 0); // EventMessage = OK
                respBody.writeUint32LE(0x0000, 2); // ErrorMessage = OK
                respBody.writeUint32LE(0x0, 6);
                respBody.writeUint32LE(0x0, 10);
                client.send(msg);

                return true;
            }

            default: return false;
        }
    }
};
