const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { migrate } = require('../database/migrate');

function fixture({ completed = false, invalid = false, duplicates = false, failUpdate = false } = {}) {
    const state = { columns: new Set(['id', 'point']), ids: [101, 102, 200000], completed, commits: 0, rollbacks: 0, released: 0, calls: [] };
    let before;
    const conn = {
        async beginTransaction() { before = [...state.ids]; },
        async commit() { state.commits++; },
        async rollback() { state.ids = before; state.rollbacks++; },
        release() { state.released++; },
        async query(sql, args = []) {
            state.calls.push([sql, args]);
            if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
            if (sql.includes('information_schema.COLUMNS')) return [[...state.columns].map(name => ({ name }))];
            if (sql.startsWith('ALTER TABLE accounts')) { state.columns.add(sql.split(' ')[5]); return [{}]; }
            if (sql.startsWith('SELECT id FROM schema_migrations')) return [state.completed ? [{ id: 'equipment-v1' }] : []];
            if (sql.startsWith('SELECT id FROM items WHERE equipped')) return [invalid ? [{ id: 101 }] : []];
            if (sql.includes('HAVING COUNT(*)')) return [duplicates ? [{ account_id: 1 }] : []];
            if (sql.startsWith('SELECT COALESCE(MAX')) return [[{ id: Math.max(...state.ids) }]];
            if (sql.startsWith('SELECT id FROM items WHERE id')) return [state.ids.filter(id => id < 100001).map(id => ({ id }))];
            if (sql.startsWith('UPDATE items SET id')) {
                if (failUpdate) throw new Error('foreign key failure');
                assert.ok(!state.ids.includes(args[0]));
                state.ids[state.ids.indexOf(args[1])] = args[0];
            }
            if (sql.startsWith('INSERT INTO schema_migrations')) state.completed = true;
            return [{}];
        },
        execute(sql, args) { return this.query(sql, args); },
    };
    return { state, pool: { getConnection: async () => conn } };
}

test('migration preserves balances, moves reserved serials and is repeatable', async () => {
    const { state, pool } = fixture();
    await migrate(pool);
    assert.deepEqual(state.ids, [200001, 200002, 200000]);
    assert.equal(state.commits, 1);
    assert.equal(state.rollbacks, 0);
    assert.equal(state.completed, true);
    assert.ok(!state.calls.some(([sql]) => sql.startsWith('ALTER TABLE accounts ADD COLUMN point')));
    assert.ok(state.calls.some(([sql]) => sql.includes('CREATE PROCEDURE create_new_player')));
    const updateCount = state.calls.filter(([sql]) => sql.startsWith('UPDATE items SET')).length;
    await migrate(pool);
    assert.equal(state.commits, 1);
    assert.equal(state.calls.filter(([sql]) => sql.startsWith('UPDATE items SET')).length, updateCount);
    assert.equal(state.released, 2);
});

test('migration refuses ambiguous equipment and rolls back failed remapping', async () => {
    for (const options of [{ invalid: true }, { duplicates: true }, { failUpdate: true }]) {
        const { state, pool } = fixture(options);
        await assert.rejects(migrate(pool));
        assert.deepEqual(state.ids, [101, 102, 200000]);
        assert.equal(state.completed, false);
        assert.equal(state.commits, 0);
        assert.equal(state.rollbacks, 1);
        assert.equal(state.released, 1);
        assert.ok(state.calls.at(-1)[0].includes('RELEASE_LOCK'));
    }
});

test('fresh schemas and database account creation give identical starter equipment', () => {
    const root = path.join(__dirname, '..');
    const source = fs.readFileSync(path.join(root, 'database/db.js'), 'utf8');
    const starters = JSON.parse(source.match(/const starterLoadouts = (\[[\s\S]*?\n        \]);/)[1].replace(/,\s*]/g, ']'));
    for (const filename of ['metalrageserver.sql', 'database/schema.sql']) {
        const sql = fs.readFileSync(path.join(root, filename), 'utf8');
        const procedure = sql.slice(sql.indexOf('CREATE PROCEDURE create_new_player'));
        const insert = procedure.match(/INSERT INTO items[^;]+;/)[0];
        const actual = Array.from(insert.matchAll(/\(v_id, (\d+), (\d+), (\d+), (\d+), 1, 1\)/g), match => [Number(match[3]), Number(match[4]), Number(match[1])]);
        assert.deepEqual(actual, starters);
        assert.match(procedure, /START TRANSACTION/);
        assert.match(procedure, /ROLLBACK/);
        assert.match(procedure, /INSERT INTO item_equips/);
        assert.match(sql, /ON UPDATE CASCADE/);
        assert.match(sql, /AUTO_INCREMENT=100001/);
    }
});
