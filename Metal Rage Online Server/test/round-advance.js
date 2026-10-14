'use strict';

const assert = require('assert');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const DB_PATH = require.resolve(path.join(ROOT, 'database', 'db.js'));

const { makeFixtureDb } = require('./fixtures/fake-db.js');
const { makeFakeClient } = require('./fixtures/fake-client.js');
const { installFakeTimers } = require('./fixtures/fake-timers.js');

function installFakeModule(resolvedPath, exportsObj)
{
    const mod = new Module(resolvedPath, null);
    mod.filename = resolvedPath;
    mod.loaded = true;
    mod.exports = exportsObj;
    require.cache[resolvedPath] = mod;
}

installFakeModule(DB_PATH, makeFixtureDb());
installFakeModule(require.resolve('../config/whitelist'), { isAllowed: () => true, getHostAddress: () => '127.0.0.1' });

const GateGameDispatch = require('../dispatch/gate.game.dispatch.js');
const LobbyDispatch = require('../dispatch/lobby.dispatch.js');

const CAMPAIGN_CN = 0x00230139;
const END_ROUND_SN = 0x00222211;
const END_GAME_SN = 0x00222213;
const GAME_START_CQ = 0x00222103;

const EXPECTED_END_ROUND_BODY_HEX =
    '0000' + '0000' + '00'.repeat(12) + '0100' + '00'.repeat(12);
assert.strictEqual(EXPECTED_END_ROUND_BODY_HEX.length, 0x1E * 2);

function makeCampaignCnBody(action)
{
    const body = Buffer.alloc(3);
    body[0] = 1;
    body[1] = 0;
    body[2] = action;
    return body;
}

function lastSent(client)
{
    return client._sent[client._sent.length - 1];
}

function runFiveRoundsCase()
{
    const gateDispatch = new GateGameDispatch();
    const lobbyDispatch = new LobbyDispatch();

    const client = makeFakeClient(1, 30907);
    client.playRound_ = 5;

    for (let clearedSoFar = 1; clearedSoFar <= 5; clearedSoFar++) {
        const handled = lobbyDispatch.dispatch(client, CAMPAIGN_CN, makeCampaignCnBody(1));
        assert.strictEqual(handled, true, `Campaign_CN #${clearedSoFar} should be handled`);

        const sent = lastSent(client);
        if (clearedSoFar < 5) {
            assert.strictEqual(sent.op, '0x' + END_ROUND_SN.toString(16).padStart(8, '0'),
                `clear #${clearedSoFar}/5 should answer EndRound_SN, got ${sent.op}`);
            assert.strictEqual(sent.len, 0x1E,
                `EndRound_SN body should be exactly 30 bytes, got ${sent.len}`);
            assert.strictEqual(sent.hex, EXPECTED_END_ROUND_BODY_HEX,
                `EndRound_SN body mismatch on clear #${clearedSoFar}`);
        } else {
            assert.strictEqual(sent.op, '0x' + END_GAME_SN.toString(16).padStart(8, '0'),
                `last clear (#${clearedSoFar}/5) should answer EndGame_SN, got ${sent.op}`);
        }
    }

    console.log('[round-advance] PASS: 5-round progression (4x EndRound_SN, then EndGame_SN)');
}

function runImmediateFailureCase()
{
    const lobbyDispatch = new LobbyDispatch();

    const client = makeFakeClient(2, 30907);
    client.playRound_ = 5;

    const handled = lobbyDispatch.dispatch(client, CAMPAIGN_CN, makeCampaignCnBody(2));
    assert.strictEqual(handled, true, 'Campaign_CN failure should be handled');

    const sent = lastSent(client);
    assert.strictEqual(sent.op, '0x' + END_GAME_SN.toString(16).padStart(8, '0'),
        `a first-attempt failure should answer EndGame_SN immediately, got ${sent.op}`);
    assert.strictEqual(client.pveRoundsCleared_ === undefined || client.pveRoundsCleared_ === 0, true,
        `failure path must not touch pveRoundsCleared_, got ${client.pveRoundsCleared_}`);

    console.log('[round-advance] PASS: immediate failure (action=2) -> EndGame_SN, counter untouched');
}

function runGameStartResetsCounterCase()
{
    const gateDispatch = new GateGameDispatch();
    const lobbyDispatch = new LobbyDispatch();

    const timers = installFakeTimers();
    try {
        const client = makeFakeClient(3, 30907);
        client.playRound_ = 5;
        client.pveRoundsCleared_ = 3;

        gateDispatch.dispatch(client, GAME_START_CQ, Buffer.alloc(0));
        assert.strictEqual(client.pveRoundsCleared_, 0,
            `Game_Start_CQ 0x00222103 should reset pveRoundsCleared_ to 0, got ${client.pveRoundsCleared_}`);
    } finally {
        timers.restore();
    }

    console.log('[round-advance] PASS: Room Game_Start_CQ 0x00222103 resets pveRoundsCleared_');
}

runFiveRoundsCase();
runImmediateFailureCase();
runGameStartResetsCounterCase();

console.log('[round-advance] ALL CASES PASS');
