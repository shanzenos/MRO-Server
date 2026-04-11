const NetworkClient = require("../client");
const db = require('../database/db');

// ZDispatchCommunity + ZDispatchFriend + other social services
//
// These use the 0x22 prefix sub-ranges on the dispatch server:
//   0x2202XX = Chat/Community
//   0x2203XX = Friends
//   0x2204XX = ?
//   0x2205XX = ?
//
// And various other prefixes:
//   0x26XXXX = Quest (5 IDs)
//   0x31XXXX = Hangar? (32 IDs)
//   0x32XXXX = Card? (21 IDs)
//   0x36XXXX = Clan? (93 IDs)
//   0x41XXXX = Postbox? (4 IDs)
//   0x42XXXX = Waiting? (15 IDs)
//   0x51XXXX = ? (30 IDs)
//
// Handler logs everything that doesn't match Lobby/Room/Game.

// Quest/tutorial message IDs
const CQ_QUEST_COMPLETE = 0x00260111;
const SA_QUEST_COMPLETE = 0x00260112;

module.exports =
class ZCommunityDispatch
{
    dispatch(client, type, body)
    {
        // Catch messages in known social/misc ranges
        const prefix = (type >> 16) & 0xFF;
        if (prefix !== 0x26 && prefix !== 0x31 && prefix !== 0x32 &&
            prefix !== 0x36 && prefix !== 0x41 && prefix !== 0x42 &&
            prefix !== 0x51)
            return false;

        const prefixNames = {
            0x26: 'Quest',
            0x31: 'Hangar',
            0x32: 'Card',
            0x36: 'Clan',
            0x41: 'Postbox',
            0x42: 'Waiting',
            0x51: 'Unknown_51',
        };

        const name = prefixNames[prefix] || 'Unknown';
        console.log(`[ZDispatch${name}] Message 0x${type.toString(16).padStart(8, '0')} (${body.length} bytes)`);
        if (body.length > 0) {
            console.log(`[ZDispatch${name}] Body:`, body.toString('hex'));
        }

        if (type === CQ_QUEST_COMPLETE && body.length >= 8) {
            const tutorialId = body.readUint32LE(0);
            const status = body.readUint32LE(4);
            console.log(`[ZDispatchQuest] >> Tutorial completion: id=${tutorialId}, status=${status}`);

            if (client.accountId_ && status === 1) {
                db.completeTutorial(client.accountId_, tutorialId).then(() => {
                    console.log(`[ZDispatchQuest] >> Saved tutorial #${tutorialId} completion for account #${client.accountId_}`);
                }).catch(err => {
                    console.error(`[ZDispatchQuest] >> DB error saving tutorial:`, err.message);
                });
            }

            const [msg, respBody] = client.getMessageBuffer(SA_QUEST_COMPLETE, 0x6);
            respBody.writeUint16LE(0x0000, 0);
            respBody.writeUint32LE(0x0000, 2);
            client.send(msg);
            return true;
        }

        //Respond to other CQ messages
        if (type % 2 === 1) {
            const responseType = type + 1;
            console.log(`[ZDispatch${name}] >> Auto-responding with 0x${responseType.toString(16).padStart(8, '0')}`);
            const [msg, respBody] = client.getMessageBuffer(responseType, 0x6);
            respBody.writeUint16LE(0x0000, 0);
            respBody.writeUint32LE(0x0000, 2);
            client.send(msg);
        }

        return true;
    }
};
