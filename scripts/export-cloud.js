import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from '../lib/state.js';
import { MAX_ENTITY_BYTES } from '../cloud/store.js';

const quote = text => `'${String(text).replaceAll("'", "''")}'`;
export function prepareCloudState(input) {
  const state = migrate(structuredClone(input));
  state.settings.dailyEnabled = false;
  state.agentSettings.enabled = false;
  for (const agent of state.agents) Object.assign(agent, { enabled: false, status: 'paused', nextWakeAt: '', error: '' });
  state.agentDecisions = [];
  state.agentUsage = { date: '', decisions: 0, actions: 0 };
  delete state.workflowLease;
  delete state.loginAttempts;
  for (const job of state.jobs) if (['running', 'queued'].includes(job.status)) Object.assign(job, { status: 'interrupted', message: '本地任务未迁移执行；云端请手动重试', finishedAt: new Date().toISOString() });
  return state;
}
export function exportCloudSQL(input) {
  const state = prepareCloudState(input), rows = [], keys = new Set();
  for (const [collection, value] of Object.entries(state)) {
    rows.push({ key: JSON.stringify([collection]), collection, position: -1, data: JSON.stringify({ array: Array.isArray(value) }) });
    (Array.isArray(value) ? value : [value]).forEach((record, position) => {
      const key = JSON.stringify([collection, Array.isArray(value) ? String(record?.id ?? position) : '$value']);
      if (keys.has(key)) throw new Error(`集合 ${collection} 存在重复记录标识`);
      keys.add(key);
      const data = JSON.stringify(record);
      if (data === undefined || data.includes('\u0000')) throw new Error('数据编码无效');
      if (Buffer.byteLength(data) > MAX_ENTITY_BYTES) throw new Error(`集合 ${collection} 中有记录超过 D1 单条 1.8 MB 导入上限`);
      rows.push({ key, collection, position, data });
    });
  }
  const token = crypto.randomUUID();
  const sql = [
    '-- 仅供首次部署前导入空 D1 数据库。已有初始化状态将拒绝导入。',
    '-- 包含个人知识，请勿提交到 Git 或公开分享。失败后请使用全新空库重试。',
    'CREATE TABLE IF NOT EXISTS app_meta (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, write_token TEXT NOT NULL);',
    'CREATE TABLE IF NOT EXISTS app_entities (key TEXT PRIMARY KEY, collection TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL);',
    'CREATE TABLE pis_import_guard (ok INTEGER NOT NULL CHECK(ok = 1));',
    'INSERT INTO pis_import_guard SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM app_meta) AND NOT EXISTS (SELECT 1 FROM app_entities) THEN 1 ELSE 0 END;',
    'CREATE TABLE pis_import_stage (key TEXT PRIMARY KEY, collection TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL);',
  ];
  for (const row of rows) {
    // Small literals keep every statement well below D1's 100 KB SQL limit,
    // even for multibyte text or apostrophes. A whole JSON entity stays <=1.8 MB.
    const parts = [];
    let current = '';
    for (const point of row.data) { current += point; if (current.length >= 10000) { parts.push(current); current = ''; } }
    if (current || !parts.length) parts.push(current);
    sql.push(`INSERT INTO pis_import_stage (key,collection,position,data) VALUES (${quote(row.key)},${quote(row.collection)},${row.position},${quote(parts[0])});`);
    for (const part of parts.slice(1)) sql.push(`UPDATE pis_import_stage SET data = data || ${quote(part)} WHERE key = ${quote(row.key)};`);
  }
  sql.push(
    `INSERT INTO app_meta (id,revision,write_token) SELECT 1,0,${quote(token)} WHERE EXISTS (SELECT 1 FROM pis_import_guard WHERE ok=1);`,
    `INSERT INTO app_entities (key,collection,position,data) SELECT key,collection,position,data FROM pis_import_stage WHERE EXISTS (SELECT 1 FROM app_meta WHERE id=1 AND write_token=${quote(token)}) AND EXISTS (SELECT 1 FROM pis_import_guard WHERE ok=1);`,
    'DROP TABLE pis_import_stage;',
    'DROP TABLE pis_import_guard;',
  );
  if (sql.some(statement => Buffer.byteLength(statement) >= 100000)) throw new Error('导出语句超过 D1 SQL 长度限制；未生成导出文件');
  return { sql: sql.join('\n') + '\n', entities: rows.length };
}
async function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dir = process.env.DATA_DIR || path.join(root, '.data');
  const input = path.join(dir, 'knowledge.json'), output = path.join(dir, 'cloud-import.sql');
  const { sql, entities } = exportCloudSQL(JSON.parse(await fs.readFile(input, 'utf8')));
  await fs.writeFile(output, sql, { mode: 0o600, flag: 'wx' });
  console.log(`已生成 ${entities} 条实体的首次云端导入文件：${output}`);
  console.log('只可导入尚未初始化的空 D1 数据库；未执行任何远端迁移。');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(`导出失败：${error.code === 'EEXIST' ? 'cloud-import.sql 已存在，请先自行备份或移走旧文件' : error.message}`); process.exitCode = 1; });
