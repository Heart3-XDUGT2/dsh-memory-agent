import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sandbox = {}
new Function('globalThis', readFileSync(new URL('../web/mock/final/audit-ownership.js', import.meta.url), 'utf8'))(sandbox)
new Function('globalThis', readFileSync(new URL('../web/mock/final/audit-scope.js', import.meta.url), 'utf8'))(sandbox)
const scope = sandbox.EchoAuditScope

test('默认陪伴、中性深链与两范围共用 500/light', () => {
  assert.equal(scope.scopeOf('#/audit'), 'companion')
  assert.equal(scope.scopeOf('#/round/123456789a?scope=all'), 'all')
  assert.equal(scope.scopeOf('#/audit?scope=unknown'), 'companion')
  assert.equal(scope.href('round', '123456789a', 'all'), '#/round/123456789a?scope=all')
  assert.equal(scope.href('audit', null, 'companion'), '#/audit?scope=companion')
  const query = new URL(scope.endpoint('companion', "fixture &'+"), 'http://local').searchParams
  assert.equal(query.get('sessionId'), "fixture &'+")
  assert.equal(query.get('limit'), '500')
  assert.equal(query.get('light'), '1')
  assert.equal(new URL(scope.endpoint('all'), 'http://local').searchParams.has('sessionId'), false)
})

test('陪伴请求读取设置、传服务端过滤；全部范围不依赖设置', async () => {
  const calls = []
  const get = async path => { calls.push(path); return path.includes('/settings')
    ? { settings: { relay: { sessionId: 'fixture-target' } } } : { rows: [] } }
  await scope.create({ scope: 'companion', get, signal: new AbortController().signal }).read()
  assert.equal(calls.length, 2)
  assert.equal(new URL(calls[1], 'http://local').searchParams.get('sessionId'), 'fixture-target')
  calls.length = 0
  await scope.create({ scope: 'all', get, signal: new AbortController().signal }).read()
  assert.deepEqual(calls, ['/api/echo/audit?limit=500&light=1', '/api/echo/settings'])
})

test('设置失败或缺会话不会发全局请求冒充陪伴', async () => {
  for (const get of [async () => { throw new Error('HTTP 500') }, async () => ({ settings: { relay: {} } })]) {
    await assert.rejects(scope.create({ scope: 'companion', get, signal: new AbortController().signal }).read(), { name: 'AuditScopeError' })
  }
})

test('重读和离开都会废弃忽略 AbortSignal 的旧响应', async () => {
  const pending = []
  const controller = new AbortController()
  const client = scope.create({ scope: 'all', get: (path, signal) => path.includes('/settings') ? Promise.resolve({}) : new Promise(resolve => pending.push({ resolve, signal })), signal: controller.signal })
  const first = client.read()
  const rejected = assert.rejects(first, { name: 'AbortError' })
  const second = client.read()
  assert.equal(pending[0].signal.aborted, true)
  pending[0].resolve({ rows: ['stale'] })
  pending[1].resolve({ rows: ['fresh'] })
  await rejected
  assert.deepEqual(await second, { rows: ['fresh'] })
  const leaving = client.read()
  const left = assert.rejects(leaving, { name: 'AbortError' })
  controller.abort()
  pending[2].resolve({ rows: ['late'] })
  await left
})

test('all审计先于可选设置，payload不插元数据；迟到只通知标签', async () => {
  let resolveSettings, notifications = 0;
  const rows = [{ sessionId: 'fixture-target' }], payload = { rows };
  const client = scope.create({ scope: 'all', signal: new AbortController().signal,
    get: path => path.includes('/settings') ? new Promise(r => { resolveSettings = r; }) : Promise.resolve(payload) });
  const unsubscribe = client.subscribe(() => notifications++);
  assert.equal(await client.read(), payload);
  const context = client.ownership();
  assert.equal(context.state(), 'checking');
  assert.equal(context.row(rows[0]).label, '会话 1 · 陪伴未核对');
  assert.deepEqual(Object.keys(payload), ['rows']);
  resolveSettings({ settings: { relay: { sessionId: 'fixture-target' } } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(client.ownership(), context);
  assert.equal(context.row(rows[0]).label, '陪伴会话');
  assert.equal(notifications, 1);
  unsubscribe();
});

test('失败/缺配置/有限超时不阻塞all，忽略abort的超时结果不能核对', async () => {
  for (const mode of ['fail', 'missing', 'timeout']) {
    let resolveSettings;
    const client = scope.create({ scope: 'all', timeoutMs: 12, signal: new AbortController().signal,
      get: path => !path.includes('/settings') ? Promise.resolve({ rows: [{ sessionId: 'a' }] })
        : mode === 'fail' ? Promise.reject(new Error('HTTP 500')) : mode === 'missing' ? Promise.resolve({ settings: { relay: {} } }) : new Promise(r => { resolveSettings = r; }) });
    assert.equal((await client.read()).rows.length, 1);
    await new Promise(r => setTimeout(r, 25));
    assert.equal(client.ownership().state(), 'unchecked');
    resolveSettings?.({ settings: { relay: { sessionId: 'a' } } });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(client.ownership().row({ sessionId: 'a' }).category, 'session');
  }
});

test('刷新配置按新读应用，旧请求忽略abort也不能污染新/缓存上下文', async () => {
  const settings = [], controller = new AbortController();
  const client = scope.create({ scope: 'all', signal: controller.signal,
    get: path => path.includes('/settings') ? new Promise(resolve => settings.push(resolve)) : Promise.resolve({ rows: [{ sessionId: 'a' }, { sessionId: 'b' }] }) });
  await client.read(); const old = client.ownership();
  await client.read(); const fresh = client.ownership();
  settings[1]({ settings: { relay: { sessionId: 'b' } } });
  await new Promise(r => setTimeout(r, 0));
  settings[0]({ settings: { relay: { sessionId: 'a' } } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(old.state(), 'unchecked');
  assert.equal(fresh.row({ sessionId: 'b' }).label, '陪伴会话');
  assert.equal(fresh.row({ sessionId: 'a' }).label, '其他会话 1');
  await client.read(); const leaving = client.ownership(); controller.abort();
  settings[2]({ settings: { relay: { sessionId: 'a' } } });
  await new Promise(r => setTimeout(r, 0));
  assert.equal(leaving.state(), 'unchecked');
});
