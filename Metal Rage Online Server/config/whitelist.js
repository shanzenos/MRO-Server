const fs = require('fs');
const path = require('path');
const serverConfig = require('./server');

const CONFIG_PATH = path.join(__dirname, 'allowed-users.json');

const HOST_ADDRESS_MAX_CHARS = 15;

const IPV4_LITERAL_RE = /^(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;

function isDottedIpv4Literal(value)
{
    return IPV4_LITERAL_RE.test(value);
}

let cached = undefined;

function load()
{
    if (cached !== undefined)
        return cached;

    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const users = Array.isArray(parsed.users) ? parsed.users : [];

        const map = new Map();
        for (const entry of users) {
            let name;
            let hostAddress = null;

            if (entry && typeof entry === 'object') {
                name = String(entry.name || '').toLowerCase();
                if (!name) {
                    console.warn(`[whitelist] skipping a config/allowed-users.json entry with no "name": ${JSON.stringify(entry)}`);
                    continue;
                }

                if (typeof entry.hostAddress === 'string' && entry.hostAddress.trim().length > 0) {
                    const trimmed = entry.hostAddress.trim();
                    if (trimmed.length > HOST_ADDRESS_MAX_CHARS) {
                        console.warn(
                            `[whitelist] hostAddress "${trimmed}" for user "${entry.name}" is longer than `
                            + `${HOST_ADDRESS_MAX_CHARS} chars -- ignoring (battle start as host in a room `
                            + `with other members will be refused for this account until it is shortened)`
                        );
                    } else if (!isDottedIpv4Literal(trimmed)) {
                        console.warn(
                            `[whitelist] hostAddress "${trimmed}" for user "${entry.name}" is not a dotted `
                            + `IPv4 literal (e.g. "192.168.0.42") -- ignoring (battle start as host in a room `
                            + `with other members will be refused for this account until it is fixed)`
                        );
                    } else {
                        hostAddress = trimmed;
                    }
                }
            } else {
                name = String(entry).toLowerCase();
            }
            map.set(name, { hostAddress });
        }
        cached = map;
        console.log(`[whitelist] Loaded ${cached.size} allowed user(s) from config/allowed-users.json`);
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.warn(
                '[whitelist] config/allowed-users.json not found; no allowlist entries or host addresses loaded'
            );
        } else {
            throw err;
        }
        cached = null;
    }
    return cached;
}

function isAllowed(username)
{
    if (!serverConfig.load().whitelistEnabled)
        return true;
    const map = load();
    if (map === null)
        return false;
    return map.has(String(username).toLowerCase());
}

function status()
{
    if (!serverConfig.load().whitelistEnabled)
        return 'off';
    const map = load();
    return map === null ? 'on(0 users)' : `on(${map.size} users)`;
}

function getHostAddress(username)
{
    const map = load();
    if (map === null)
        return null;
    const entry = map.get(String(username).toLowerCase());
    return entry ? entry.hostAddress : null;
}

module.exports = { isAllowed, status, getHostAddress };
