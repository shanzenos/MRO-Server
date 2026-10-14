

const fs = require('fs');
const path = require('path');

const GAME_ITEM_RECORD_TABLE_START = 0x2294;
const GAME_ITEM_RECORD_ENTRY_SIZE = 0x67;
const GAME_ITEM_RECORD_COUNT = 2112;
const SHARE_TYPE_OFFSET = 0x4F;
const USE_TIME_OFFSET = 0x43;

let shareTypeByItemId = null;
let useTimeByItemId = null;

const { findCacheBinPath } = require('../config/cache');

function loadTables()
{
    shareTypeByItemId = {};
    useTimeByItemId = {};
    try {
        const cachePath = findCacheBinPath();

        const bytes = fs.readFileSync(cachePath);
        const firstRecordItemId = bytes.readInt32LE(GAME_ITEM_RECORD_TABLE_START);
        const tableEnd = GAME_ITEM_RECORD_TABLE_START + (GAME_ITEM_RECORD_COUNT * GAME_ITEM_RECORD_ENTRY_SIZE);
        if (firstRecordItemId !== 11100101 || tableEnd > bytes.length) {
            throw new Error('Unsupported Cache.Bin item table');
        }
        for (let i = 0; i < GAME_ITEM_RECORD_COUNT; i++) {
            const recordOffset = GAME_ITEM_RECORD_TABLE_START + (i * GAME_ITEM_RECORD_ENTRY_SIZE);
            const itemId = bytes.readInt32LE(recordOffset);
            if (itemId <= 0) continue;
            const shareType = bytes.readInt32LE(recordOffset + SHARE_TYPE_OFFSET);
            shareTypeByItemId[itemId] = shareType === 1 ? 1 : 0;
            useTimeByItemId[itemId] = bytes.readInt32LE(recordOffset + USE_TIME_OFFSET);
        }
        console.log(`[item-share-type] Loaded ShareType/UseTime for ${Object.keys(shareTypeByItemId).length} Cache.Bin items`);
    } catch (err) {
        shareTypeByItemId = null;
        useTimeByItemId = null;
        throw err;
    }
}

function getShareType(itemId)
{
    if (shareTypeByItemId === null) loadTables();
    const value = shareTypeByItemId[Number(itemId)];
    if (value === undefined) throw new Error(`Unknown item metadata: ${itemId}`);
    return value === 1 ? 1 : 0;
}

function getUseTimeSeconds(itemId)
{
    if (useTimeByItemId === null) loadTables();
    if (useTimeByItemId[Number(itemId)] === undefined) throw new Error(`Unknown item metadata: ${itemId}`);
    const value = Number(useTimeByItemId[Number(itemId)]);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

module.exports = { getShareType, getUseTimeSeconds };
