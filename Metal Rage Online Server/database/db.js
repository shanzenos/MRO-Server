const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
const { getShareType } = require('./item-share-type');
const serverConfig = require('../config/server');

// Load DB config from config.json (editable per-machine)
let dbConfig = { host: '127.0.0.1', port: 3306, user: 'root', password: '', database: 'mro' };
try {
    const loaded = require('./config.json');
    dbConfig = { ...dbConfig, ...loaded };
} catch (e) {
    console.log('[DB] No config.json found, using defaults (root@localhost, no password, database: mro)');
}

console.log(`[DB] Connecting to ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);

const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,

    timezone: 'Z',
});

let shopCatalogInitialization;

async function ensureShopCatalog()
{
    if (!shopCatalogInitialization) {
        shopCatalogInitialization = (async () => {
            const sql = fs.readFileSync(path.join(__dirname, 'shop-catalog.sql'), 'utf8');
            const statements = sql.split(';').map(statement => statement.trim()).filter(Boolean);
            for (const statement of statements.slice(0, 2)) await pool.query(statement);
            const [beforeCatalog] = await pool.query('SELECT item_id FROM catalog');
            const [beforeNames] = await pool.query('SELECT item_id FROM item_catalog');
            for (const statement of statements.slice(2)) await pool.query(statement);
            const catalogIds = new Set(beforeCatalog.map(row => Number(row.item_id)));
            const nameIds = new Set(beforeNames.map(row => Number(row.item_id)));
            const [catalog] = await pool.query('SELECT c.item_id, c.category_type, c.mech_type, c.price, ic.code, ic.name, ic.category FROM catalog c LEFT JOIN item_catalog ic ON ic.item_id = c.item_id ORDER BY c.item_id');
            const added = catalog.filter(row => !catalogIds.has(Number(row.item_id)) || (row.code && !nameIds.has(Number(row.item_id))));
            if (added.length) {
                const logDir = path.join(__dirname, '..', 'logs');
                fs.mkdirSync(logDir, { recursive: true });
                const lines = [`[${new Date().toISOString()}] Added ${added.length} shop catalog entries`];
                for (const item of added) {
                    lines.push(`item_id=${item.item_id} category_type=${item.category_type} mech_type=${item.mech_type} price=${item.price} code=${item.code || ''} name=${item.name || ''} category=${item.category || ''}`);
                }
                fs.appendFileSync(path.join(logDir, 'shop-catalog.txt'), `${lines.join('\n')}\n`, 'utf8');
            }
            console.log(`[DB] Shop catalog ready: ${catalog.length} entries, added ${added.length}`);
        })().catch(err => {
            shopCatalogInitialization = null;
            throw err;
        });
    }
    return shopCatalogInitialization;
}

async function verifyConnection()
{
    let conn;
    try {
        conn = await pool.getConnection();
        await conn.query('SELECT point, cash, coupon FROM accounts LIMIT 0');
        await conn.query('SELECT account_id, item_id, mech_slot, part_slot FROM item_equips LIMIT 0');
    } catch (err) {
        console.error(`[DB] FATAL: cannot connect to MySQL at ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
        console.error(`[DB] mysql2 error: ${err && err.code || err && err.message || err}`);
        throw err;
    } finally {
        if (conn) conn.release();
    }
}

async function getAccountByUsername(username)
{
    const [rows] = await pool.execute(
        'SELECT * FROM accounts WHERE username = ?', [username]
    );
    return rows.length > 0 ? rows[0] : null;
}

async function getAccountByNickname(nickname)
{
    const [rows] = await pool.execute(
        'SELECT * FROM accounts WHERE nickname = ?', [nickname]
    );
    return rows.length > 0 ? rows[0] : null;
}

async function getAccountById(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM accounts WHERE id = ?', [accountId]
    );
    return rows.length > 0 ? rows[0] : null;
}

async function getRecord(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM records WHERE account_id = ?', [accountId]
    );
    return rows.length > 0 ? rows[0] : null;
}

async function getMechLevels(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM mech_levels WHERE account_id = ? ORDER BY mech_type', [accountId]
    );
    return rows;
}

async function getMechLicenses(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM mech_licenses WHERE account_id = ? ORDER BY slot', [accountId]
    );
    return rows;
}

async function getMaps(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM maps WHERE account_id = ? ORDER BY map_id', [accountId]
    );
    return rows;
}

async function getTutorials(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM tutorials WHERE account_id = ? ORDER BY tutorial_id', [accountId]
    );
    return rows;
}

async function getItems(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM items WHERE account_id = ? ORDER BY id', [accountId]
    );
    return rows;
}

async function getItemEquips(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM item_equips WHERE account_id = ? ORDER BY id', [accountId]
    );
    return rows;
}

async function getItemsWithEquipViews(accountId)
{
    const items = await getItems(accountId);

    const equips = await getItemEquips(accountId);
    const byId = new Map(items.map(item => [Number(item.id), item]));
    const views = items.map(item => ({ ...item, equipped: 0 }));
    for (const equip of equips) {
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
}

async function saveEquippedLoadout(accountId, mechType, serials)
{
    if (!Number.isInteger(Number(accountId)) || Number(accountId) <= 0) {
        throw new Error('invalid account id');
    }
    if (!Number.isInteger(Number(mechType)) || Number(mechType) < 1 || Number(mechType) > 8) {
        throw new Error(`invalid mech slot: ${mechType}`);
    }
    if (!Array.isArray(serials) || serials.length !== 6 || serials.some(serial =>
        !Number.isInteger(Number(serial)) || Number(serial) < 0 || Number(serial) > 0xFFFFFFFF
    )) {
        throw new Error('invalid equipped serial list');
    }

    const selectedSerials = serials.filter(serial => Number(serial) !== 0).map(Number);
    const uniqueSerials = [...new Set(selectedSerials)];
    if (uniqueSerials.length !== selectedSerials.length) {
        throw new Error('duplicate equipped serial');
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        await conn.execute('SELECT id FROM accounts WHERE id = ? FOR UPDATE', [accountId]);
        const itemIdBySerial = new Map();
        if (uniqueSerials.length > 0) {
            const placeholders = uniqueSerials.map(() => '?').join(', ');
            const [rows] = await conn.execute(
                `SELECT id, item_id FROM items WHERE account_id = ? AND id IN (${placeholders})`,
                [accountId, ...uniqueSerials]
            );
            const found = new Set(rows.map(row => Number(row.id)));
            if (uniqueSerials.some(serial => !found.has(serial))) {
                throw new Error('equipped serial is not owned by account');
            }
            for (const row of rows) itemIdBySerial.set(Number(row.id), Number(row.item_id));
        }

        {
            await conn.execute(
                'DELETE FROM item_equips WHERE account_id = ? AND mech_slot = ?',
                [accountId, mechType]
            );
            for (let partSlot = 0; partSlot < serials.length; partSlot++) {
                const serial = Number(serials[partSlot]);
                if (serial === 0) continue;
                const itemId = itemIdBySerial.get(serial);
                if (getShareType(itemId) === 0) {
                    await conn.execute(
                        'DELETE FROM item_equips WHERE account_id = ? AND item_id = ?',
                        [accountId, serial]
                    );
                }
                await conn.execute(
                    'INSERT INTO item_equips (account_id, item_id, mech_slot, part_slot) VALUES (?, ?, ?, ?)',
                    [accountId, serial, mechType, partSlot]
                );
            }
        }

        await conn.commit();
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function createAccount(username, nickname, pilot)
{
    const settings = serverConfig.getAccountSettings();
    const startingCredits = settings.grantAllItemsAndMaxCredits ? 2147483647 : settings.startingCredits;
    if (settings.grantAllItemsAndMaxCredits) await ensureShopCatalog();
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [result] = await conn.execute(
            'INSERT INTO accounts (username, nickname, pilot, point) VALUES (?, ?, ?, ?)',
            [username, nickname, pilot, startingCredits]
        );
        const accountId = result.insertId;

        // Initialize player record
        await conn.execute(
            'INSERT INTO records (account_id) VALUES (?)', [accountId]
        );

        // Initialize all 8 mech levels
        for (let i = 1; i <= 8; i++) {
            await conn.execute(
                'INSERT INTO mech_levels (account_id, mech_type) VALUES (?, ?)',
                [accountId, i]
            );
        }

        // Give all 8 mech licenses (license_type=0 = permanent/purchased)
        for (let i = 0; i < 8; i++) {
            await conn.execute(
                'INSERT INTO mech_licenses (account_id, slot, mech_type, license_type) VALUES (?, ?, ?, 1)',
                [accountId, i, i + 1]
            );
        }

        // Unlock all 6 maps
        for (let i = 0; i < 6; i++) {
            await conn.execute(
                'INSERT INTO maps (account_id, map_id) VALUES (?, ?)',
                [accountId, i]
            );
        }

        // Initialize 4 tutorials (not completed)
        for (let i = 1; i <= 4; i++) {
            await conn.execute(
                'INSERT INTO tutorials (account_id, tutorial_id) VALUES (?, ?)',
                [accountId, i]
            );
        }

        // Give starter equipment for all 8 mechs using REAL item IDs
        // extracted from Cache.Bin. ID format: XXYYZZ01
        //   2XXXXXXX = Main Weapons, 3XXXXXXX = Assist Weapons,
        //   4XXXXXXX = Boosters/Support
        // Part slots: 0=Body, 1=Primary, 2=Sub-left, 3=Sub-right, 4=Booster, 5=Equipment
        // Mech types: 1=Light(SA), 2=Assault(AA), 3=Medium(HA), 4=Sniper(NB),
        //   5=Firepower(TB), 6=Engineer(BB), 7=Maintenance(EA), 8=Observation(OA)

        // [mech_type, part_slot, item_id]

        const starterLoadouts = [

            [1, 0, 11100101],
            [1, 1, 22100101],
            [1, 2, 32100101],
            [1, 4, 41100101],

            [2, 0, 12100101],
            [2, 1, 26300101],
            [2, 2, 32100101],
            [2, 4, 41100101],

            [3, 0, 13100101],
            [3, 1, 21200101],
            [3, 2, 32100101],
            [3, 4, 41100101],

            [4, 0, 14200101],
            [4, 1, 24100201],
            [4, 2, 32100101],

            [5, 0, 15200101],
            [5, 1, 22200201],
            [5, 2, 32100101],

            [6, 0, 16200101],
            [6, 1, 25300101],
            [6, 2, 38500101],
            [6, 4, 43100101],

            [7, 0, 17100101],
            [7, 1, 28100101],
            [7, 2, 31100101],
            [7, 4, 42100101],

            [8, 0, 18100101],
            [8, 1, 28300101],
            [8, 2, 39100101],
            [8, 4, 41100101],
        ];

        {
            for (const [mechType, partSlot, itemId] of starterLoadouts) {
                const [result] = await conn.execute(
                    'INSERT INTO items (account_id, item_id, slot, mech_type, part_slot, quantity, equipped) VALUES (?, ?, ?, ?, ?, 1, 1)',
                    [accountId, itemId, partSlot, mechType, partSlot]
                );

                {
                    await conn.execute(
                        'INSERT INTO item_equips (account_id, item_id, mech_slot, part_slot) VALUES (?, ?, ?, ?)',
                        [accountId, result.insertId, mechType, partSlot]
                    );
                }
            }
        }

        if (settings.grantAllItemsAndMaxCredits) {
            const starterItemIds = new Set(starterLoadouts.map(([, , itemId]) => itemId));
            const [catalogItems] = await conn.query('SELECT item_id FROM catalog ORDER BY item_id');
            const itemRows = catalogItems
                .map(item => Number(item.item_id))
                .filter(itemId => itemId > 0 && !starterItemIds.has(itemId));
            for (let offset = 0; offset < itemRows.length; offset += 250) {
                const chunk = itemRows.slice(offset, offset + 250);
                const values = chunk.map(() => '(?, ?, 0, 0, 0, 1, 0)').join(', ');
                const params = [];
                for (const itemId of chunk) params.push(accountId, itemId);
                await conn.execute(
                    `INSERT INTO items (account_id, item_id, slot, mech_type, part_slot, quantity, equipped) VALUES ${values}`,
                    params
                );
            }
        }

        await conn.commit();
        return accountId;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function completeTutorial(accountId, tutorialId)
{
    await pool.execute(
        'UPDATE tutorials SET completed = 1, completed_at = NOW() WHERE account_id = ? AND tutorial_id = ?',
        [accountId, tutorialId]
    );
}

async function updateLastLogin(accountId)
{
    await pool.execute(
        'UPDATE accounts SET last_login = NOW() WHERE id = ?', [accountId]
    );
}

async function getItemCatalog()
{
    await ensureShopCatalog();
    const [rows] = await pool.execute(
        `SELECT
            c.item_id,
            c.category_type,
            c.mech_type,
            COALESCE(NULLIF(ic.price, 0), NULLIF(c.price, 0), 1000) AS price,
            COALESCE(NULLIF(ic.discount_price, 0), NULLIF(ic.price, 0), NULLIF(c.price, 0), 1000) AS discount_price,
            COALESCE(ic.is_show, 1) AS is_show,
            COALESCE(ic.is_new, 0) AS is_new,
            COALESCE(ic.is_hot, 0) AS is_hot,
            COALESCE(ic.category, '') AS category
         FROM catalog c
         LEFT JOIN item_catalog ic ON ic.item_id = c.item_id
         ORDER BY c.item_id`
    );
    return rows;
}

module.exports = { pool, verifyConnection, getAccountByUsername, getAccountByNickname, getAccountById, getRecord, getMechLevels, getMechLicenses, getMaps, getTutorials, getItems, getItemEquips, getItemsWithEquipViews, getItemCatalog, ensureShopCatalog, createAccount, saveEquippedLoadout, completeTutorial, updateLastLogin };
