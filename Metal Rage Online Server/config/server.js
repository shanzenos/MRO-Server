const fs = require('fs');
const path = require('path');
const { isIPv4 } = require('net');

let config;

function load()
{
    if (config) return config;
    const filename = path.join(__dirname, 'server.json');
    try {
        config = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        config = {};
    }
    const host = config.publicHost || '127.0.0.1';
    if (!isIPv4(host)) throw new Error('config/server.json: publicHost must be an IPv4 address');
    config.publicHost = host;
    const startingCredits = config.startingCredits == null ? 100000 : Number(config.startingCredits);
    if (!Number.isSafeInteger(startingCredits) || startingCredits < 0 || startingCredits > 2147483647) {
        throw new Error('config/server.json: startingCredits must be an integer from 0 to 2147483647');
    }
    if (config.grantAllItemsAndMaxCredits != null && typeof config.grantAllItemsAndMaxCredits !== 'boolean') {
        throw new Error('config/server.json: grantAllItemsAndMaxCredits must be true or false');
    }
    if (config.whitelistEnabled != null && typeof config.whitelistEnabled !== 'boolean') {
        throw new Error('config/server.json: whitelistEnabled must be true or false');
    }
    config.startingCredits = startingCredits;
    config.grantAllItemsAndMaxCredits = config.grantAllItemsAndMaxCredits === true;
    config.whitelistEnabled = config.whitelistEnabled === true;
    return config;
}

function getPublicHost() { return load().publicHost; }

module.exports = { getPublicHost, getAccountSettings: () => load(), load };
