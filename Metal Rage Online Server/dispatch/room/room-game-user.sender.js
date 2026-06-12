const db = require('../../database/db');

const SN_GAME_USER = 0x00230111;
const GAME_USER_RECORD_SIZE = 0x01E5;
const GAME_USER_HEADER_SIZE = 0x02;
// rec+0x6C = socketCount, rec+0x6D = first socket (stride 0x2F, 8 sockets = 0x1E5 tail)
const GAME_USER_SOCKET_OFFSET = 0x6D;
const GAME_USER_SOCKET_SIZE = 0x2F;

function writeCString(body, text, offset, maxBytes) {
    const value = String(text || '').slice(0, Math.max(maxBytes - 1, 0));
    body.write(value + '\0', offset, Math.max(maxBytes, 0), 'ascii');
}

function equippedBySlot(items, mechType, partSlot) {
    return items.find(item =>
        Number(item.equipped) === 1 &&
        Number(item.mech_type) === Number(mechType) &&
        Number(item.part_slot) === Number(partSlot)
    );
}

async function sendGameUserBootstrap(client, ctx, getExactMessageBuffer) {
    if (!client.campaignRoom_) {
        return;
    }
    if (client.gameUserBootstrapSent_) {
        console.log('[ZRoomDispatch] >> Skipped Game_User_SN 0x230111 (already sent)');
        return;
    }

    const {
        accountIndex,
        nickname,
        userLevelText,
        teamIndex,
        selectedMech,
        pilotId,
    } = ctx;

    let items = [];
    if (client.accountId_) {
        try {
            items = await db.getItems(client.accountId_);
        } catch (err) {
            console.error(`[ZRoomDispatch] >> Game_User_SN item lookup failed: ${err.message}`);
        }
    }

    const mechType = Math.max(Number(selectedMech) || 1, 1);
    const bodyItem = equippedBySlot(items, mechType, 0);
    const mainItem = equippedBySlot(items, mechType, 1);
    const leftItem = equippedBySlot(items, mechType, 2);
    const rightItem = equippedBySlot(items, mechType, 3);
    const equipmentItem = equippedBySlot(items, mechType, 4);
    const skinItem = equippedBySlot(items, mechType, 5);

    const [msg, body] = getExactMessageBuffer(SN_GAME_USER, GAME_USER_HEADER_SIZE + GAME_USER_RECORD_SIZE);
    body.writeUint8(0, 0x00);
    body.writeUint8(1, 0x01);

    const rec = GAME_USER_HEADER_SIZE;
    // rec+0x00: u16 userIndex
    body.writeUint16LE(accountIndex, rec + 0x00);
    // rec+0x02: u16 teamIndex
    body.writeUint16LE(teamIndex, rec + 0x02);
    // rec+0x04: u32 Game_User_Add field — pass accountIndex as the key for 0x81c array lookup
    body.writeUint32LE(accountIndex, rec + 0x04);
    // rec+0x08: u32 pilotCode → Game_Item_Add param2, stored as GAME_ITEM_INFO.PilotCode
    body.writeUint32LE(Number(pilotId) || 101, rec + 0x08);
    // rec+0x0C: unknown
    body.writeUint32LE(0, rec + 0x0C);
    // rec+0x10: u32 selectedSlotRaw (1..7 → slot 0..6; mechType=1 → slot 0)
    body.writeUint32LE(mechType, rec + 0x10);
    // rec+0x14: u32 clan/emblem
    body.writeUint32LE(0, rec + 0x14);
    // rec+0x18: u32 clan/emblem
    body.writeUint32LE(0, rec + 0x18);
    // rec+0x1C: ascii[2] level text (2 bytes, parsed via atoi)
    writeCString(body, userLevelText || '1', rec + 0x1C, 0x02);
    // rec+0x1E: asciiz[0x19] nickname
    writeCString(body, nickname || 'Player', rec + 0x1E, 0x19);
    // rec+0x37: asciiz[0x19] clan name
    writeCString(body, '', rec + 0x37, 0x19);

    // rec+0x50-0x6B: Game_Item_Add bonus/stats fields (all 0 = no bonus)
    // rec+0x6C: socketCount byte
    body.writeUint8(1, rec + 0x6C);

    // Socket 0: rec+0x6D (socket+0x00..0x2E)
    const socket = rec + GAME_USER_SOCKET_OFFSET;
    // socket+0x00: u32 raw slot/mech selector (1..7 → 0..6; mechType=1 → slot 0)
    body.writeUint32LE(mechType, socket + 0x00);
    // socket+0x04: u32 body item
    body.writeUint32LE(Number(bodyItem && bodyItem.item_id) || mechType, socket + 0x04);
    // socket+0x08: u8 state/user-socket field
    body.writeUint8(0, socket + 0x08);
    // socket+0x09-0x14: unknown (zeros, left as buffer default)
    // socket+0x15: u32 main weapon
    body.writeUint32LE(Number(mainItem && mainItem.item_id) || 0, socket + 0x15);
    // socket+0x19: u32 left weapon
    body.writeUint32LE(Number(leftItem && leftItem.item_id) || 0, socket + 0x19);
    // socket+0x1D: u32 right weapon
    body.writeUint32LE(Number(rightItem && rightItem.item_id) || 0, socket + 0x1D);
    // socket+0x21: u32 equipment
    body.writeUint32LE(Number(equipmentItem && equipmentItem.item_id) || 0, socket + 0x21);
    // socket+0x25: u32 skin
    body.writeUint32LE(Number(skinItem && skinItem.item_id) || 0, socket + 0x25);
    // socket+0x29-0x2E: padding (zeros)

    client.send(msg);
    client.gameUserBootstrapSent_ = true;
    console.log(
        `[ZRoomDispatch] >> Sent Game_User_SN 0x230111 ` +
        `(userIndex=${accountIndex}, team=${teamIndex}, selectedMech=${mechType}, ` +
        `body=${Number(bodyItem && bodyItem.item_id) || 0}, main=${Number(mainItem && mainItem.item_id) || 0})`
    );
}

module.exports = {
    sendGameUserBootstrap,
};
