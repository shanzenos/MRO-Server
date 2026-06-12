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

        switch (type) {

            // 0x00250102 = 게임 씬 진입 알림 (game scene entry notification)
            // - 게임 시작 전(채널/창고): 무시 (Ready_Host_SQ를 보내면 BeginRound가 너무 일찍 발생) (before game start (channel/hangar): ignore — sending Ready_Host_SQ causes BeginRound too early)
            // - 게임 시작 후(훈련장 씬 로드): Ready_Host_SQ 전송 (after game start (training scene load): send Ready_Host_SQ)
            case 0x00250102:
                if (client.gameStarted_) {
                    console.log(`[ZGameDispatch] >> 게임 씬 진입 알림 (0x00250102) — Ready_Host_SQ 전송`);
                    const [msg, respBody] = client.getMessageBuffer(0x00250203, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                } else {
                    // Lobby/hangar state: ACK with 0x00250103 so client doesn't stall
                    console.log(`[ZGameDispatch] >> 초기화 CN (0x00250102) — ACK (로비 상태)`);
                    const [msg, respBody] = client.getMessageBuffer(0x00250103, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                }
                return true;

            // 0x00250204 = Ready_Host_CA — 클라이언트가 준비 확인에 응답 (client responds to the ready confirmation)
            case 0x00250204:
            {
                console.log(`[ZGameDispatch] >> Ready_Host_CA (0x00250204) body: ${body.toString('hex')}`);

                // Ready_Success_SN (0x00250201) — 준비 완료 (ready complete)
                {
                    const [msg, respBody] = client.getMessageBuffer(0x00250201, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                    console.log(`[ZGameDispatch] >> Sent 0x00250201 (Ready_Success_SN)`);
                }

                // BeginRound_SN (0x00250301) — 라운드 시작 (round start)
                setTimeout(() => {
                    const [msg, respBody] = client.getMessageBuffer(0x00250301, 0x6);
                    respBody.writeUint16LE(0x0000, 0);
                    respBody.writeUint32LE(0x0000, 2);
                    client.send(msg);
                    console.log(`[ZGameDispatch] >> Sent 0x00250301 (BeginRound_SN)`);
                }, 500);
                return true;
            }

            // 0x00250202 = Ready_Host_SN — 다른 플레이어 준비 알림 (멀티 전용, 무시) (other player ready notification, multiplayer only, ignore)
            case 0x00250202:
                return true;

            default:
            {
                // Auto-respond to odd (CQ) messages
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
        }
    }
};