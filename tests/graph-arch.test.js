/**
 * A7b:面板读口 `GET/POST /api/echo/graph-arch` 的守卫。
 *
 * 这一格的纪律(§5.A7):**面板不许成为第二个判定处** —— 口径在引擎里只有一份
 * (`python/engine/arch.py`),`lib/arch.js` 只拼命令、收 JSON。
 *
 * 这个测试钉四件事:
 *   ① 命令拼得对(只读 / 回退两条各自的 argv);
 *   ② stdout 解析:引擎印的不是 JSON ⇒ `null`(不许把警告当状态);
 *   ③ 路线白名单**没有** `shadow-table`(它已冻结,没有回退这个动作);
 *   ④ 路由接线:GET 只读、POST 要 writeAllowed + 显式 `confirm:true` + 白名单。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ARCH_ROUTES, buildArchArgs, parseArchOutput, rollbackArch } from '../lib/arch.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const ARCH_SRC = readFileSync(new URL('../lib/arch.js', import.meta.url), 'utf8')
const INDEX_SRC = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const ROUTE_SRC = INDEX_SRC.slice(
  INDEX_SRC.indexOf("path: '/api/echo/graph-arch'"),
  INDEX_SRC.indexOf("'echo.api.graph-arch()'"))

test('只读那条:argv 里是 --json,没有任何写开关', () => {
  const args = buildArchArgs({ dbPath: 'C:\\x\\echo.db' })
  assert.deepEqual(args, ['-m', 'engine.arch', '--db', 'C:\\x\\echo.db', '--json'])
  assert.ok(!args.includes('--apply'), '只读那条不许带 --apply')
  assert.ok(!args.includes('--rollback'), '只读那条不许带 --rollback')
})

test('回退那条:argv 带 --rollback/--apply/--by panel', () => {
  const args = buildArchArgs({ dbPath: '/tmp/e.db', route: 'cooc-evidence', apply: true })
  assert.deepEqual(args, ['-m', 'engine.arch', '--db', '/tmp/e.db', '--json',
    '--rollback', 'cooc-evidence', '--apply', '--by', 'panel'])
  // 不带 apply ⇒ **只看**(dry-run 是默认值,写要明说)
  const dry = buildArchArgs({ dbPath: '/tmp/e.db', route: 'cooc-evidence' })
  assert.ok(!dry.includes('--apply'), '不显式要写就不许写:' + dry.join(' '))
})

test('stdout 不是 JSON ⇒ null(不许把警告当状态)', () => {
  assert.equal(parseArchOutput(''), null)
  assert.equal(parseArchOutput('  \n '), null)
  assert.equal(parseArchOutput('Traceback (most recent call last):'), null)
  assert.equal(parseArchOutput('null'), null)
  assert.deepEqual(parseArchOutput('{"status":{"topics":{}}}'), { status: { topics: {} } })
})

test('路线白名单里没有 shadow-table(它已冻结,没有回退动作)', async () => {
  assert.deepEqual(ARCH_ROUTES, ['cooc-evidence', 'topic-view'])
  assert.ok(!ARCH_ROUTES.includes('shadow-table'))
  const r = await rollbackArch({ dbPath: '/tmp/e.db', route: 'shadow-table' })
  assert.equal(r.ok, false)
  assert.match(r.error, /route-not-allowed/)
})

test('接线:GET 只读 / POST 要 writeAllowed + confirm:true + 白名单', () => {
  assert.ok(ROUTE_SRC.length > 200, '没找到 /api/echo/graph-arch 那段')
  assert.match(ROUTE_SRC, /req\.method === 'GET'/)
  assert.match(ROUTE_SRC, /readArchStatus\(\{ dbPath: DB_PATH/)
  assert.match(ROUTE_SRC, /if \(!writeAllowed\(req\)\) return json\(res, 403/)
  assert.match(ROUTE_SRC, /body\.confirm !== true/)
  assert.match(ROUTE_SRC, /ARCH_ROUTES\.includes\(route\)/)
  assert.match(ROUTE_SRC, /rollbackArch\(\{ dbPath: DB_PATH, route/)
  // 回退是写动作 ⇒ 必须留痕(与隔壁开关同一条纪律)
  assert.match(ROUTE_SRC, /ctx\.logger\.info\('echo: 面板一键回退/)
})

test('架构读口不碰 worker 协议表、也不自己重算', () => {
  for (const f of ['SidecarClient', 'WORKER_PATH', 'client.request(']) {
    assert.ok(!ARCH_SRC.includes(f), '别把面板读数塞进在线那条管道:' + f)
  }
  for (const f of ['greedy', 'modularity', 'cluster']) {
    assert.ok(!ARCH_SRC.includes(f), 'arch.js 里出现了算法味:' + f)
  }
})

test('文件确实在(守卫别是空的)', () => {
  assert.ok(here.length > 0)
})
