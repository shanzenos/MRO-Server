const NetworkClient = require("../client");
const db = require('../database/db');
const { MAX_SLOT_COUNT } = require('../datatypes/enums');

function catalogCategoryType(row) {
    const category = Number(row.category_type) || 2;
    return Math.max(0, category - 1) >>> 0;
}

function catalogShopPrice(row) {
    const price = Number(row.price) || 0;
    return price > 0 ? price : 1;
}

function getExactMessageBuffer(type, bodySize) {
    const msg = Buffer.alloc(0x10 + bodySize);
    msg.writeUint16BE(msg.length, 0x6);
    msg.writeUint32BE(type, 0xC);
    return [msg, msg.subarray(0x10)];
}

function sendReadySuccessAndBeginRound(client, sourceTag) {
    const BEGIN_ROUND_DELAY_MS = 6000;

    {
        const [msg, respBody] = client.getMessageBuffer(0x00420116, 0x6);
        respBody.writeUint16LE(0x0000, 0);
        respBody.writeUint32LE(0x0000, 2);
        client.send(msg);
        console.log(`[ZDispatchWaiting] >> Sent 0x00420116 after ${sourceTag}`);
    }

    setTimeout(() => {
        // BeginRound_SN — 실제 서버는 IP:Port/MapName 형식으로 ClientTravel
        // Cache.Bin 인덱스 → 맵 파일명 변환
        const CACHE_INDEX_TO_MAP_NAME = {
            58: 'Map_PC01', 70: 'Map_PC02', 64: 'Map_PC03', 77: 'Map_PC04',
            8: 'Map_C01', 34: 'Map_C02', 83: 'Map_C03', 32: 'Map_C04',
            6: 'Map_C06', 2: 'Map_C08', 56: 'Map_C08_R', 26: 'Map_C09',
            36: 'Map_C18', 43: 'Map_C19', 16: 'Map_C20', 24: 'Map_C21',
            45: 'Map_C22', 47: 'Map_C25', 49: 'Map_C30',
            14: 'Map_N01', 54: 'Map_N01_R', 10: 'Map_N05', 22: 'Map_N07',
            52: 'Map_N11', 30: 'Map_N13', 18: 'Map_N17',
            1: 'Map_Ptuto', 4: 'Map_Ptuto2',
        };
        const mapCacheKey = Number(client.campaignMapCacheKey_) || 58;
        const mapName = CACHE_INDEX_TO_MAP_NAME[mapCacheKey] || 'Map_PC01';
        // body: u16 0, u16 0, map name null-terminated string
        const mapNameBuf = Buffer.from(mapName + '\0', 'ascii');
        const [msg, respBody] = client.getMessageBuffer(0x00230152, 4 + mapNameBuf.length);
        respBody.writeUint16LE(0, 0);
        respBody.writeUint16LE(0, 2);
        mapNameBuf.copy(respBody, 4);
        client.send(msg);
        console.log(`[ZDispatchWaiting] >> Sent 0x00230152 after ${sourceTag} (${BEGIN_ROUND_DELAY_MS}ms delay) map=${mapName}`);
    }, BEGIN_ROUND_DELAY_MS);
}

// ZDispatchCommunity + ZDispatchFriend + other social services
//
//   0x26XXXX = Quest/License
//   0x31XXXX = Hangar
//   0x32XXXX = Card
//   0x36XXXX = Clan
//   0x41XXXX = Postbox
//   0x42XXXX = Waiting
//   0x51XXXX = Unknown

// Quest/tutorial message IDs
const CQ_QUEST_COMPLETE  = 0x00260111;
const SA_QUEST_COMPLETE  = 0x00260112;

// License query — client sends this from the game server to get current license list.
// Must respond with actual SN_LICENSE_INFO data, NOT a blank ACK.
const CQ_LICENSE_QUERY   = 0x00260121;
const SN_LICENSE_INFO    = 0x00260101;   // server notify opcode for license data

module.exports =
class ZCommunityDispatch
{
    dispatch(client, type, body)
    {
        console.log(`[RAW_ALL] 0x${type.toString(16).padStart(8,'0')} (${body.length} bytes)` +
        (body.length > 0 ? ` body: ${body.toString('hex')}` : ''));
        const prefix = (type >> 16) & 0xFF;

        // ── DEBUG: 상점 opcode 탐색용 전체 패킷 로깅 ──────────────────────────
        // 상점/창고 진입시 어떤 opcode가 오는지 확인하기 위해 모든 패킷을 찍습니다.
        // 원인 파악 후 이 블록을 삭제하세요.
        console.log(`[DEBUG_ALL] 0x${type.toString(16).padStart(8,'0')} prefix=0x${prefix.toString(16)} (${body.length} bytes)` +
            (body.length > 0 && body.length <= 32 ? ` | ${body.toString('hex')}` : ''));
        // ─────────────────────────────────────────────────────────────────────

        if (prefix !== 0x24 && prefix !== 0x26 && prefix !== 0x31 &&
            prefix !== 0x32 && prefix !== 0x36 && prefix !== 0x41 &&
            prefix !== 0x42 && prefix !== 0x51)
            return false;

        const prefixNames = {
            0x24: 'Hangar_Shop', 0x26: 'Quest', 0x31: 'Hangar', 0x32: 'Card',
            0x36: 'Clan',  0x41: 'Postbox', 0x42: 'Waiting', 0x51: 'Unknown_51',
        };
        const name = prefixNames[prefix] || 'Unknown';
        console.log(`[ZDispatch${name}] Message 0x${type.toString(16).padStart(8, '0')} (${body.length} bytes)`);
        if (body.length > 0)
            console.log(`[ZDispatch${name}] Body:`, body.toString('hex'));

        // Tutorial completion save
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

        // License info query from game server — MUST send full SN_LICENSE_INFO
        // A blank ACK (0x00260122) wipes the client's license list → "기간만료" + "라이선스 없음"
        if (type === CQ_LICENSE_QUERY) {
            this.sendLicenseInfo(client);
            return true;
        }

        // 0x310101 = Hangar Open CQ from client → respond with shop data
        if (type === 0x00310101) {
            this.handleHangarOpen(client);
            return true;
        }

        // 0x310216 = client ready for cash shop
        if (type === 0x00310216) {
            this.sendCashShop(client);
            return true;
        }

        // Ready_Host_CA follow-up from the game-start handshake.
        // Static analysis shows the client constructs 0x420114 after Ready_Host_SN.
        if (type === 0x00420114) {
            console.log(`[ZDispatchWaiting] >> Ready_Host_CA-like packet 0x00420114 body=${body.toString('hex')}`);
            sendReadySuccessAndBeginRound(client, '0x00420114');
            return true;
        }

        // Card CQ (0x00320104) — client sends this right after channel enter with 0-byte body.
        // The DLL constructor at 0xD33F3 shows 0x320104 has a 16-byte body, so respond
        // with 0x320105 (SA) containing 16 zero bytes to unblock the client.
        if (type === 0x00320104) {
            const [msg, respBody] = client.getMessageBuffer(0x00320105, 16);
            respBody.fill(0);
            client.send(msg);
            console.log(`[ZDispatchCard] >> Sent Card SA (0x00320105) 16 bytes`);
            return true;
        }

        // Generic auto-ACK for unknown odd-numbered (CQ) messages
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

    async sendLicenseInfo(client)
    {
        try {
            let licenses = [];
            if (client.accountId_) {
                licenses = await db.getMechLicenses(client.accountId_);
            }

            if (licenses.length === 0) {
                licenses = Array.from({length: MAX_SLOT_COUNT}, (_, i) => ({
                    mech_type: i + 1, license_type: 0,
                }));
            }

            // DLL reads 9-byte entries as [u32 mechType][u8 pad][u32 type]
            const [msg, body] = client.getMessageBuffer(SN_LICENSE_INFO, 0x2 + (9 * licenses.length));
            let offset = 0;
            body[offset++] = 0x00;
            body[offset++] = licenses.length;
            for (const lic of licenses) {
                body.writeUint32LE(lic.mech_type, offset);
                body.writeUint8(0, offset + 4);
                body.writeUint32LE(lic.license_type || 1, offset + 5);
                offset += 9;
            }
            client.send(msg);
            console.log(`[ZDispatchQuest] >> Sent SN_LICENSE_INFO: ${licenses.length} licenses`);

            const [ackMsg, ackBody] = client.getMessageBuffer(0x00260122, 0x6);
            ackBody.writeUint16LE(0x0000, 0);
            ackBody.writeUint32LE(0x0000, 2);
            client.send(ackMsg);

        } catch (err) {
            console.error(`[ZDispatchQuest] >> sendLicenseInfo error:`, err.message);
        }
    }

    async handleHangarOpen(client)
    {
        // Step 1: 0x310102 Open SA — client's handler sets [ESI+8]=1 (hangar-open flag),
        // which allows subsequent 0x310201 items to trigger the UI refresh at 0x0E6AEA.
        {
            const [msg, respBody] = getExactMessageBuffer(0x00310102, 0x6);
            respBody.writeUint16LE(0x0000, 0);
            respBody.writeUint32LE(0x0000, 2);
            client.send(msg);
            console.log(`[ZDispatchHangar] >> Sent Hangar Open_SA (0x310102)`);
        }

        // Step 2: SN_GRADE_INFO
        {
            const [msg, respBody] = getExactMessageBuffer(0x00510101, 4);
            respBody.writeUInt32LE(11, 0);
            client.send(msg);
        }

        // Step 3: ShopList — 0x310201 per item (DLL handler at 0x0E6A90, patched)
        // Body hypothesis:
        //   [u32 itemIndex][u8 bActive][u8 bPurchase][u8 bCategory][u8 pad]
        //   [i32 disPrice][i32 price][u8 bShow][u8 bNew][u8 bHot][u8 bSale]
        //
        // Current experiment:
        //   itemIndex = 0-based catalog order, not DB item_id.
        //   category  = DB category_type converted from 1~9 to 0~8.
        try {
            const catalog = await db.getItemCatalog();
            const count = catalog.length;

            for (const [idx, item] of catalog.entries()) {
                const [msg, body] = getExactMessageBuffer(0x00310201, 20);
                const category = catalogCategoryType(item);
                const price = catalogShopPrice(item);

                body.writeUint32LE(idx,                     0x00);  // experiment: Cache/catalog index
                body.writeUint8(1,                          0x04);  // bActive
                body.writeUint8(1,                          0x05);  // bPurchase
                body.writeUint8(category,                   0x06);  // bCategory
                body.writeUint8(0,                          0x07);  // pad
                body.writeInt32LE(price,                    0x08);  // disPrice
                body.writeInt32LE(price,                    0x0C);  // price
                body.writeUint8(1,                          0x10);  // bShow
                body.writeUint8(0,                          0x11);
                body.writeUint8(0,                          0x12);
                body.writeUint8(0,                          0x13);
                client.send(msg);

                if (idx < 10) {
                    console.log(`[ZDispatchHangar] >> Shop item[${idx}]: item_id=${item.item_id} cat=${category} price=${price}`);
                }
            }
            console.log(`[ZDispatchHangar] >> Sent ${count} x 0x310201 (itemIndex=catalog index, category=DB-1 0~8)`);

        } catch (err) {
            console.error(`[ZDispatchHangar] >> ShopList error:`, err.message);
        }

        // Step 4: CashShop
        this.sendCashShop(client);
    }

    sendCashShop(client)
    {
        // 0x310202 = cash shop header (empty), 0x310213 = cash shop data (empty)
        // Also sent on 0x310216 (client re-requests cash shop after item receipt)
        {
            const [msg, body] = getExactMessageBuffer(0x00310202, 8);
            body.writeUint32LE(0, 0);
            body.writeUint32LE(0, 4);
            client.send(msg);
        }
        {
            const [msg, body] = getExactMessageBuffer(0x00310213, 3);
            body.writeUint8(0, 0);
            body.writeUint8(0, 1);
            body.writeUint8(0, 2);
            client.send(msg);
        }
        console.log(`[ZDispatchHangar] >> Sent cash shop (0x310202 + 0x310213)`);
    }
};
