const fs = require('fs');
const path = require('path');

async function migrate(pool)
{
    const conn = await pool.getConnection();
    let locked = false;
    try {
        const [[lock]] = await conn.query("SELECT GET_LOCK(CONCAT(DATABASE(), ':equipment-upgrade'), 0) AS acquired");
        if (Number(lock.acquired) !== 1) throw new Error('Another database upgrade is running');
        locked = true;
        const schema = fs.readFileSync(path.join(__dirname, '..', 'metalrageserver.sql'), 'utf8');
        const [columns] = await conn.query("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'accounts'");
        for (const [name, value] of [['point', 100000], ['cash', 0], ['coupon', 0]]) {
            if (!columns.some(column => column.name === name)) {
                await conn.query(`ALTER TABLE accounts ADD COLUMN ${name} INT UNSIGNED NOT NULL DEFAULT ${value}`);
            }
        }
        await conn.query(schema.match(/CREATE TABLE IF NOT EXISTS item_equips \([\s\S]*?;/)[0]);
        await conn.query('CREATE TABLE IF NOT EXISTS schema_migrations (id VARCHAR(64) PRIMARY KEY) ENGINE=InnoDB');
        const [completed] = await conn.execute('SELECT id FROM schema_migrations WHERE id = ?', ['equipment-v1']);
        if (completed.length === 0) {
            await conn.beginTransaction();
            try {
                const [invalid] = await conn.query('SELECT id FROM items WHERE equipped = 1 AND (mech_type NOT BETWEEN 1 AND 8 OR part_slot NOT BETWEEN 0 AND 5) LIMIT 1');
                if (invalid.length) throw new Error('Invalid equipped slot in items; correct it before upgrading');
                const [duplicates] = await conn.query('SELECT account_id, mech_type, part_slot FROM items WHERE equipped = 1 GROUP BY account_id, mech_type, part_slot HAVING COUNT(*) > 1 LIMIT 1');
                if (duplicates.length) throw new Error('Multiple equipped items in one slot; correct them before upgrading');
                const [[maximum]] = await conn.query('SELECT COALESCE(MAX(id), 0) AS id FROM items FOR UPDATE');
                let nextId = Math.max(100000, Number(maximum.id));
                const [reserved] = await conn.query('SELECT id FROM items WHERE id < 100001 ORDER BY id FOR UPDATE');
                if (nextId + reserved.length >= 0xFFFFFFFF) throw new Error('Item serial range exhausted');
                for (const item of reserved) {
                    await conn.execute('UPDATE items SET id = ? WHERE id = ?', [++nextId, item.id]);
                }
                await conn.query(`INSERT INTO item_equips (account_id, item_id, mech_slot, part_slot)
                    SELECT i.account_id, i.id, i.mech_type, i.part_slot FROM items i
                    WHERE i.equipped = 1 AND NOT EXISTS (
                        SELECT 1 FROM item_equips e WHERE e.account_id = i.account_id
                        AND e.mech_slot = i.mech_type AND e.part_slot = i.part_slot
                    )`);
                await conn.execute('INSERT INTO schema_migrations (id) VALUES (?)', ['equipment-v1']);
                await conn.commit();
            } catch (err) {
                await conn.rollback();
                throw err;
            }
        }
        const [[maximum]] = await conn.query('SELECT COALESCE(MAX(id), 0) AS id FROM items');
        await conn.query(`ALTER TABLE items AUTO_INCREMENT = ${Math.max(100001, Number(maximum.id) + 1)}`);
        const procedure = schema.match(/CREATE PROCEDURE create_new_player[\s\S]*?END \/\//)[0].replace(/ \/\/$/, '');
        await conn.query('DROP PROCEDURE IF EXISTS create_new_player');
        await conn.query(procedure);
    } finally {
        try {
            if (locked) await conn.query("SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':equipment-upgrade'))");
        } finally {
            conn.release();
        }
    }
}

if (require.main === module) {
    const { pool } = require('./db');
    migrate(pool).then(() => console.log('[DB] Upgrade complete')).catch(err => {
        console.error('[DB] Upgrade failed:', err.message);
        process.exitCode = 1;
    }).finally(() => pool.end());
}

module.exports = { migrate };
