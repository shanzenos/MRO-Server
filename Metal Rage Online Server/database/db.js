const mysql = require('mysql2/promise');
const path = require('path');

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
});

/**
 * Find an account by username. Returns null if not found.
 * @param {string} username
 * @returns {Promise<object|null>}
 */
async function getAccountByUsername(username)
{
    const [rows] = await pool.execute(
        'SELECT * FROM accounts WHERE username = ?', [username]
    );
    return rows.length > 0 ? rows[0] : null;
}

/**
 * Find an account by nickname. Returns null if not found.
 * @param {string} nickname
 * @returns {Promise<object|null>}
 */
async function getAccountByNickname(nickname)
{
    const [rows] = await pool.execute(
        'SELECT * FROM accounts WHERE nickname = ?', [nickname]
    );
    return rows.length > 0 ? rows[0] : null;
}

/**
 * Get player record (level, W/L/K/D stats).
 * @param {number} accountId
 * @returns {Promise<object|null>}
 */
async function getRecord(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM records WHERE account_id = ?', [accountId]
    );
    return rows.length > 0 ? rows[0] : null;
}

/**
 * Get all mech levels for an account.
 * @param {number} accountId
 * @returns {Promise<object[]>}
 */
async function getMechLevels(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM mech_levels WHERE account_id = ? ORDER BY mech_type', [accountId]
    );
    return rows;
}

/**
 * Get all mech licenses for an account.
 * @param {number} accountId
 * @returns {Promise<object[]>}
 */
async function getMechLicenses(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM mech_licenses WHERE account_id = ? ORDER BY slot', [accountId]
    );
    return rows;
}

/**
 * Get unlocked maps for an account.
 * @param {number} accountId
 * @returns {Promise<object[]>}
 */
async function getMaps(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM maps WHERE account_id = ? ORDER BY map_id', [accountId]
    );
    return rows;
}

/**
 * Get tutorials for an account.
 * @param {number} accountId
 * @returns {Promise<object[]>}
 */
async function getTutorials(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM tutorials WHERE account_id = ? ORDER BY tutorial_id', [accountId]
    );
    return rows;
}

/**
 * Get items for an account.
 * @param {number} accountId
 * @returns {Promise<object[]>}
 */
async function getItems(accountId)
{
    const [rows] = await pool.execute(
        'SELECT * FROM items WHERE account_id = ? ORDER BY id', [accountId]
    );
    return rows;
}

/**
 * Create a new player account with all default data.
 * @param {string} username
 * @param {string} nickname
 * @param {number} pilot - 101 or 102
 * @returns {Promise<number>} - The new account ID
 */
async function createAccount(username, nickname, pilot)
{
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        const [result] = await conn.execute(
            'INSERT INTO accounts (username, nickname, pilot) VALUES (?, ?, ?)',
            [username, nickname, pilot]
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

        // Give all 8 mech licenses (purchased)
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
        //
        // Part slots: 0=Body, 1=Primary, 2=Sub-left, 3=Sub-right, 4=Booster, 5=Equipment
        //
        // Mech types: 1=Light(SA), 2=Assault(AA), 3=Medium(HA), 4=Sniper(NB),
        //   5=Firepower(TB), 6=Engineer(BB), 7=Maintenance(EA), 8=Observation(OA)
        const starterLoadouts = [
            // [mech_type, part_slot, item_id]
            // Mech 1 - Light
            [1, 1, 21100101],  // MOC_a Smoothbore gun
            [1, 2, 31100101],  // AOC_a Auxiliary single gun
            [1, 4, 41100101],  // BPE_a Plasma thrusters
            // Mech 2 - Assault
            [2, 1, 22100101],  // MOM_a Cannon
            [2, 2, 32100101],  // AOM_a Secondary guns
            [2, 4, 41200101],  // BHE_a Hydrogen booster
            // Mech 3 - Medium/Reload
            [3, 1, 21200101],  // MNC_a Multi-column smoothbore
            [3, 2, 33100101],  // AOR_a Watch missile
            [3, 4, 41300101],  // BNE_a Nano-propeller
            // Mech 4 - Sniper
            [4, 1, 24100101],  // MSC_a Sniper rifle
            [4, 2, 31100201],  // AOC_b Auxiliary single gun
            [4, 4, 41100101],  // BPE_a Plasma thrusters
            // Mech 5 - Firepower
            [5, 1, 25100101],  // MLH_a Anti-aircraft fire
            [5, 2, 35100101],  // ACH_a Grenade transmitter
            [5, 4, 41200101],  // BHE_a Hydrogen booster
            // Mech 6 - Engineer
            [6, 1, 28100101],  // MAT_a Fort setting machine
            [6, 2, 43100101],  // ABA_a Construction equipment
            [6, 4, 42100101],  // ADA_a Repair robot
            // Mech 7 - Maintenance
            [7, 1, 26500101],  // MHA_a Close range weapon
            [7, 2, 38500301],  // ATA_a Trap setting machine
            [7, 4, 41300101],  // BNE_a Nano-propeller
            // Mech 8 - Observation
            [8, 1, 28300101],  // MPF_a Remote detection
            [8, 2, 39100101],  // AEF_a EMP
            [8, 4, 41100101],  // BPE_a Plasma thrusters
        ];

        for (const [mechType, partSlot, itemId] of starterLoadouts) {
            await conn.execute(
                'INSERT INTO items (account_id, item_id, slot, mech_type, part_slot, quantity, equipped) VALUES (?, ?, ?, ?, ?, 1, 1)',
                [accountId, itemId, partSlot, mechType, partSlot]
            );
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

/**
 * Mark a tutorial as completed.
 * @param {number} accountId
 * @param {number} tutorialId
 */
async function completeTutorial(accountId, tutorialId)
{
    await pool.execute(
        'UPDATE tutorials SET completed = 1, completed_at = NOW() WHERE account_id = ? AND tutorial_id = ?',
        [accountId, tutorialId]
    );
}

/**
 * Update last_login timestamp.
 * @param {number} accountId
 */
async function updateLastLogin(accountId)
{
    await pool.execute(
        'UPDATE accounts SET last_login = NOW() WHERE id = ?', [accountId]
    );
}

module.exports = {
    pool,
    getAccountByUsername,
    getAccountByNickname,
    getRecord,
    getMechLevels,
    getMechLicenses,
    getMaps,
    getTutorials,
    getItems,
    createAccount,
    completeTutorial,
    updateLastLogin,
};
