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
    return config;
}

function getPublicHost() { return load().publicHost; }

module.exports = { getPublicHost, load };
