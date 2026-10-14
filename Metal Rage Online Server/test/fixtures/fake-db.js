const fs = require('fs');
const path = require('path');

let cachedCatalog = null;

function nullIfZero(value)
{
    const n = Number(value);
    return n === 0 ? null : n;
}

function loadCatalogFromSql()
{
    if (cachedCatalog) return cachedCatalog;

    const sqlPath = path.join(__dirname, '..', '..', 'metalrageserver.sql');
    const text = fs.readFileSync(sqlPath, 'utf-8');

    function extractBlock(insertPrefix)
    {
        const start = text.indexOf(insertPrefix);
        if (start === -1) throw new Error(`fake-db: could not find "${insertPrefix}" in metalrageserver.sql`);
        const end = text.indexOf(';', start);
        return text.slice(start + insertPrefix.length, end);
    }

    const itemCatalogByItemId = new Map();
    const icBlock = extractBlock("INSERT INTO `item_catalog` (`item_id`, `code`, `name`, `category`) VALUES");
    const icRe = /\((\d+),\s*'([^']*)',\s*'([^']*)',\s*'([^']*)'\)/g;
    let m;
    while ((m = icRe.exec(icBlock)) !== null)
    {
        itemCatalogByItemId.set(Number(m[1]), {
            code: m[2], name: m[3], category: m[4],
            price: 1000, discount_price: 1000, is_show: 1, is_new: 0, is_hot: 0,
        });
    }

    const catalogRows = [];
    const cBlock = extractBlock("INSERT INTO `catalog` (`item_id`, `category_type`, `mech_type`, `price`) VALUES");
    const cRe = /\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)/g;
    while ((m = cRe.exec(cBlock)) !== null)
    {
        catalogRows.push({
            item_id: Number(m[1]),
            category_type: Number(m[2]),
            mech_type: Number(m[3]),
            price: Number(m[4]),
        });
    }

    catalogRows.sort((a, b) => a.item_id - b.item_id);
    cachedCatalog = catalogRows.map((c) => {
        const ic = itemCatalogByItemId.get(c.item_id) || {};
        const price = nullIfZero(ic.price) ?? nullIfZero(c.price) ?? 1000;
        const discount_price = nullIfZero(ic.discount_price) ?? nullIfZero(ic.price) ?? nullIfZero(c.price) ?? 1000;
        return {
            item_id: c.item_id,
            category_type: c.category_type,
            mech_type: c.mech_type,
            price,
            discount_price,
            is_show: ic.is_show ?? 1,
            is_new: ic.is_new ?? 0,
            is_hot: ic.is_hot ?? 0,
            category: ic.category ?? '',
        };
    });

    return cachedCatalog;
}

function makeFixtureDb(overrides = {})
{
    const account = Object.assign({
        id: 1,
        username: 'replaybot',
        nickname: 'ReplayBot',
        pilot: 101,
        account_level: 1,
        gender: 1,
        point: 100000,
        cash: 0,
        coupon: 0,
        last_login: null,
    }, overrides.account);

    const record = Object.assign({
        account_id: account.id,
        level: 5,
        exp: 12345,
        exp_max: 20000,
        wins: 3,
        losses: 1,
        draws: 0,
        kills: 10,
        deaths: 4,
    }, overrides.record);

    const mechLevels = overrides.mechLevels || [
        { account_id: account.id, mech_type: 1, level: 3, exp: 500, kills: 5, deaths: 2, sorties: 6 },
    ];

    const licenses = overrides.licenses || [
        { account_id: account.id, slot: 1, mech_type: 1, license_type: 1 },
    ];

    const maps = overrides.maps || [
        { account_id: account.id, map_id: 1 },
        { account_id: account.id, map_id: 2 },
    ];

    const tutorials = overrides.tutorials || [
        { account_id: account.id, tutorial_id: 1, completed: 1, completed_at: null },
    ];

    const items = overrides.items || [
        { id: 100001, account_id: account.id, item_id: 11100101, slot: 0, mech_type: 1, part_slot: 0, quantity: 1, equipped: 1 },
    ];

    let nextItemId = items.reduce((max, item) => Math.max(max, Number(item.id) || 0), 100000) + 1;

    const ITEM_EQUIPS_MODE = overrides.itemEquipsMode || 'disabled';
    const itemEquips = overrides.itemEquips || [];
    let nextItemEquipId = itemEquips.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;

    const shareTypeByItemId = overrides.shareTypeByItemId || {};
    const useTimeByItemId = overrides.useTimeByItemId || {};
    function getShareType(itemId) { return shareTypeByItemId[Number(itemId)] === 1 ? 1 : 0; }
    function getUseTimeSeconds(itemId) {
        const value = Number(useTimeByItemId[Number(itemId)]);
        return Number.isFinite(value) && value > 0 ? value : 0;
    }

    const calls = [];
    const logCall = (name, args) => calls.push({ name, args });

    async function poolExecute(sql, params = [])
    {
        logCall('pool.execute', { sql, params });
        const norm = sql.replace(/\s+/g, ' ').trim();

        if (norm.startsWith('SELECT * FROM accounts ORDER BY last_login DESC LIMIT 1'))
            return [[account]];

        throw new Error(`fake-db: unmocked pool.execute query: ${norm}`);
    }

    return {
        _fixture: { account, record, mechLevels, licenses, maps, tutorials, items, itemEquips },
        _calls: calls,
        ITEM_EQUIPS_MODE,

        pool: {
            execute: poolExecute,

            async getConnection()
            {
                logCall('pool.getConnection', {});
                let released = false;
                return {
                    async beginTransaction() { logCall('conn.beginTransaction', {}); },
                    async commit() { logCall('conn.commit', {}); },
                    async rollback() { logCall('conn.rollback', {}); },
                    release() { released = true; logCall('conn.release', { released }); },
                    async execute(sql, params = [])
                    {
                        logCall('conn.execute', { sql, params });
                        const norm = sql.replace(/\s+/g, ' ').trim();

                        if (norm.startsWith('SELECT point FROM accounts WHERE id = ?'))
                        {
                            const [id] = params;
                            return [Number(id) === account.id ? [{ point: account.point }] : []];
                        }
                        if (norm.startsWith('UPDATE accounts SET point = ? WHERE id = ?'))
                        {
                            const [newPoint, id] = params;
                            if (Number(id) === account.id) account.point = Number(newPoint);
                            return [{ affectedRows: Number(id) === account.id ? 1 : 0 }];
                        }
                        if (norm.startsWith('INSERT INTO items (account_id, item_id, slot, mech_type, part_slot, quantity, equipped) VALUES'))
                        {
                            const [accountId, itemId, slot, mechType, partSlot] = params;
                            const id = nextItemId++;
                            items.push({
                                id, account_id: Number(accountId), item_id: Number(itemId),
                                slot: Number(slot), mech_type: Number(mechType), part_slot: Number(partSlot),
                                quantity: 1, equipped: 0,
                            });
                            return [{ insertId: id, affectedRows: 1 }];
                        }

                        if (norm.startsWith('SELECT id FROM items WHERE account_id = ? AND item_id = ? LIMIT 1'))
                        {
                            const [accountId, itemId] = params;
                            const owned = items.filter(item =>
                                Number(item.account_id) === Number(accountId) && Number(item.item_id) === Number(itemId)
                            );
                            return [owned.length > 0 ? [{ id: owned[0].id }] : []];
                        }

                        throw new Error(`fake-db: unmocked conn.execute query: ${norm}`);
                    },
                };
            },
        },

        async getAccountByUsername(username)
        {
            logCall('getAccountByUsername', { username });

            return account;
        },
        async getAccountByNickname(nickname)
        {
            logCall('getAccountByNickname', { nickname });
            return nickname === account.nickname ? account : null;
        },
        async getAccountById(accountId)
        {

            logCall('getAccountById', { accountId });
            return Number(accountId) === account.id ? account : null;
        },
        async getRecord(accountId)
        {
            logCall('getRecord', { accountId });
            return Number(accountId) === account.id ? record : null;
        },
        async getMechLevels(accountId)
        {
            logCall('getMechLevels', { accountId });
            return Number(accountId) === account.id ? mechLevels : [];
        },
        async getMechLicenses(accountId)
        {
            logCall('getMechLicenses', { accountId });
            return Number(accountId) === account.id ? licenses : [];
        },
        async getMaps(accountId)
        {
            logCall('getMaps', { accountId });
            return Number(accountId) === account.id ? maps : [];
        },
        async getTutorials(accountId)
        {
            logCall('getTutorials', { accountId });
            return Number(accountId) === account.id ? tutorials : [];
        },
        async getItems(accountId)
        {
            logCall('getItems', { accountId });
            return Number(accountId) === account.id ? items : [];
        },

        async getItemEquips(accountId)
        {
            logCall('getItemEquips', { accountId });
            return Number(accountId) === account.id ? itemEquips : [];
        },
        async getItemsWithEquipViews(accountId)
        {
            logCall('getItemsWithEquipViews', { accountId });
            const accountItems = Number(accountId) === account.id ? items : [];
            if (ITEM_EQUIPS_MODE !== 'enabled') {
                return accountItems;
            }
            const accountEquips = Number(accountId) === account.id ? itemEquips : [];
            const byId = new Map(accountItems.map(item => [Number(item.id), item]));
            const views = accountItems.map(item => ({ ...item, equipped: 0 }));
            for (const equip of accountEquips) {
                const base = byId.get(Number(equip.item_id));
                if (!base) continue;
                views.push({
                    ...base,
                    mech_type: Number(equip.mech_slot),
                    part_slot: Number(equip.part_slot),
                    equipped: 1,
                });
            }
            return views;
        },
        async getItemCatalog()
        {
            logCall('getItemCatalog', {});
            return loadCatalogFromSql();
        },
        async createAccount(username, nickname, pilot)
        {
            logCall('createAccount', { username, nickname, pilot });
            throw new Error('fake-db: createAccount not mocked -- golden samples must log in as a pre-existing fixture account, not trigger auto-create');
        },
        async saveEquippedLoadout(accountId, mechType, serials)
        {
            logCall('saveEquippedLoadout', { accountId, mechType, serials });
            throw new Error('fake-db: saveEquippedLoadout not mocked yet (hangar loadout save -- not exercised by the current golden samples)');
        },
        async completeTutorial(accountId, tutorialId)
        {
            logCall('completeTutorial', { accountId, tutorialId });
            const t = tutorials.find(t => t.tutorial_id === tutorialId);
            if (t) t.completed = 1;
        },
        async updateLastLogin(accountId)
        {
            logCall('updateLastLogin', { accountId });
        },
    };
}

module.exports = { makeFixtureDb };
