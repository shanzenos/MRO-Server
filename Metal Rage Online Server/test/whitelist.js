'use strict';

const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const path = require('path');

const serverPath = require.resolve('../config/server');
const whitelistPath = require.resolve('../config/whitelist');
const configPath = path.resolve(__dirname, '../config/allowed-users.json');
const configuredUsers = {
    users: [
        { name: 'Alice', ip: '203.0.113.5', hostAddress: '198.51.100.8' },
        { name: 'Bob', hostAddress: '192.168.1.20' },
    ],
};
const settings = { whitelistEnabled: false };
const serverModule = new Module(serverPath, null);
serverModule.filename = serverPath;
serverModule.loaded = true;
serverModule.exports = { load: () => settings };
require.cache[serverPath] = serverModule;

const readFileSync = fs.readFileSync;
const copyFileSync = fs.copyFileSync;
let configReads = 0;
fs.readFileSync = function (filename, ...args) {
    if (path.resolve(String(filename)) === configPath) {
        configReads++;
        return JSON.stringify(configuredUsers);
    }
    return readFileSync.call(this, filename, ...args);
};
fs.copyFileSync = function (source, destination, ...args) {
    if (path.resolve(String(destination)) === configPath) return;
    return copyFileSync.call(this, source, destination, ...args);
};

try {
    delete require.cache[whitelistPath];
    const whitelist = require(whitelistPath);

    assert.strictEqual(whitelist.isAllowed('Unlisted', '203.0.113.99'), true);
    assert.strictEqual(whitelist.getHostAddress('Unlisted', '::ffff:198.51.100.23'), '198.51.100.23');
    assert.strictEqual(configReads, 0, 'disabled whitelist must not read the allow-users file');

    settings.whitelistEnabled = true;
    assert.strictEqual(whitelist.isAllowed('alice', '::ffff:203.0.113.5'), true);
    assert.strictEqual(whitelist.isAllowed('Alice', '203.0.113.6'), false);
    assert.strictEqual(whitelist.isAllowed('Unlisted', '203.0.113.5'), false);
    assert.strictEqual(whitelist.getHostAddress('Alice', '203.0.113.5'), '198.51.100.8');
    assert.strictEqual(whitelist.getHostAddress('Bob', '192.168.1.20'), '192.168.1.20');
    assert.ok(configReads > 0, 'enabled whitelist must read the allow-users file');

    console.log('[whitelist test] PASS: disabled accepts any username/IP; enabled requires the configured username/IP pair');
} finally {
    fs.readFileSync = readFileSync;
    fs.copyFileSync = copyFileSync;
    delete require.cache[whitelistPath];
    delete require.cache[serverPath];
}
