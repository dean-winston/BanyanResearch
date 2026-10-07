import { migrate } from '../lib/state.js';

// D1 limits a row/string to 2,000,000 bytes. History spans entity rows; only an
// individual oversized record is rejected, never silently truncated.
export const MAX_ENTITY_BYTES = 1_800_000;
const byteLength = text => new TextEncoder().encode(text).byteLength;
const guard = 'EXISTS (SELECT 1 FROM app_meta WHERE id = 1 AND write_token = ?)';
function entities(state) {
  const result = new Map();
  for (const [collection, value] of Object.entries(state)) {
    const records = Array.isArray(value) ? value : [value];
    const marker = JSON.stringify({ array: Array.isArray(value) });
    result.set(JSON.stringify([collection]), { key: JSON.stringify([collection]), collection, position: -1, data: marker });
    records.forEach((record, position) => {
      const id = Array.isArray(value) ? String(record?.id ?? position) : '$value';
      const key = JSON.stringify([collection,id]);
      if (result.has(key)) throw new Error(`集合 ${collection} 包含重复记录标识`);
      const data = JSON.stringify(record);
      if (data === undefined) throw new Error(`集合 ${collection} 包含无效数据`);
      if (byteLength(data) > MAX_ENTITY_BYTES) throw Object.assign(new Error(`单条 ${collection} 记录超过 1.8 MB，现有数据没有被覆盖。`), { status: 507, code: 'ENTITY_CAPACITY' });
      result.set(key,{key,collection,position,data});
    });
  }
  return result;
}
function assemble(rows) {
  const state = {};
  for (const row of rows) if (row.position === -1) state[row.collection] = JSON.parse(row.data).array ? [] : undefined;
  for (const row of rows.filter(row => row.position >= 0).sort((a,b) => a.position-b.position)) {
    const value = JSON.parse(row.data);
    if (Array.isArray(state[row.collection])) state[row.collection].push(value);
    else state[row.collection] = value;
  }
  return migrate(state);
}
// Bulk SQL avoids a query per entity, especially when array ordering changes.
function chunks(records) {
  const result = []; let batch = [], size = 2;
  for (const record of records) {
    const added = byteLength(JSON.stringify(record)) + 1;
    if (batch.length && size + added > 850_000) { result.push(batch); batch=[]; size=2; }
    batch.push(record); size += added;
    if (size > 850_000) { result.push(batch); batch=[]; size=2; }
  }
  if (batch.length) result.push(batch);
  return result;
}
export function createCloudStore(env) {
  if (!env?.DB?.prepare || !env.DB.batch) throw new Error('缺少 D1 数据库绑定 DB');
  const database = () => env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
  let initialization;
  async function snapshotRaw() {
    const output = await database().prepare('SELECT m.revision, e.key, e.collection, e.position, e.data FROM app_meta m LEFT JOIN app_entities e ON 1 = 1 WHERE m.id = 1').all();
    const rows = output.results || [];
    const revision = rows[0]?.revision;
    if (!Number.isSafeInteger(revision)) throw new Error('云端状态记录无效');
    const entityRows = rows.filter(row => row.key != null);
    return { revision, rows: new Map(entityRows.map(row => [row.key,row])), state: assemble(entityRows) };
  }
  function statements(db, before, after, token) {
    const changed=[],reordered=[],removed=[];
    for (const [key,row] of after) {
      const old=before.get(key);
      if (!old || old.data !== row.data || old.collection !== row.collection) changed.push(row);
      else if (old.position !== row.position) reordered.push({key,position:row.position});
    }
    for (const key of before.keys()) if (!after.has(key)) removed.push(key);
    const result=[];
    for (const batch of chunks(changed)) {
      if (batch.length===1 && byteLength(JSON.stringify(batch))>850_000) {
        const row=batch[0];
        result.push(db.prepare(`INSERT INTO app_entities (key, collection, position, data) SELECT ?, ?, ?, ? WHERE ${guard} ON CONFLICT(key) DO UPDATE SET collection=excluded.collection, position=excluded.position, data=excluded.data`).bind(row.key,row.collection,row.position,row.data,token));
      } else result.push(db.prepare(`INSERT INTO app_entities (key, collection, position, data) SELECT json_extract(value,'$.key'), json_extract(value,'$.collection'), json_extract(value,'$.position'), json_extract(value,'$.data') FROM json_each(?) WHERE ${guard} ON CONFLICT(key) DO UPDATE SET collection=excluded.collection, position=excluded.position, data=excluded.data`).bind(JSON.stringify(batch),token));
    }
    for (const batch of chunks(reordered)) result.push(db.prepare(`UPDATE app_entities SET position = (SELECT json_extract(value,'$.position') FROM json_each(?) WHERE json_extract(value,'$.key') = app_entities.key) WHERE key IN (SELECT json_extract(value,'$.key') FROM json_each(?)) AND ${guard}`).bind(JSON.stringify(batch),JSON.stringify(batch),token));
    for (const batch of chunks(removed)) result.push(db.prepare(`DELETE FROM app_entities WHERE key IN (SELECT value FROM json_each(?)) AND ${guard}`).bind(JSON.stringify(batch),token));
    return result;
  }
  async function commit(change) {
    // Conflict retries rerun change: callbacks may mutate state, not call tools.
    for (let attempt=0;attempt<=3;attempt++) {
      const before=await snapshotRaw();
      const result=await change(before.state);
      const after=entities(before.state),token=crypto.randomUUID(),db=database();
      const mutations=statements(db,before.rows,after,token);
      if (mutations.length>39) throw Object.assign(new Error('本次状态变更过大，请分批导入；现有数据没有被覆盖。'),{status:413,code:'STATE_BATCH_CAPACITY'});
      // D1 batch is transactional. Failed CAS keeps the token unchanged, making
      // all following writes no-ops; other batches cannot interleave these steps.
      const writes=await db.batch([db.prepare('UPDATE app_meta SET revision = revision + 1, write_token = ? WHERE id = 1 AND revision = ?').bind(token,before.revision),...mutations]);
      if (writes.some(write=>write.success===false)) throw new Error('云端状态写入失败');
      if (writes[0]?.meta?.changes===1) return result;
    }
    throw Object.assign(new Error('其他任务正在更新数据，请稍后重试；此次修改没有覆盖其他任务。'),{status:409,code:'STATE_CONFLICT'});
  }
  function initializeStore() {
    if (!initialization) initialization=(async()=>{
      const db=database();
      await db.batch([
        db.prepare('CREATE TABLE IF NOT EXISTS app_meta (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, write_token TEXT NOT NULL)'),
        db.prepare('CREATE TABLE IF NOT EXISTS app_entities (key TEXT PRIMARY KEY, collection TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL)'),
        db.prepare("INSERT OR IGNORE INTO app_meta (id, revision, write_token) VALUES (1, 0, '')"),
      ]);
      const initial=await snapshotRaw();
      if (!initial.rows.size) await commit(()=>{});
      // Durable workflows own recovery; initialization never interrupts jobs.
    })().catch(error=>{initialization=undefined;throw error;});
    return initialization;
  }
  async function readStore() { await initializeStore(); return (await snapshotRaw()).state; }
  async function updateStore(change) { if(typeof change!=='function')throw new TypeError('状态更新必须提供函数');await initializeStore();return commit(change); }
  return {readStore,updateStore,initializeStore};
}
