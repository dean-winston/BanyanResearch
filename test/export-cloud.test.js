import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { exportCloudSQL } from '../scripts/export-cloud.js';

test('cloud export roundtrips large Unicode/SQL literals and pauses runtime state', () => {
  const content = "中文🙂'; DROP TABLE app_entities; --\n".repeat(9000);
  const { sql } = exportCloudSQL({ blogs: [{ id: 'own', content }], settings: { dailyEnabled: true }, agentSettings: { enabled: true }, jobs: [{ id: 'j', status: 'running' }], workflowLease: { active: true }, loginAttempts: { secret: true }, agentDecisions: [{ id: 'd' }] });
  assert.ok(sql.split('\n').every(line => Buffer.byteLength(line) < 100000));
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(sql);
    const get = (collection, id) => JSON.parse(db.prepare('SELECT data FROM app_entities WHERE key=?').get(JSON.stringify([collection, id])).data);
    assert.equal(get('blogs', 'own').content, content);
    assert.equal(get('settings', '$value').dailyEnabled, false);
    assert.equal(get('agentSettings', '$value').enabled, false);
    assert.equal(get('jobs', 'j').status, 'interrupted');
    assert.equal(get('agents', 'engineering').enabled, false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM app_entities WHERE collection IN ('loginAttempts','workflowLease')").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM app_entities WHERE collection='agentDecisions' AND position>=0").get().n, 0);
    assert.throws(() => db.exec(sql), /CHECK/);
    assert.equal(get('blogs', 'own').content, content);
  } finally { db.close(); }
});

test('existing initialized database is rejected before changing personal data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE TABLE app_meta(id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, write_token TEXT NOT NULL); INSERT INTO app_meta VALUES(1,7,'original'); CREATE TABLE app_entities(key TEXT PRIMARY KEY,collection TEXT NOT NULL,position INTEGER NOT NULL,data TEXT NOT NULL); INSERT INTO app_entities VALUES('original','items',0,'{}');");
    assert.throws(() => db.exec(exportCloudSQL({}).sql), /CHECK/);
    assert.equal(db.prepare('SELECT revision FROM app_meta').get().revision, 7);
    assert.equal(db.prepare('SELECT key FROM app_entities').get().key, 'original');
  } finally { db.close(); }
});

test('export rejects oversized entities and duplicate record IDs', () => {
  assert.throws(() => exportCloudSQL({ blogs: [{ id: 'big', content: 'x'.repeat(1800000) }] }), /1.8 MB/);
  assert.throws(() => exportCloudSQL({ blogs: [{ id: 'same' }, { id: 'same' }] }), /重复/);
});
