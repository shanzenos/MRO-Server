const crypto = require('crypto');

const keys = new Map();

function issueKey(accountId)
{
    const key = crypto.randomInt(1, 0xFFFFFFFF);
    keys.set(accountId, key);
    return key;
}

function lookup(accountId, key)
{
    return accountId && key && keys.get(accountId) === key ? accountId : null;
}

module.exports = { issueKey, lookup };
