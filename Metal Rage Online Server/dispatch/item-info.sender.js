

const ITEM_INFO_CHUNK = 12;

const ITEM_INFO_INCLUDE_BODY = true;

const SN_ITEM_INFO = 0x00210111;
const ITEM_RECORD_SIZE = 35;
const HEADER_SIZE = 6;

async function sendItemInfo(client, items, accountId, tag)
{
    const db = require('../database/db');
    let equippedSerialIds = null;
    {
        const equips = await db.getItemEquips(accountId);
        equippedSerialIds = new Set(equips.map(equip => Number(equip.item_id)));
    }

    const rows = ITEM_INFO_INCLUDE_BODY
        ? items
        : items.filter(item => Number(item.part_slot) !== 0);
    const chunkSize = Math.max(1, Math.min(ITEM_INFO_CHUNK, 28));

    for (let start = 0; start < rows.length; start += chunkSize) {
        const chunk = rows.slice(start, start + chunkSize);
        const [msg, body] = client.getMessageBuffer(SN_ITEM_INFO, HEADER_SIZE + (ITEM_RECORD_SIZE * chunk.length));
        body.writeUint8(1, 0);
        body.writeUint8(chunk.length, 1);
        body.writeUint32LE(accountId || 0, 2);
        let offset = HEADER_SIZE;
        for (const item of chunk) {
            const isEquipped = equippedSerialIds
                ? equippedSerialIds.has(Number(item.id))
                : !!item.equipped;
            body.writeUint32LE(item.id || 0, offset);
            body.writeUint32LE(item.item_id, offset + 0x04);
            body.writeUint32LE(isEquipped ? 1 : 0, offset + 0x08);
            body.writeUint32LE(0, offset + 0x0C);
            body.writeUint16LE(item.mech_type || 0, offset + 0x10);
            body.writeUint32LE(item.part_slot || 0, offset + 0x12);
            body.writeUint8(isEquipped ? 2 : 0, offset + 0x16);
            body.writeUint32LE(item.quantity || 1, offset + 0x17);
            body.writeUint32LE(0xFFFFFFFF, offset + 0x1B);
            body.writeUint32LE(0xFFFFFFFF, offset + 0x1F);
            offset += ITEM_RECORD_SIZE;
        }
        client.send(msg);
    }

    const packets = Math.ceil(rows.length / chunkSize);
    console.log(`[ItemInfo] >> Sent SN_ITEM_INFO [${tag}]: ${rows.length} items in ${packets} packet(s) (chunk=${chunkSize}, body rows ${ITEM_INFO_INCLUDE_BODY ? 'included' : 'excluded'})`);
}

module.exports = { sendItemInfo };
