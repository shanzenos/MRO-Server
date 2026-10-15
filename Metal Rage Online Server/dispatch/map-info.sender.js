'use strict';

const MAP_INFO_REAL_IDS = [9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009, 9010, 9011, 9012];

const MAP_IDS_PVP = [1011, 1021, 1031, 1041, 1051, 1061, 1071, 1081];

const SN_MAP_INFO = 0x210115;

function resolveRealMapIds() {

    return [...MAP_INFO_REAL_IDS, ...MAP_IDS_PVP];
}

function sendMapInfoSN(client, mapIds) {
    const mapCount = mapIds.length;
    const [msg, body] = client.getMessageBuffer(SN_MAP_INFO, 0x2 + (4 * mapCount));
    let offset = 0;
    body[offset++] = 0x00;
    body[offset++] = mapCount;
    for (const mapId of mapIds) {
        body.writeUint32LE(mapId, offset);
        offset += 4;
    }
    client.send(msg);
}

module.exports = { SN_MAP_INFO, MAP_INFO_REAL_IDS, MAP_IDS_PVP, resolveRealMapIds, sendMapInfoSN };
