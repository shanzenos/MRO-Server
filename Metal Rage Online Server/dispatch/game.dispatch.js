const NetworkClient = require("../client");

// ZDispatchGame - Handles in-game actions
//
// Confirmed message ID range: 0x00250101 through 0x00250512 (28 IDs total)
// All 0x25XXXX messages belong to this dispatch.
//
// Known methods from ZNetwork.dll strings:
//   Ready_Host_CA/SN/SQ, Ready_Success_SN, Ready_Failed_SN
//   Leave_CQ/SA/SN
//   BeginRound_CN/SN, EndRound_SN, EndQuater_SN, EndGame_SN
//   Death_CN/SN, Respawn_CN/SN, Assist_CN/SN
//   Bomb_CN/SN, Capture_CN/SN, Conquest_CN/SN
//   Boss_CN/SN, TwoBoss_CN/SN, Campaign_CN/SN, Special_CN/SN
//   ChangeSlot_CN/SN, InstantRespawn_CN/SN
//   TriggerTouch_CN/SN, Timeout_CN/SN
//   HostChange_SN, Game_Info_SN, Game_Score_SN, Game_User_SN

module.exports =
class ZGameDispatch
{
    dispatch(client, type, body)
    {
        // Catch messages in the 0x0025XXXX range
        if ((type & 0x00FF0000) !== 0x00250000)
            return false;

        console.log(`[ZGameDispatch] Message 0x${type.toString(16).padStart(8, '0')} (${body.length} bytes)`);
        if (body.length > 0) {
            console.log(`[ZGameDispatch] Body:`, body.toString('hex'));
        }

        // Auto-respond to CQ messages
        if (type % 2 === 1) {
            const responseType = type + 1;
            console.log(`[ZGameDispatch] >> Auto-responding with 0x${responseType.toString(16).padStart(8, '0')}`);
            const [msg, respBody] = client.getMessageBuffer(responseType, 0x6);
            respBody.writeUint16LE(0x0000, 0);
            respBody.writeUint32LE(0x0000, 2);
            client.send(msg);
        }

        return true;
    }
};
