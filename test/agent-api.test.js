import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';

test('local Agent API persists controls, refuses engineering automation and leaves disabled wake inert', async () => {
  const dir = await mkdtemp(os.tmpdir() + '/pis-agent-api-');
  let child, port;
  const start = async () => {
    child = spawn(process.execPath, ['server.js'], { env: { ...process.env, DATA_DIR: dir, PORT: '0', DISABLE_SCHEDULER: '1', CODEX_BIN: '/missing-test-cli', ANALYSIS_PROVIDER: 'codex' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('startup timeout')), 10000);
      child.stdout.on('data', data => { const match = String(data).match(/127\.0\.0\.1:(\d+)/); if (match) { port = Number(match[1]); clearTimeout(timer); resolve(); } });
      child.on('exit', () => { clearTimeout(timer); reject(new Error('unexpected exit')); });
    });
  };
  const stop = async () => { if (!child || child.exitCode !== null) return; const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done; };
  const request = (url, method = 'GET', data) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, agent: false, headers: { 'Content-Type': 'application/json' } }, res => { let raw = ''; res.on('data', chunk => raw += chunk); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(raw) })); });
    req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
  });
  try {
    await start();
    let state = (await request('/api/state')).data;
    assert.equal(state.runtime.deployment, 'local');
    assert.equal(state.agentSettings.enabled, false);
    assert.equal((await request('/api/agents/wake', 'POST', {})).status, 409);
    assert.equal((await request('/api/agents/engineering', 'PATCH', { enabled: true })).status, 400);
    assert.equal((await request('/api/agents/missing', 'PATCH', { enabled: false })).status, 404);
    assert.equal((await request('/api/agents/writing', 'PATCH', { enabled: false, goal: '记录我的研究' })).status, 200);
    assert.equal((await request('/api/agents/research', 'PATCH', { enabled: false })).status, 200);
    const settings = { enabled: true, wakeIntervalHours: 12, maxDecisionsPerDay: 4, maxActionsPerDay: 2 };
    assert.equal((await request('/api/agent-settings', 'PATCH', settings)).status, 200);
    assert.equal((await request('/api/agent-settings', 'PATCH', { ...settings, maxActionsPerDay: 0 })).status, 400);
    assert.equal((await request('/api/agents/wake', 'POST', {})).status, 202);
    await stop(); await start();
    state = (await request('/api/state')).data;
    assert.equal(state.agentSettings.wakeIntervalHours, 12);
    assert.equal(state.agents.find(a => a.id === 'writing').goal, '记录我的研究');
    assert.equal(state.agentDecisions.length, 0);
    assert.equal(state.jobs.length, 0);
  } finally { await stop(); await rm(dir, { recursive: true, force: true }); }
});
