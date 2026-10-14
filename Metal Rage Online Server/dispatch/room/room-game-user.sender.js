const db = require('../../database/db');
const { CANONICAL_LOADOUTS } = require('../../database/default-loadouts');

const SN_GAME_USER = 0x00222112;
const GAME_USER_RECORD_SIZE = 0x01E5;
const GAME_USER_HEADER_SIZE = 0x02;
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

async function sendGameUserBootstrap(client, ctx, getExactMessageBuffer, opts) {

    const {
        accountIndex,
        nickname,
        userLevelText,
        teamIndex,
        selectedMech,
        pilotId,
    } = ctx;

    if (teamIndex !== 0 && teamIndex !== 1) {
        console.error(`[ZRoomDispatch] !! Game_User_SN assertion failed: teamIndex=${teamIndex} is not 0/1 (accountIndex=${accountIndex}) -- refusing to send`);
        return;
    }

    const targetClient = (opts && opts.sendTo) || client;
    const itemsAccountId = (opts && opts.itemsAccountId !== undefined) ? opts.itemsAccountId : client.accountId_;

    let items = [];
    if (itemsAccountId) {
        try {
            items = await db.getItemsWithEquipViews(itemsAccountId);
        } catch (err) {
            console.error(`[ZRoomDispatch] >> Game_User_SN item lookup failed: ${err.message}`);
        }
    }

    const mechType = Math.max(Number(selectedMech) || 1, 1);

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

    const pveExtraLives = 0;
    body.writeUint32LE(pveExtraLives, rec + 0x64);

    const SLOT_COUNT = 8;
    const SLOT_RECORD_SIZE = 0x2F;
    body.writeUint8(SLOT_COUNT, rec + 0x6C);

    const summary = [];
    for (let slotNo = 1; slotNo <= SLOT_COUNT; slotNo++) {
        const socket = rec + GAME_USER_SOCKET_OFFSET + (slotNo - 1) * SLOT_RECORD_SIZE;
        const def = CANONICAL_LOADOUTS[slotNo] || CANONICAL_LOADOUTS[1];
        const bodyItem = equippedBySlot(items, slotNo, 0);
        const mainItem = equippedBySlot(items, slotNo, 1);
        const leftItem = equippedBySlot(items, slotNo, 2);
        const rightItem = equippedBySlot(items, slotNo, 3);
        const equipmentItem = equippedBySlot(items, slotNo, 4);
        const skinItem = equippedBySlot(items, slotNo, 5);
        const bodyId = Number(bodyItem && bodyItem.item_id) || def.body;
        const mainId = Number(mainItem && mainItem.item_id) || def.main;
        const leftId = Number(leftItem && leftItem.item_id) || def.left;

        const rightId = rightItem ? Number(rightItem.item_id) || 0 : def.right;
        const boosterId = equipmentItem ? Number(equipmentItem.item_id) || 0 : def.booster;
        const skinId = skinItem ? Number(skinItem.item_id) || 0 : def.skin;

        body.writeUint32LE(slotNo, socket + 0x00);

        body.writeUint32LE(bodyId, socket + 0x04);

        body.writeUint8(0, socket + 0x08);

        body.writeUint32LE(mainId, socket + 0x15);
        body.writeUint32LE(leftId, socket + 0x19);
        body.writeUint32LE(rightId, socket + 0x1D);
        body.writeUint32LE(boosterId, socket + 0x21);
        body.writeUint32LE(skinId, socket + 0x25);
        summary.push(`${slotNo}:${bodyId}/${mainId}`);
    }

    targetClient.send(msg);
    targetClient.gameUserBootstrapSent_ = true;
    console.log(
        `[ZRoomDispatch] >> Sent Game_User_SN 0x00222112 ` +
        `(userIndex=${accountIndex}, team=${teamIndex}, selectedMech=${mechType}, slots=${summary.join(' ')})` +
        (pveExtraLives !== 0 ? ` pveExtraLives=${pveExtraLives}` : '') +
        (targetClient !== client ? ` -> conn=${targetClient.connId_}` : '')
    );
}

module.exports = {
    sendGameUserBootstrap,
};
