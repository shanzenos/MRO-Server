const NetworkClient = require("../client");

// Catch-all handler for social/misc services on the dispatch server (port 9211)
// that share the 0x22 prefix with the Gate but use different sub-ranges:
//
//   0x2202XX = ZDispatchCommunity (chat, whisper, search, reports)
//   0x2203XX = ZDispatchFriend (friend list, friendship management)
//   0x2204XX = Unknown
//   0x2205XX = Unknown
//   0x2211XX = Unknown
//   0x2212XX = Unknown
//   0x2214XX = Unknown
//   0x2221XX = ZDispatchHangar? or ZDispatchClan?
//   0x2222XX = Unknown
//   0x2223XX = Unknown
//   0x2231XX = Unknown
//
// Also handles other dispatch-server prefixes:
//   0x110XXX = Login variants (already handled by ZAccountDispatch for Wasabii)
//   0x21XXXX = Account data (already handled by ZAccountDispatch)

module.exports =
class ZGateSocialDispatch
{
    dispatch(client, type, body)
    {
        // Only handle 0x22 sub-ranges that aren't the core gate (0x2201XX)
        const prefix = (type >> 16) & 0xFF;
        const subRange = (type >> 8) & 0xFF;

        if (prefix === 0x22 && subRange > 0x01) {
            const rangeNames = {
                0x02: 'Community',
                0x03: 'Friend',
                0x04: 'Unknown_04',
                0x05: 'Unknown_05',
                0x11: 'Unknown_11',
                0x12: 'Unknown_12',
                0x14: 'Unknown_14',
                0x21: 'Unknown_21',
                0x22: 'Unknown_22',
                0x23: 'Unknown_23',
                0x31: 'Unknown_31',
            };

            const name = rangeNames[subRange] || `Unknown_${subRange.toString(16)}`;
            console.log(`[ZGate${name}] Message 0x${type.toString(16).padStart(8, '0')} (${body.length} bytes)`);
            if (body.length > 0) {
                console.log(`[ZGate${name}] Body:`, body.toString('hex'));
                const ascii = body.toString('ascii').replace(/[^\x20-\x7e]/g, '.');
                if (ascii.replace(/\./g, '').length > 2) {
                    console.log(`[ZGate${name}] ASCII:`, ascii);
                }
            }

            // Auto-respond to CQ messages
            if (type % 2 === 1) {
                const responseType = type + 1;
                console.log(`[ZGate${name}] >> Auto-responding with 0x${responseType.toString(16).padStart(8, '0')}`);
                const [msg, respBody] = client.getMessageBuffer(responseType, 0x6);
                respBody.writeUint16LE(0x0000, 0);
                respBody.writeUint32LE(0x0000, 2);
                client.send(msg);
            }

            return true;
        }

        return false;
    }
};
