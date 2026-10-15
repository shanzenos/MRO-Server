

const MAP_ALL_ENTRY_OFFSET = 0x02;

function isMapAllSingleEntryEnabled() {
    return true;
}

const SN_MAP_CHANGE_ALL = 0x00220226;
const SN_MAP_CHANGE_ONE = 0x00220223;
const SN_CAMPAIGN = 0x0023013A;

function resolveMapChangeOneSetting(candidates, fallback, max)
{

    for (const candidate of candidates) {
        const value = Number(candidate);
        if (Number.isInteger(value) && value >= 0 && value <= max) {
            return value;
        }
    }
    return fallback;
}

function sendMapChangeOnePacket(client, mapList, effectiveSelectedIdx, ctx, getExactMessageBuffer)
{
    const {
        roomSettingGoal,
        roomSettingTime,
        roomSettingRound,

        mapChangeOneTime,
        mapChangeOneRound,
        playRound,
        mapChangeOneKill,
        mapChangeOneGoal,
    } = ctx;
    const effectiveCacheKey = mapList[effectiveSelectedIdx] >>> 0;
    const [msg, respBody] = getExactMessageBuffer(SN_MAP_CHANGE_ONE, 0x0A);
    const mapTime = resolveMapChangeOneSetting(
        [mapChangeOneTime, roomSettingTime], 0, 0xFFFF
    );
    const mapRound = resolveMapChangeOneSetting(
        [mapChangeOneRound, playRound, roomSettingRound], 1, 0xFF
    );
    const mapKill = resolveMapChangeOneSetting(
        [mapChangeOneKill, roomSettingGoal], 0, 0xFFFF
    );
    const mapGoal = resolveMapChangeOneSetting(
        [mapChangeOneGoal, roomSettingGoal], 0, 0xFFFF
    );
    respBody.writeUint8(0, 0x00);
    respBody.writeUint16LE(effectiveCacheKey, 0x01);
    respBody.writeUint16LE(mapTime, 0x03);
    respBody.writeUint8(mapRound, 0x05);
    respBody.writeUint16LE(mapKill, 0x06);
    respBody.writeUint16LE(mapGoal, 0x08);
    client.send(msg);
    console.log(`[ZRoomDispatch] >> Sent SN_MAP_CHANGE_ONE 0x220223 (slot=0, cacheKey=${effectiveCacheKey}, time=${mapTime}, round=${mapRound}, kill=${mapKill}, goal=${mapGoal})`);
}

function sendMapChangeAllPacket(client, mapList, effectiveSelectedIdx, campaignMapCacheKey, getExactMessageBuffer, sendTwice)
{
    const count = mapList.length;
    const bodySize = MAP_ALL_ENTRY_OFFSET + count * 9;
    const [msgAll, bodyAll] = getExactMessageBuffer(SN_MAP_CHANGE_ALL, bodySize);
    // byte[0]=0(flag), byte[1]=count — 클라이언트 파서 기대 포맷 (expected format by the client parser)
    bodyAll.writeUint8(0, 0x00);
    bodyAll.writeUint8(count, 0x01);
    if (MAP_ALL_ENTRY_OFFSET === 0x06)
        bodyAll.writeUint32LE(0, 0x02);
    for (let i = 0; i < count; i++) {
        const entryOffset = MAP_ALL_ENTRY_OFFSET + (i * 9);
        const cacheIndex = mapList[i] >>> 0;
        bodyAll.writeUint16LE(cacheIndex, entryOffset + 0x00);
        bodyAll.writeUint16LE(0, entryOffset + 0x02);
        bodyAll.writeUint8(i === effectiveSelectedIdx ? 1 : 0, entryOffset + 0x04);
        bodyAll.writeUint16LE(0, entryOffset + 0x05);
        bodyAll.writeUint16LE(0, entryOffset + 0x07);
    }
    client.send(msgAll);

    if (sendTwice) {
        client.send(msgAll);
        console.log(`[ZRoomDispatch] >> Sent SN_MAP_CHANGE_ALL 0x220226 again (NETWORK_ROOM_INFO fires before the write)`);
    }

    console.log(`[ZRoomDispatch] >> Sent SN_MAP_CHANGE_ALL 0x220226 (count=${count}, selectedIdx=${effectiveSelectedIdx}, mapId=${campaignMapCacheKey}, header=${"compact"}, body=0x${bodySize.toString(16)})`);
}

function sendRoomMapPackets(client, ctx, getExactMessageBuffer, options = {}) {

    if (!ctx.isCampaignRoom && !ctx.isPvpRoom) {
        return;
    }

    const {
        campaignMapCacheKey,
        campaignMapHints,
        pvpMapHints,
        roomDefaultEntryHints,
    } = ctx;

    const selectedMapHints = ctx.isPvpRoom ? pvpMapHints : campaignMapHints;
    const mapList = (selectedMapHints && selectedMapHints.length > 0)
        ? selectedMapHints
        : (roomDefaultEntryHints || []);
    const count = mapList.length;
    if (count === 0) return;

    const selectedIdx = mapList.indexOf(Number(campaignMapCacheKey));
    const effectiveSelectedIdx = selectedIdx >= 0 ? selectedIdx : 0;
    const sendSupplementalAll = false;

    const allMapList = ctx.isPvpRoom
        ? mapList
        : (isMapAllSingleEntryEnabled() ? [mapList[effectiveSelectedIdx]] : mapList);
    const allEffectiveSelectedIdx = ctx.isPvpRoom
        ? effectiveSelectedIdx
        : (isMapAllSingleEntryEnabled() ? 0 : effectiveSelectedIdx);

    sendMapChangeAllPacket(
        client, allMapList, allEffectiveSelectedIdx, campaignMapCacheKey,
        getExactMessageBuffer, true
    );
    sendMapChangeOnePacket(client, mapList, effectiveSelectedIdx, ctx, getExactMessageBuffer);
    if (sendSupplementalAll) {
        sendMapChangeAllPacket(
            client, allMapList, allEffectiveSelectedIdx, campaignMapCacheKey,
            getExactMessageBuffer, false
        );
    }
}

function sendCampaignBootstrap(client, getExactMessageBuffer) {
    const [msg, body] = getExactMessageBuffer(SN_CAMPAIGN, 0x29);
    body.writeUint16LE(0, 0x00);
    body.writeUint32LE(0, 0x02);
    body.writeUint8(1, 0x0C);

    body.writeUint16LE(1, 0x0D);
    body.writeUint16LE(0, 0x0F);
    body.writeUint8(1, 0x11);
    body.writeUint8(1, 0x12);
    body.writeUint16LE(0, 0x13);
    body.writeUint16LE(0, 0x15);
    body.writeUint32LE(0, 0x17);

    body.writeUint16LE(2, 0x1B);
    body.writeUint16LE(0, 0x1D);
    body.writeUint8(1, 0x1F);
    body.writeUint8(0, 0x20);
    body.writeUint16LE(0, 0x21);
    body.writeUint16LE(0, 0x23);
    body.writeUint32LE(0, 0x25);
    client.send(msg);
    console.log(`[ZRoomDispatch] >> Sent Campaign_SN 0x23013A (action=1)`);
}

module.exports = { sendRoomMapPackets, sendCampaignBootstrap };
