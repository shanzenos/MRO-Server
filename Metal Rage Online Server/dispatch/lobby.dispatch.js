const NetworkClient = require("../client");

const rooms = require('../rooms.js');
const { sendFullRoomList } = require('./room/room-list.sender');

const { getGameInfoRound } = require('./gate.game.dispatch.js');

const { broadcastRoomListChange } = require('./room/room-list.sender');

const BEGIN_ROUND_DEDUP_WINDOW_MS = 2000;

const PVE_SLOT_SELECT_FLOW = 'client';

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

function getExactMessageBuffer(type, bodySize)
{
    const msg = Buffer.alloc(0x10 + bodySize);
    msg.writeUint16BE(msg.length, 0x6);
    msg.writeUint32BE(type, 0xC);
    return [msg, msg.subarray(0x10)];
}

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

                if (client.gameStarted_) {
                    console.log(`[ZLobbyDispatch] >> 0x230111 while in game — not treating as Lobby Enter`);
                    return false;
                }

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

            case 0x00230101:
            {
                const userIndex = body.length >= 2 ? body.readUInt16LE(0) : Number(client.accountIndex_ || client.accountId_ || 1);
                const slot = body.length >= 3 ? body[2] : 1;
                if (slot >= 1 && slot <= 8)
                    client.currentHangarSlot_ = slot;
                const [msg, sb] = client.getMessageBuffer(0x00230102, 0x0E);
                sb.writeUInt16LE(0, 0x00);
                sb.writeUInt32LE(0, 0x02);
                sb.writeUInt16LE(userIndex, 0x0A);
                sb[0x0C] = slot;
                client.send(msg);
                console.log(`[ZLobbyDispatch] >> ChangeSlot_CN user=${userIndex} slot=${slot} -> Sent ChangeSlot_SN 0x00230102`);
                return true;
            }

            case 0x00230121:
            {
                console.log(`[ZLobbyDispatch] >> Assist_CN`);
                const [msg, respBody] = client.getMessageBuffer(0x00230122, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
                return true;
            }

            case 0x00230151:
            {
                const accountIdForBeginRound = Number(client.accountIndex_ || client.accountId_ || 1);
                const roomForBeginRound = rooms.getRoomByAccount(accountIdForBeginRound);

                if (roomForBeginRound) {
                    if (accountIdForBeginRound !== roomForBeginRound.hostAccountId) {
                        console.log(`[ZLobbyDispatch] >> Ignored BeginRound_CN 0x00230151 from non-host account=${accountIdForBeginRound} (host=${roomForBeginRound.hostAccountId}, room #${roomForBeginRound.id}) -- no reply`);
                        return true;
                    }
                    const now = Date.now();
                    const lastAccepted = roomForBeginRound.beginRoundAcceptedAt || 0;
                    if (now - lastAccepted < BEGIN_ROUND_DEDUP_WINDOW_MS) {
                        console.log(`[ZLobbyDispatch] >> Ignored duplicate host BeginRound_CN 0x00230151 for room #${roomForBeginRound.id} (${now - lastAccepted}ms since last accepted CN, dedup window ${BEGIN_ROUND_DEDUP_WINDOW_MS}ms) -- no reply`);
                        return true;
                    }
                    roomForBeginRound.beginRoundAcceptedAt = now;
                    roomForBeginRound.beginRoundGen = (roomForBeginRound.beginRoundGen || 0) + 1;

                    roomForBeginRound.battleStats = new Map();
                    roomForBeginRound.teamScores = [0, 0];
                    roomForBeginRound.state = 'playing';
                    broadcastRoomListChange(rooms.getLobbyClients(), roomForBeginRound, 2, getExactMessageBuffer);

                    client.battleStats_ = {};

                    rooms.sendAll(roomForBeginRound.id, (target) => {
                        const [msg, body] = target.getMessageBuffer(0x00230152, 0x06);
                        body.writeUint16LE(0, 0);
                        body.writeUint32LE(0, 2);
                        return msg;
                    });
                    console.log(`[ZLobbyDispatch] >> Broadcast BeginRound_SN 0x00230152 to room #${roomForBeginRound.id} (${roomForBeginRound.members.size} member(s), round gen=${roomForBeginRound.beginRoundGen})`);
                } else {

                    client.battleStats_ = {};
                    const [beginMsg, beginBody] = client.getMessageBuffer(0x00230152, 0x06);
                    beginBody.writeUint16LE(0, 0);
                    beginBody.writeUint32LE(0, 2);
                    client.send(beginMsg);
                    console.log(`[ZLobbyDispatch] >> Sent BeginRound_SN 0x00230152`);
                }

                return true;

            }
            case 0x00230139:
            {
                const action = body.length >= 3 ? body[2] : 2;

                const accountIdForCampaign = Number(client.accountIndex_ || client.accountId_ || 1);
                const roomForCampaign = rooms.getRoomByAccount(accountIdForCampaign);

                if (roomForCampaign && accountIdForCampaign !== roomForCampaign.hostAccountId) {
                    console.log(`[ZLobbyDispatch] >> Ignored Campaign_CN 0x00230139 from non-host account=${accountIdForCampaign} (host=${roomForCampaign.hostAccountId}, room #${roomForCampaign.id}) -- no reply`);
                    return true;
                }

                const buildEndRoundMsg = () => {
                    const [msg, eb] = getExactMessageBuffer(0x00222211, 0x1E);
                    eb.writeUInt16LE(0, 0x02);
                    eb.writeUInt16LE(1, 0x10);
                    return msg;
                };

                if (action === 1) {

                    const roundsCounter = roomForCampaign || client;
                    roundsCounter.pveRoundsCleared_ = (Number(roundsCounter.pveRoundsCleared_) || 0) + 1;
                    const playRound = getGameInfoRound(client);
                    if (roundsCounter.pveRoundsCleared_ < playRound) {

                        if (roomForCampaign) {
                            rooms.sendAll(roomForCampaign.id, buildEndRoundMsg);
                            console.log(
                                `[ZLobbyDispatch] >> Campaign_CN action=1 pveRoundsCleared_=` +
                                `${roundsCounter.pveRoundsCleared_}/${playRound} -> Broadcast EndRound_SN 0x00222211 ` +
                                `to room #${roomForCampaign.id} (${roomForCampaign.members.size} member(s))`
                            );
                        } else {
                            client.send(buildEndRoundMsg());
                            console.log(
                                `[ZLobbyDispatch] >> Campaign_CN action=1 pveRoundsCleared_=` +
                                `${roundsCounter.pveRoundsCleared_}/${playRound} -> Sent EndRound_SN 0x00222211`
                            );
                        }

                        return true;
                    }
                    console.log(
                        `[ZLobbyDispatch] >> Campaign_CN action=1 pveRoundsCleared_=` +
                        `${roundsCounter.pveRoundsCleared_}/${playRound} (last round) -> falling through to EndGame_SN`
                    );

                }
                const winTeam = action === 1 ? 0 : 1;
                if (roomForCampaign) {
                    rooms.sendAll(roomForCampaign.id, (target) => {
                        const [msg, eb] = target.getMessageBuffer(0x00222213, 0x1E);
                        eb.writeUInt16LE(winTeam, 0x00);
                        eb.writeUInt16LE(0, 0x02);
                        eb.writeUInt16LE(1, 0x10);
                        return msg;
                    });
                    console.log(`[ZLobbyDispatch] >> Campaign_CN action=${action} -> Broadcast EndGame_SN 0x00222213 (winTeam=${winTeam}) to room #${roomForCampaign.id} (${roomForCampaign.members.size} member(s))`);
                    roomForCampaign.state = 'lobby';
                    roomForCampaign.battleStartGen = (roomForCampaign.battleStartGen || 0) + 1;
                    for (const member of roomForCampaign.members.values()) {
                        member.ready = false;
                        if (member.client) member.client.gameStarted_ = false;
                    }
                    for (const member of roomForCampaign.members.values()) {
                        rooms.sendAll(roomForCampaign.id, () => {
                            const [stateMsg, stateBody] = getExactMessageBuffer(0x00220401, 0x08);
                            stateBody.writeUInt8(0, 0x00);
                            stateBody.writeUInt8(1, 0x01);
                            stateBody.writeUInt16LE(member.accountId, 0x02);
                            stateBody.writeUInt32LE(1, 0x04);
                            return stateMsg;
                        });
                    }
                    broadcastRoomListChange(rooms.getLobbyClients(), roomForCampaign, 2, getExactMessageBuffer);
                } else {
                    const [msg, eb] = client.getMessageBuffer(0x00222213, 0x1E);
                    eb.writeUInt16LE(winTeam, 0x00);
                    eb.writeUInt16LE(0, 0x02);
                    eb.writeUInt16LE(1, 0x10);
                    client.send(msg);
                    console.log(`[ZLobbyDispatch] >> Campaign_CN action=${action} -> Sent EndGame_SN 0x00222213 (winTeam=${winTeam})`);
                }

                return true;
            }

            case 0x00230123:
            {
                const attackerIndex = body.length >= 2 ? body.readUint16LE(0x00) : 0;
                const victimIndex = body.length >= 4
                    ? body.readUint16LE(0x02)
                    : Number(client.accountIndex_ || client.accountId_ || 1);
                const deathType = body.length >= 5 ? body[0x04] : 0x03;
                const specialFlag = body.length >= 6 ? body[0x05] : 0;
                const weaponPart = body.length >= 7 ? body[0x06] : 0;
                const auxiliaryValue = body.length >= 11 ? body.readUint32LE(0x07) : 0;
                const EXP_PER_KILL = 10;
                const POINT_PER_KILL = 10;
                const accountIdForDeath = Number(client.accountIndex_ || client.accountId_ || 1);
                const roomForDeath = rooms.getRoomByAccount(accountIdForDeath);

                if (roomForDeath && accountIdForDeath !== roomForDeath.hostAccountId) {
                    console.log(`[ZLobbyDispatch] >> Ignored Death_CN 0x00230123 from non-host account=${accountIdForDeath} (host=${roomForDeath.hostAccountId}, room #${roomForDeath.id}) -- no reply`);
                    return true;
                }

                let statFor;
                if (roomForDeath) {
                    if (!roomForDeath.battleStats)
                        roomForDeath.battleStats = new Map();
                    statFor = (index) => {
                        let st = roomForDeath.battleStats.get(index);
                        if (!st) {
                            st = { kills: 0, deaths: 0 };
                            roomForDeath.battleStats.set(index, st);
                        }
                        return st;
                    };
                } else {
                    const stats = client.battleStats_ || (client.battleStats_ = {});
                    statFor = (index) => stats[index] || (stats[index] = { kills: 0, deaths: 0 });
                }
                const killerStats = statFor(attackerIndex);
                const victimStats = statFor(victimIndex);
                if (attackerIndex !== victimIndex)
                    killerStats.kills++;
                victimStats.deaths++;

                let teamScores = [0, 0];
                if (rooms.isPvpRoom(roomForDeath)) {
                    if (!Array.isArray(roomForDeath.teamScores)) roomForDeath.teamScores = [0, 0];
                    const attacker = roomForDeath.members.get(attackerIndex);
                    const victim = roomForDeath.members.get(victimIndex);
                    if (deathType >= 1 && deathType <= 4 && attacker && victim && attackerIndex !== victimIndex &&
                        Number(attacker.team) !== Number(victim.team) && [0, 1].includes(Number(attacker.team))) {
                        roomForDeath.teamScores[Number(attacker.team)]++;
                    }
                    teamScores = roomForDeath.teamScores;
                }

                const buildDeathMsg = (target) => {

                    const [deathMsg, deathBody] = target.getMessageBuffer(0x00230124, 0x51);
                    deathBody.writeUint16LE(0, 0x00);
                    deathBody.writeUint32LE(0, 0x02);
                    deathBody.writeUint16LE(teamScores[0] & 0xFFFF, 0x06);
                    deathBody.writeUint16LE(teamScores[1] & 0xFFFF, 0x08);
                    deathBody.writeUint16LE(attackerIndex, 0x0A);
                    deathBody.writeUint16LE(victimIndex, 0x0C);
                    deathBody[0x0E] = deathType;
                    deathBody[0x0F] = specialFlag;
                    deathBody[0x10] = weaponPart;
                    deathBody.writeUint32LE(auxiliaryValue, 0x11);
                    const writeBattle = (offset, st) => {
                        deathBody.writeUint16LE(st.kills & 0xFFFF, offset + 0x00);
                        deathBody.writeUint16LE(st.deaths & 0xFFFF, offset + 0x02);
                        deathBody.writeUint32LE(st.kills * EXP_PER_KILL, offset + 0x08);
                        deathBody.writeUint32LE(st.kills * POINT_PER_KILL, offset + 0x0C);
                    };
                    writeBattle(0x31, killerStats);
                    writeBattle(0x41, victimStats);
                    return deathMsg;
                };

                if (roomForDeath) {
                    rooms.sendAll(roomForDeath.id, buildDeathMsg);
                    console.log(
                        `[ZLobbyDispatch] >> Broadcast Death_SN 0x00230124 to room #${roomForDeath.id} ` +
                        `(${roomForDeath.members.size} member(s)) (attacker=${attackerIndex}, victim=${victimIndex}, ` +
                        `type=${deathType}, team score=${teamScores[0]}-${teamScores[1]}, killer K/D=${killerStats.kills}/${killerStats.deaths})`
                    );
                } else {
                    client.send(buildDeathMsg(client));
                    console.log(
                        `[ZLobbyDispatch] >> Sent Death_SN 0x00230124 ` +
                        `(attacker=${attackerIndex}, victim=${victimIndex}, type=${deathType}, ` +
                        `killer K/D=${killerStats.kills}/${killerStats.deaths})`
                    );
                }

                if (deathType < 1 || deathType > 4)
                    return true;

                return true;

            }

            case 0x00230103:
            {
                client.respawnGeneration_ = (client.respawnGeneration_ || 0) + 1;
                const respawnIndex = body.length >= 2
                    ? body.readUInt16LE(0)
                    : Number(client.accountIndex_ || client.accountId_ || 1);
                this.sendRespawn(client, respawnIndex, 'Respawn_CN');
                return true;
            }

            // Lobby Room Create
            case 0x00230131:
            {
                console.log(`[ZLobbyDispatch] >> Lobby Room Create CQ (guessed)`);
                const roomType = body.length > 0 ? body[0] : 0;
                const mapSeed = body.length >= 6 ? body.readUint32LE(2) : 0;
                const mapId = body.length >= 10 ? body.readUint32LE(6) : (mapSeed || 1);
                const requestedMaxPlayers = body.length > 0x0B ? body[0x0B] : 8;
                const gameMode = body.length > 0x0C ? body[0x0C] : 0;
                const campaignRoom = roomType === 2 || gameMode === 5 || (roomType === 1 && gameMode === 4);
                const effectiveRoomType = campaignRoom ? 2 : roomType;
                client.roomIndex_ = client.roomIndex_ || 1;
                client.roomType_ = effectiveRoomType;
                client.rawRoomType_ = roomType;
                client.mapId_ = mapId;
                client.mapSeed_ = mapSeed;
                client.maxPlayers_ = campaignRoom
                    ? Math.min(Math.max(requestedMaxPlayers || 4, 1), 4)
                    : Math.min(Math.max(requestedMaxPlayers || 8, 1), 8);
                client.gameMode_ = gameMode;
                client.campaignRoom_ = campaignRoom;

                const [msg, respBody] = client.getMessageBuffer(0x00230132, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);

                setTimeout(() => {
                    try {
                        const ZRoomDispatch = require('./room.dispatch');
                        new ZRoomDispatch().sendRoomState(client);
                        console.log(`[ZLobbyDispatch] >> Sent room state after Lobby Create CQ`);
                    } catch (err) {
                        console.error(`[ZLobbyDispatch] >> Lobby Create room state error:`, err.message);
                    }
                }, 250);
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

        {
            sendFullRoomList(client, rooms.listRooms(), (type, size) => client.getMessageBuffer(type, size));
        }
    }

    sendRespawn(client, userIndex, sourceTag)
    {
        const [msg, body] = client.getMessageBuffer(0x00230104, 0x0C);
        body.writeUint16LE(0, 0x00);
        body.writeUint32LE(0, 0x02);
        body.writeUint32LE(0, 0x06);
        body.writeUint16LE(userIndex, 0x0A);
        client.send(msg);
        console.log(
            `[ZLobbyDispatch] >> Sent Respawn_SN 0x00230104 ` +
            `(userIndex=${userIndex}, source=${sourceTag})`
        );
    }
};
