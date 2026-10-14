

const fs = require('fs');
const path = require('path');

const GAME_ITEM_RECORD_TABLE_START = 0x2294;
const GAME_ITEM_RECORD_ENTRY_SIZE = 0x67;
const GAME_ITEM_RECORD_COUNT = 2112;

const GIR_BODY_INDEX_OFFSET = 84;

let cached = null;

function loadCacheIndexByItemId() {
    if (cached) return cached;

    const indexByItemId = {};
    const representByItemId = {};
    const periodByItemId = {};
    const girPositionByItemId = {};
    try {

        const cachePath = require('../config/cache').findCacheBinPath();
        const bytes = fs.readFileSync(cachePath);
        const headerSize = 82;
        const entrySize = 103;
        const itemIdOffset = 96;

        for (let i = 0; headerSize + (i * entrySize) + itemIdOffset + 4 <= bytes.length; i++) {
            const itemId = bytes.readInt32LE(headerSize + (i * entrySize) + itemIdOffset);
            if (itemId > 0 && indexByItemId[itemId] == null) {
                indexByItemId[itemId] = i;
            }
        }
        console.log(`[CacheIndex] Loaded ${Object.keys(indexByItemId).length} Cache.Bin item indexes`);
        const firstRecordItemId = bytes.readInt32LE(GAME_ITEM_RECORD_TABLE_START);
        const tableEnd = GAME_ITEM_RECORD_TABLE_START
            + (GAME_ITEM_RECORD_COUNT * GAME_ITEM_RECORD_ENTRY_SIZE);
        if (firstRecordItemId !== 11100101 || tableEnd > bytes.length) {
            console.warn(
                `[CacheIndex] Cache.Bin GameItemRecord table sanity failed: `
                + `first=${firstRecordItemId} expected=11100101 end=0x${tableEnd.toString(16)} `
                + `size=0x${bytes.length.toString(16)}`
            );
        } else {
            for (let i = 0; i < GAME_ITEM_RECORD_COUNT; i++) {
                const recordOffset = GAME_ITEM_RECORD_TABLE_START + (i * GAME_ITEM_RECORD_ENTRY_SIZE);
                const itemId = bytes.readInt32LE(recordOffset);
                const representIndex = bytes.readInt32LE(recordOffset + 0x04);
                const periodSeconds = bytes.readInt32LE(recordOffset + 0x43);
                if (itemId > 0) {
                    if (representIndex > 0 && representByItemId[itemId] == null) {
                        representByItemId[itemId] = representIndex;
                    }
                    periodByItemId[itemId] = periodSeconds;
                    if (girPositionByItemId[itemId] == null) {
                        girPositionByItemId[itemId] = i;
                    }
                }
            }
        }
        const sampleIds = [22100101, 22100102, 22100103, 22100104, 22100105, 22100106, 22100107, 22100108];
        const samples = sampleIds.map(itemId =>
            `${itemId}->rep ${representByItemId[itemId] ?? 'unknown'} period ${periodByItemId[itemId] ?? 'unknown'}`
        ).join(', ');
        console.log(`[CacheIndex] Cache.Bin represent samples: ${samples}`);
    } catch (err) {
        console.warn(`[CacheIndex] Cache.Bin index load failed: ${err.message}`);
    }

    cached = { indexByItemId, representByItemId, girPositionByItemId };
    return cached;
}

module.exports = { loadCacheIndexByItemId };
