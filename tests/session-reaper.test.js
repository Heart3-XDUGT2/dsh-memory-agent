/**
 * session-reaper —— 一次性子代理会话回收器。
 *
 * 现场:宿主不删跑完的子代理会话,`~/.dsh/sessions/<ws>/<sid>/` 实测积到 835 个。
 * 判据只有头部 `"origin":"subagent"` 一条;`main` 与 `unknown` 一律保留。
 *
 * ⚠️ 本测试**绝不触碰**真实的 `~/.dsh/sessions` 或 `~/.dsh/storages`:
 * 全部夹具都在 `fs.mkdtemp(os.tmpdir()+'/reaper-')` 里现造,会话文件用
 * `zlib.zstdCompressSync` 现压。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  utimesSync, writeFileSync
} from 'node:fs'
import { rm as realRm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  classifySessionDir, planReap, reapSessions, turnBoundaryFromTimes,
  DEFAULT_WINDOW_MS, DEFAULT_KEEP_NEWEST, DEFAULT_WINDOW_TURNS
} = await import('../lib/session-reaper.js')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const NOW = Date.parse('2026-10-05T10:00:00.000Z')

// ── 夹具 ──────────────────────────────────────────────────────────────

function tempRoot () {
  return mkdtempSync(join(tmpdir(), 'reaper-'))
}

/** 造一个会话目录:`<root>/<ws>/<sid>/session.v4.jsonl.zstd`;raw 给了就写坏文件。 */
function makeSessionDir (sessionsRoot, ws, sid, { header = {}, raw = null, mtimeMs = NOW } = {}) {
  const dir = join(sessionsRoot, ws, sid)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  if (raw !== null) {
    writeFileSync(file, raw)
  } else {
    const head = JSON.stringify({ type: 'session', version: 4, id: sid, cwd: 'C:\\x', ...header })
    const body = JSON.stringify({ type: 'message', role: 'user', text: 'x'.repeat(200) })
    writeFileSync(file, zstdCompressSync(Buffer.from(head + '\n' + body + '\n', 'utf8')))
  }
  const d = new Date(mtimeMs)
  utimesSync(file, d, d)
  utimesSync(dir, d, d)
  return { dir, file, sid }
}

/** 造 projcache 文件。 */
function makeProjcache (root, name) {
  mkdirSync(root, { recursive: true })
  const p = join(root, name)
  writeFileSync(p, JSON.stringify({ ok: true }))
  return p
}

/** 递归列出 root 下的所有文件相对路径(用于"一个都没少"比对)。 */
function listFiles (root) {
  const out = []
  const walk = (dir, pre) => {
    let names = []
    try { names = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const n of names) {
      const rel = pre ? pre + '/' + n.name : n.name
      if (n.isDirectory()) walk(join(dir, n.name), rel)
      else out.push(rel)
    }
  }
  walk(root, '')
  return out.sort()
}

/** 造一批子代理会话(老/新混着);第三条可给 parentSession(默认 ses-main)。 */
function seedSubagents (root, spec) {
  const made = []
  for (const item of spec) {
    const [sid, mtimeMs, parent = 'ses-main'] = Array.isArray(item) ? item : [item, NOW]
    made.push(makeSessionDir(root, 'ws', sid, { header: { origin: 'subagent', parentSession: parent }, mtimeMs }))
  }
  return made
}

// ── classifySessionDir ────────────────────────────────────────────────

test('classify:子代理会话读到 origin / parentSession / bytes / mtimeMs', async () => {
  const root = tempRoot()
  try {
    const s = makeSessionDir(root, 'ws', 'ses-sub', {
      header: { origin: 'subagent', parentSession: 'ses-main' }, mtimeMs: NOW - 3 * HOUR
    })
    const c = await classifySessionDir(s.dir)
    assert.equal(c.kind, 'subagent')
    assert.equal(c.origin, 'subagent')
    assert.equal(c.sid, 'ses-sub')
    assert.equal(c.parentSession, 'ses-main')
    assert.ok(c.bytes > 0, 'bytes 应该是 .zstd 文件大小')
    assert.equal(c.mtimeMs, statSync(s.dir).mtimeMs)
    assert.deepEqual(Object.keys(c).sort(), ['bytes', 'kind', 'mtimeMs', 'origin', 'parentSession', 'sid'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('classify:头部行超过 8KB 时退回整文件解压也认得出', async () => {
  const root = tempRoot()
  try {
    const dir = join(root, 'ws', 'ses-bighead')
    mkdirSync(dir, { recursive: true })
    // 头部第一行故意灌大,让"只读 8KB 头部"拿不到完整 JSON
    const head = JSON.stringify({ type: 'session', version: 4, id: 'ses-bighead', origin: 'subagent', pad: 'z'.repeat(16000) })
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(head + '\n', 'utf8')))
    const c = await classifySessionDir(dir)
    assert.equal(c.kind, 'subagent')
    assert.equal(c.origin, 'subagent')
    assert.equal(c.sid, 'ses-bighead')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── 1) 窗口内保留 ─────────────────────────────────────────────────────

test('窗口内(30 分钟前)的子代理会话被保留', async () => {
  const root = tempRoot()
  try {
    const s = makeSessionDir(root, 'ws', 'ses-fresh', {
      header: { origin: 'subagent' }, mtimeMs: NOW - 30 * MIN
    })
    const c = await classifySessionDir(s.dir)
    assert.equal(c.kind, 'subagent')
    const { keep, reap } = planReap([c], { now: NOW, windowMs: DEFAULT_WINDOW_MS, keepNewest: 1 })
    assert.equal(reap.length, 0)
    assert.equal(keep.length, 1)
    assert.equal(keep[0].sid, 'ses-fresh')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── 2) 超窗口 + 在 keepNewest 之外 → 待删 ──────────────────────────────

test('超窗口且在 keepNewest 之外的老子代理会话被判待删', async () => {
  const root = tempRoot()
  try {
    const made = await Promise.all([
      classifySessionDir(makeSessionDir(root, 'ws', 'ses-a', { header: { origin: 'subagent' }, mtimeMs: NOW - 10 * HOUR }).dir),
      classifySessionDir(makeSessionDir(root, 'ws', 'ses-b', { header: { origin: 'subagent' }, mtimeMs: NOW - 9 * HOUR }).dir),
      classifySessionDir(makeSessionDir(root, 'ws', 'ses-c', { header: { origin: 'subagent' }, mtimeMs: NOW - 8 * HOUR }).dir)
    ])
    const { keep, reap } = planReap(made, { now: NOW, windowMs: 2 * HOUR, keepNewest: 1 })
    assert.deepEqual(keep.map((e) => e.sid), ['ses-c'])
    assert.deepEqual(reap.map((e) => e.sid).sort(), ['ses-a', 'ses-b'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('保留窗口是并集:窗口内的一条即使排名靠后也留', async () => {
  const root = tempRoot()
  try {
    // keepNewest=1 ⇒ 只有 mtime 最新的一条靠排名留;窗口内的第二条排名 ≥ 1,
    // 但它靠"在窗口内"照样留下 —— 并集不是交集。
    const made = await Promise.all([
      classifySessionDir(makeSessionDir(root, 'ws', 'ses-newest', { header: { origin: 'subagent' }, mtimeMs: NOW - 10 * MIN }).dir),
      classifySessionDir(makeSessionDir(root, 'ws', 'ses-inwin', { header: { origin: 'subagent' }, mtimeMs: NOW - 90 * MIN }).dir),
      classifySessionDir(makeSessionDir(root, 'ws', 'ses-old', { header: { origin: 'subagent' }, mtimeMs: NOW - 20 * HOUR }).dir)
    ])
    const { keep, reap } = planReap(made, { now: NOW, windowMs: 2 * HOUR, keepNewest: 1 })
    assert.deepEqual(keep.map((e) => e.sid).sort(), ['ses-inwin', 'ses-newest'])
    assert.deepEqual(reap.map((e) => e.sid), ['ses-old'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── 3) origin !== 'subagent' 永不待删 ─────────────────────────────────

test('origin !== subagent(主对话 / 无 origin / 别的 origin)永不待删', async () => {
  const root = tempRoot()
  try {
    const cNoOrigin = await classifySessionDir(makeSessionDir(root, 'ws', 'ses-main1', { mtimeMs: NOW - 100 * HOUR }).dir)
    const cOther = await classifySessionDir(makeSessionDir(root, 'ws', 'ses-main2', { header: { origin: 'user' }, mtimeMs: NOW - 100 * HOUR }).dir)
    assert.equal(cNoOrigin.kind, 'main')
    assert.equal(cNoOrigin.origin, null)
    assert.equal(cOther.kind, 'main')
    assert.equal(cOther.origin, 'user')
    // keepNewest=0、窗口 0 ⇒ 一条都不该收
    const { keep, reap } = planReap([cNoOrigin, cOther], { now: NOW, windowMs: 0, keepNewest: 0 })
    assert.equal(reap.length, 0)
    assert.equal(keep.length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── 4) unknown:解压不了 / 没有 .zstd ──────────────────────────────────

test('无法解压的目录进 unknown 且不待删', async () => {
  const root = tempRoot()
  try {
    const s = makeSessionDir(root, 'ws', 'ses-broken', { raw: Buffer.from('这不是 zstd 数据', 'utf8'), mtimeMs: NOW - 100 * HOUR })
    const c = await classifySessionDir(s.dir)
    assert.equal(c.kind, 'unknown')
    const { keep, reap } = planReap([c], { now: NOW, windowMs: 0, keepNewest: 0 })
    assert.equal(reap.length, 0)
    assert.equal(keep.length, 1)

    const noZstd = join(root, 'ws', 'ses-nozstd')
    mkdirSync(noZstd, { recursive: true })
    const c2 = await classifySessionDir(noZstd)
    assert.equal(c2.kind, 'unknown')
    assert.equal(planReap([c2], { now: NOW, windowMs: 0, keepNewest: 0 }).reap.length, 0)

    // 走 reapSessions:unknown 单独列出,而且 apply 也不动它
    const pc = join(root, 'pc')
    const res = await reapSessions({
      sessionsRoot: root, projcacheRoot: pc, auditDir: join(root, 'audit'),
      now: NOW, windowMs: 0, keepNewest: 0, apply: true
    })
    assert.equal(res.reaped.length, 0)
    assert.equal(res.unknown.length, 2)
    for (const u of res.unknown) {
      assert.ok(typeof u.why === 'string' && u.why.length > 0, 'unknown 要带 why')
      assert.ok(existsSync(u.path), 'unknown 目录必须原样留着')
    }
    assert.deepEqual(res.unknown.map((u) => u.sid).sort(), ['ses-broken', 'ses-nozstd'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── 5) dry-run:一个文件都不少 ─────────────────────────────────────────

test('apply !== true:待删照常判出来,但磁盘上一个文件都没少', async () => {
  const root = tempRoot()
  try {
    const sessionsRoot = join(root, 'sessions')
    const projcacheRoot = join(root, 'storages', 'session_projcache', 'sessions')
    const auditDir = join(root, 'echo', 'audit')
    seedSubagents(sessionsRoot, [
      ['ses-old1', NOW - 20 * HOUR],
      ['ses-old2', NOW - 19 * HOUR],
      ['ses-new', NOW - 30 * MIN]
    ])
    makeProjcache(projcacheRoot, 'ses-old1.json')
    makeProjcache(projcacheRoot, 'session-ses-old2.json')

    const before = listFiles(root)
    const res = await reapSessions({
      sessionsRoot, projcacheRoot, auditDir, now: NOW, windowMs: 2 * HOUR, keepNewest: 1, apply: false
    })
    assert.equal(res.applied, false)
    assert.equal(res.scanned, 3)
    assert.equal(res.kept, 1)
    // dry-run 里 reaped = 计划要删的(planReap 结果照常返回),含"会删哪些 projcache"
    assert.deepEqual(res.reaped.map((r) => r.sid).sort(), ['ses-old1', 'ses-old2'])
    assert.deepEqual(res.reaped.find((r) => r.sid === 'ses-old1').projcache, [join(projcacheRoot, 'ses-old1.json')])
    assert.deepEqual(res.reaped.find((r) => r.sid === 'ses-old2').projcache, [join(projcacheRoot, 'session-ses-old2.json')])
    assert.equal(res.manifestPath, null, 'dry-run 不写清单')
    assert.equal(res.freedBytes, 0, 'dry-run 一个字节也没释放')
    assert.deepEqual(listFiles(root), before, '一个文件都不该少')
    assert.equal(existsSync(auditDir), false, 'dry-run 不该凭空造 audit 目录')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── 6) apply:目录 / projcache / 清单 ──────────────────────────────────

test('apply === true:删会话目录 + 对应 projcache 文件,清单先写且行数一致', async () => {
  const root = tempRoot()
  try {
    const sessionsRoot = join(root, 'sessions')
    const projcacheRoot = join(root, 'storages', 'session_projcache', 'sessions')
    const auditDir = join(root, 'echo', 'audit')
    const made = seedSubagents(sessionsRoot, [
      ['ses-old1', NOW - 20 * HOUR],
      ['ses-old2', NOW - 19 * HOUR],
      ['ses-new', NOW - 30 * MIN]
    ])
    const p1 = makeProjcache(projcacheRoot, 'ses-old1.json')
    const p2 = makeProjcache(projcacheRoot, 'session-ses-old2.json')
    const unrelated = makeProjcache(projcacheRoot, 'ses-someone-else.json')
    // ses-old2 还有一种命名不在 ⇒ 只删存在的那个,不算错

    const res = await reapSessions({
      sessionsRoot, projcacheRoot, auditDir, now: NOW, windowMs: 2 * HOUR, keepNewest: 1, apply: true
    })
    assert.equal(res.applied, true)
    assert.equal(res.scanned, 3)
    assert.equal(res.reaped.length, 2)
    assert.deepEqual(res.reaped.map((r) => r.sid).sort(), ['ses-old1', 'ses-old2'])

    // 会话目录被整个递归删掉
    assert.equal(existsSync(made[0].dir), false)
    assert.equal(existsSync(made[1].dir), false)
    assert.equal(existsSync(made[2].dir), true, '窗口内的会话不许动')
    // projcache 对应的删了,不对应的留着
    assert.equal(existsSync(p1), false)
    assert.equal(existsSync(p2), false)
    assert.equal(existsSync(unrelated), true, 'projcache 里对不上会话 id 的文件不能删')
    const r1 = res.reaped.find((r) => r.sid === 'ses-old1')
    assert.deepEqual(r1.projcache, [p1])
    assert.ok(res.freedBytes > 0)

    // 清单:文件存在、行数 == 待删数、每条都合规格
    assert.ok(res.manifestPath && existsSync(res.manifestPath), 'apply 必须留下清单')
    assert.match(res.manifestPath, /reaper-\d{8}-\d{6}\.jsonl$/)
    const lines = readFileSync(res.manifestPath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    for (const line of lines) {
      const rec = JSON.parse(line)
      assert.equal(rec.kind, 'subagent')
      assert.equal(rec.windowMs, 2 * HOUR)
      assert.equal(rec.keepNewest, 1)
      assert.ok(typeof rec.sid === 'string' && typeof rec.path === 'string')
      assert.ok(Number.isFinite(rec.bytes))
      assert.ok(!Number.isNaN(Date.parse(rec.at)))
    }
    assert.deepEqual(lines.map((l) => JSON.parse(l).sid).sort(), ['ses-old1', 'ses-old2'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ── 7) fail-soft:注入会抛的 rm ────────────────────────────────────────

test('删除失败(注入会抛的 rm)时函数不抛、该条不出现、其余继续', async () => {
  const root = tempRoot()
  try {
    const sessionsRoot = join(root, 'sessions')
    const projcacheRoot = join(root, 'storages', 'session_projcache', 'sessions')
    const auditDir = join(root, 'echo', 'audit')
    const made = seedSubagents(sessionsRoot, [
      ['ses-boom', NOW - 20 * HOUR],
      ['ses-ok1', NOW - 19 * HOUR],
      ['ses-ok2', NOW - 18 * HOUR]
    ])
    const warned = []
    const rm = async (p, o) => {
      if (String(p).includes('ses-boom')) throw new Error('注入的删除失败')
      return realRm(p, o)
    }
    const res = await reapSessions({
      sessionsRoot, projcacheRoot, auditDir, now: NOW, windowMs: 2 * HOUR, keepNewest: 0, apply: true,
      log: { warn: (m) => warned.push(m) }, rm
    })
    assert.ok(Array.isArray(res.reaped))
    assert.deepEqual(res.reaped.map((r) => r.sid).sort(), ['ses-ok1', 'ses-ok2'])
    assert.equal(res.reaped.some((r) => r.sid === 'ses-boom'), false)
    assert.equal(existsSync(made[0].dir), true, '删失败的那条原样留着')
    assert.equal(existsSync(made[1].dir), false)
    assert.equal(existsSync(made[2].dir), false)
    assert.ok(warned.some((m) => m.includes('ses-boom')), '失败要 log.warn')
    // 清单照样只有成功的?—— 清单是"待删清单",失败那条也在里面(先备份后删)
    const lines = readFileSync(res.manifestPath, 'utf8').trim().split('\n')
    assert.equal(lines.length, 3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('projcache 里没有对应文件时不算错(projcache: [])', async () => {
  const root = tempRoot()
  try {
    const sessionsRoot = join(root, 'sessions')
    const projcacheRoot = join(root, 'storages', 'session_projcache', 'sessions')
    mkdirSync(projcacheRoot, { recursive: true })
    makeProjcache(projcacheRoot, 'ses-nothing-to-do.json')
    seedSubagents(sessionsRoot, [['ses-nocache', NOW - 30 * HOUR]])

    const warned = []
    const res = await reapSessions({
      sessionsRoot, projcacheRoot, auditDir: join(root, 'echo', 'audit'),
      // 本例只验缓存缺项：显式没有主会话窗口，使用时长兜底。
      listMainTimes: async () => null,
      now: NOW, windowMs: 2 * HOUR, keepNewest: 0, apply: true, log: { warn: (m) => warned.push(m) }
    })
    assert.equal(res.turnBoundary.fallback, true)
    assert.equal(res.reaped.length, 1)
    assert.deepEqual(res.reaped[0].projcache, [])
    assert.equal(warned.length, 0, '没有对应缓存不该 warn')
    assert.equal(existsSync(join(projcacheRoot, 'ses-nothing-to-do.json')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('sessions 根目录不存在时 fail-soft:scanned 0、不抛', async () => {
  const root = tempRoot()
  try {
    const res = await reapSessions({
      sessionsRoot: join(root, 'nope'), projcacheRoot: join(root, 'pc'),
      auditDir: join(root, 'audit'), now: NOW, apply: true
    })
    assert.equal(res.scanned, 0)
    assert.equal(res.reaped.length, 0)
    assert.equal(res.unknown.length, 0)
    assert.equal(res.manifestPath === null || existsSync(res.manifestPath), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ═══════════════════════════════════════════════════════════════════════
// 轮数窗口 —— turnBoundaryFromTimes(纯函数)
// ═══════════════════════════════════════════════════════════════════════

/** 升序时间戳序列 base, base+1, ...(epoch ms)。 */
function series (base, n) {
  return Array.from({ length: n }, (_, i) => base + i)
}

test('turnBoundaryFromTimes:正常 —— 取最近 turns 轮里最早那条(每父各算各的)', () => {
  const times = series(1000, 10) // [1000..1009]
  const r = turnBoundaryFromTimes({ turns: 3, sessions: [{ sid: 'a', times }] })
  assert.deepEqual(r.windows, [{ sid: 'a', turnsUsed: 3, boundaryMs: 1007, partial: false, keepAll: false }])
  assert.equal(r.byParent.a, 1007, 'byParent 要能让回收器按 parentSession 查表')
  assert.equal(r.latestMs, 1007)
  assert.equal(r.partial, false)
})

test('turnBoundaryFromTimes:turns 恰好等于条数时也是整段最早那条', () => {
  const times = series(1000, 4)
  const r = turnBoundaryFromTimes({ turns: 4, sessions: [{ sid: 'a', times }] })
  assert.equal(r.windows[0].boundaryMs, 1000)
  assert.equal(r.windows[0].turnsUsed, 4)
  assert.equal(r.windows[0].keepAll, false, '条数 == turns 是真实数据,不是 partial')
  assert.equal(r.windows[0].partial, false)
})

test('turnBoundaryFromTimes:条数少于 turns(历史被截断)⇒ keepAll,不拿最早那条当边界', () => {
  const times = series(1000, 3)
  const r = turnBoundaryFromTimes({ turns: 10, sessions: [{ sid: 'a', times }] })
  assert.equal(r.windows[0].boundaryMs, null, '截断的会话不许给出边界(那会把窗口拉到极早)')
  assert.equal(r.windows[0].keepAll, true)
  assert.equal(r.windows[0].partial, true)
  assert.equal(r.windows[0].turnsUsed, 3, 'turnsUsed 只能是拿到的条数')
  assert.equal(r.byParent.a, null, 'null = 该父名下全留')
  assert.equal(r.latestMs, null, '没有真实边界时 latestMs 也是 null')
})

test('turnBoundaryFromTimes:一条用户消息都没有 ⇒ 同样 keepAll', () => {
  const r = turnBoundaryFromTimes({ turns: 10, sessions: [{ sid: 'a', times: [] }] })
  assert.deepEqual(r.windows, [{ sid: 'a', turnsUsed: 0, boundaryMs: null, partial: true, keepAll: true }])
  assert.equal(r.byParent.a, null)
})

test('turnBoundaryFromTimes:多父**不取 min** —— 各是各的,可删的照着删', () => {
  const r = turnBoundaryFromTimes({
    turns: 3,
    sessions: [
      { sid: 'A', times: series(5000, 5) }, // 边界 5002
      { sid: 'B', times: series(1000, 5) } // 边界 1002(不是全局最小,而是 B 自己的)
    ]
  })
  assert.equal(r.byParent.A, 5002)
  assert.equal(r.byParent.B, 1002)
  assert.equal(r.latestMs, 5002)
  // 旧口径会取 min=1002 并把 A 的窗口也拉到 1002;新口径下 A 仍是 5002
  assert.deepEqual(r.windows.map((w) => [w.sid, w.boundaryMs]), [['A', 5002], ['B', 1002]])
})

test('turnBoundaryFromTimes:partial 会话不把别的会话边界拉到极早', () => {
  const p = turnBoundaryFromTimes({
    turns: 300,
    sessions: [
      { sid: 'tiny', times: series(1, 5) }, // 只有 5 轮 ⇒ keepAll,边界 null
      { sid: 'big', times: series(900000, 400) } // 400 轮 ⇒ 真边界 900100
    ]
  })
  assert.equal(p.byParent.tiny, null, 'tiny 全留')
  assert.equal(p.byParent.big, 900100, 'big 的边界必须是它自己的,不能被 tiny 的最早时间(1)拉走')
  assert.equal(p.latestMs, 900100)
  assert.equal(p.partial, true)
  // tiny 单独算也没有任何边界落进结果里
  assert.equal(p.windows.some((w) => w.boundaryMs !== null && w.boundaryMs < 900000), false)
})

test('turnBoundaryFromTimes:空输入 ⇒ null(绝不用猜测值)', () => {
  assert.equal(turnBoundaryFromTimes(), null)
  assert.equal(turnBoundaryFromTimes({}), null)
  assert.equal(turnBoundaryFromTimes({ turns: 300, sessions: [] }), null)
  assert.equal(turnBoundaryFromTimes({ turns: 300, sessions: [null, {}, 'x'] }), null)
})

test('turnBoundaryFromTimes:边界永不早于真值(截断只会更保守)', () => {
  const full = series(1000, 12)
  const turns = 4
  const truth = turnBoundaryFromTimes({ turns, sessions: [{ sid: 'a', times: full }] }).windows[0].boundaryMs
  assert.equal(truth, 1008)
  for (let m = 1; m <= full.length; m += 1) {
    const view = full.slice(-m)
    const w = turnBoundaryFromTimes({ turns, sessions: [{ sid: 'a', times: view }] }).windows[0]
    if (w.keepAll) {
      assert.ok(m < turns, `m=${m}: 只有 m<turns 才允许 keepAll`)
      continue
    }
    assert.ok(w.boundaryMs >= truth, `m=${m}: ${w.boundaryMs} 不该早于真值 ${truth}`)
    if (m >= turns) assert.equal(w.boundaryMs, truth, `m=${m}: 够 turns 时应当正好等于真值`)
  }
})

// ═══════════════════════════════════════════════════════════════════════
// 轮数窗口 —— planReap(按父各算各的 / 全局 boundaryMs)
// ═══════════════════════════════════════════════════════════════════════

/** 造一个子代理条目(直接喂 planReap,不用落盘)。 */
function subEntry (sid, parentSession, mtimeMs) {
  return { sid, kind: 'subagent', origin: 'subagent', parentSession, mtimeMs, bytes: 1 }
}

test('planReap:按父各算各的 —— A 的子代理用 A 的边界,B 的用 B 的', () => {
  // B_B = NOW-2h(窗口窄) ⇒ B 名下老子代理该删;
  // B_A = NOW-30h(窗口宽)  ⇒ A 名下同样老的子代理该留。
  const byParent = { A: NOW - 30 * HOUR, B: NOW - 2 * HOUR }
  const entries = [
    subEntry('sub-a-old', 'A', NOW - 20 * HOUR), // A 的窗口内 ⇒ 留
    subEntry('sub-b-old', 'B', NOW - 20 * HOUR), // B 的窗口外 ⇒ 删
    subEntry('sub-a-new', 'A', NOW - 1 * HOUR),
    subEntry('sub-b-new', 'B', NOW - 1 * HOUR)
  ]
  const { keep, reap } = planReap(entries, { now: NOW, windowMs: 0, keepNewest: 0, boundaryByParent: byParent })
  assert.deepEqual(reap.map((e) => e.sid), ['sub-b-old'], 'B 的老子代理被删,B 的新子代理留下')
  assert.deepEqual(keep.map((e) => e.sid).sort(), ['sub-a-new', 'sub-a-old', 'sub-b-new'])
  // 反证:若按旧的"全局取 min",B_A=NOW-30h 会让 sub-b-old 也留下 ⇒ 删不掉
  const old = planReap(entries, { now: NOW, windowMs: 0, keepNewest: 0, boundaryMs: byParent.A })
  assert.deepEqual(old.reap.map((e) => e.sid), [], '旧口径(全局最宽边界)确实一条都删不掉')
})

test('planReap:父 keepAll(null)/ 孤立子代理 ⇒ 一律保留', () => {
  const entries = [
    subEntry('sub-partial', 'P', NOW - 500 * HOUR), // P 是 partial ⇒ 全留
    subEntry('sub-orphan', 'NOPE', NOW - 500 * HOUR), // 父不在表里
    subEntry('sub-noparent', null, NOW - 500 * HOUR), // 没 parentSession
    subEntry('sub-normal', 'Q', NOW - 500 * HOUR) // Q 有边界 ⇒ 可删
  ]
  const { keep, reap } = planReap(entries, {
    now: NOW,
    windowMs: 0,
    keepNewest: 0,
    boundaryByParent: { P: null, Q: NOW - 1 * HOUR }
  })
  assert.deepEqual(reap.map((e) => e.sid), ['sub-normal'])
  assert.deepEqual(keep.map((e) => e.sid).sort(), ['sub-noparent', 'sub-orphan', 'sub-partial'])
})

test('planReap:boundaryByParent 也支持 Map,坏值当"保留"', () => {
  const map = new Map([['A', NOW - 1 * HOUR], ['B', NaN], ['C', undefined]])
  const entries = [
    subEntry('s-a', 'A', NOW - 9 * HOUR), // 超 A 的边界 ⇒ 删
    subEntry('s-b', 'B', NOW - 9 * HOUR),
    subEntry('s-c', 'C', NOW - 9 * HOUR)
  ]
  const { keep, reap } = planReap(entries, { now: NOW, windowMs: 0, keepNewest: 0, boundaryByParent: map })
  assert.deepEqual(reap.map((e) => e.sid), ['s-a'])
  assert.deepEqual(keep.map((e) => e.sid).sort(), ['s-b', 's-c'])
})

test('planReap:boundaryByParent 下并集语义照旧(超边界但排名之内 ⇒ 留)', () => {
  const entries = [
    subEntry('sub-new', 'B', NOW - 1 * HOUR), // B 的窗口内(rank 0)
    subEntry('sub-old', 'B', NOW - 3 * HOUR) // B 的窗口外(rank 1)⇒ 只能靠 keepNewest 救
  ]
  const { keep, reap } = planReap(entries, {
    now: NOW, windowMs: 0, keepNewest: 2, boundaryByParent: { B: NOW - 2 * HOUR }
  })
  assert.deepEqual(keep.map((e) => e.sid).sort(), ['sub-new', 'sub-old'])
  assert.equal(reap.length, 0, '排名第 1 < keepNewest=2 ⇒ 并集救回')

  // 同一条数据、keepNewest=1 ⇒ 窗口外的那条就删掉(并集不是交集)
  const r2 = planReap(entries, {
    now: NOW, windowMs: 0, keepNewest: 1, boundaryByParent: { B: NOW - 2 * HOUR }
  })
  assert.deepEqual(r2.keep.map((e) => e.sid), ['sub-new'])
  assert.deepEqual(r2.reap.map((e) => e.sid), ['sub-old'])
})

test('planReap:给了 boundaryMs ⇒ 判据换成 mtimeMs >= boundaryMs', async () => {
  const root = tempRoot()
  try {
    const B = NOW - 5 * HOUR
    const made = await Promise.all([
      classifySessionDir(makeSessionDir(root, 'ws', 'ses-in', { header: { origin: 'subagent' }, mtimeMs: B + 1 }).dir),
      classifySessionDir(makeSessionDir(root, 'ws', 'ses-on', { header: { origin: 'subagent' }, mtimeMs: B }).dir), // 边界上 ⇒ 留
      classifySessionDir(makeSessionDir(root, 'ws', 'ses-out', { header: { origin: 'subagent' }, mtimeMs: B - 1 }).dir)
    ])
    // windowMs 故意给得很大:证明生效的是 boundaryMs 而不是时长窗口
    const { keep, reap } = planReap(made, { now: NOW, windowMs: 100 * HOUR, keepNewest: 0, boundaryMs: B })
    assert.deepEqual(keep.map((e) => e.sid).sort(), ['ses-in', 'ses-on'])
    assert.deepEqual(reap.map((e) => e.sid), ['ses-out'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('planReap:boundaryMs 与 keepNewest 仍然是并集', async () => {
  const root = tempRoot()
  try {
    const B = NOW - 5 * HOUR
    // 排名(mtime 新→旧):ses-a(NOW-1h) > ses-b(NOW-4h) > ses-c(NOW-6h)
    // 窗口(mtime >= B):ses-a ✓、ses-b ✓、ses-c ✗
    const made = [
      makeSessionDir(root, 'ws', 'ses-a', { header: { origin: 'subagent' }, mtimeMs: NOW - 1 * HOUR }),
      makeSessionDir(root, 'ws', 'ses-b', { header: { origin: 'subagent' }, mtimeMs: B + 1 * HOUR }),
      makeSessionDir(root, 'ws', 'ses-c', { header: { origin: 'subagent' }, mtimeMs: B - 1 * HOUR })
    ]
    const entries = await Promise.all(made.map((m) => classifySessionDir(m.dir)))
    assert.deepEqual(entries.map((e) => e.sid), ['ses-a', 'ses-b', 'ses-c'])
    assert.deepEqual(entries.map((e) => e.kind), ['subagent', 'subagent', 'subagent'])

    // ① keepNewest 贡献:排名之内 ⇒ 留(窗口外的 ses-c 不在排名内才删)
    const r1 = planReap(entries, { now: NOW, windowMs: 0, keepNewest: 2, boundaryMs: B })
    assert.deepEqual(r1.keep.map((e) => e.sid).sort(), ['ses-a', 'ses-b'])
    assert.deepEqual(r1.reap.map((e) => e.sid), ['ses-c'])

    // ② 窗口贡献:ses-b 排名在 keepNewest=1 之外,靠"在 boundaryMs 之内"照样留
    const r2 = planReap(entries, { now: NOW, windowMs: 0, keepNewest: 1, boundaryMs: B })
    assert.deepEqual(r2.keep.map((e) => e.sid).sort(), ['ses-a', 'ses-b'])
    assert.deepEqual(r2.reap.map((e) => e.sid), ['ses-c'])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('planReap:boundaryMs 下 main / unknown 照样免疫', async () => {
  const root = tempRoot()
  try {
    const B = NOW - 5 * HOUR
    const cMain = await classifySessionDir(makeSessionDir(root, 'ws', 'ses-main', { mtimeMs: B - 100 }).dir)
    const cUnknown = await classifySessionDir(makeSessionDir(root, 'ws', 'ses-bad', { raw: Buffer.from('不是 zstd', 'utf8'), mtimeMs: B - 100 }).dir)
    assert.equal(cMain.kind, 'main')
    assert.equal(cUnknown.kind, 'unknown')
    const { keep, reap } = planReap([cMain, cUnknown], { now: NOW, windowMs: 0, keepNewest: 0, boundaryMs: B })
    assert.equal(reap.length, 0)
    assert.equal(keep.length, 2)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('planReap:boundaryMs 非法(非有限数 / 0 / 负)⇒ 退回时长窗口', async () => {
  const root = tempRoot()
  try {
    const made = await Promise.all([
      classifySessionDir(makeSessionDir(root, 'ws', 'ses-fresh', { header: { origin: 'subagent' }, mtimeMs: NOW - 30 * MIN }).dir),
      classifySessionDir(makeSessionDir(root, 'ws', 'ses-old', { header: { origin: 'subagent' }, mtimeMs: NOW - 20 * HOUR }).dir)
    ])
    for (const bad of [undefined, null, NaN, Infinity, -1, 0, 'x']) {
      const { keep, reap } = planReap(made, { now: NOW, windowMs: 2 * HOUR, keepNewest: 0, boundaryMs: bad })
      assert.deepEqual(keep.map((e) => e.sid), ['ses-fresh'], `boundaryMs=${String(bad)}`)
      assert.deepEqual(reap.map((e) => e.sid), ['ses-old'], `boundaryMs=${String(bad)}`)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ═══════════════════════════════════════════════════════════════════════
// 轮数窗口 —— reapSessions(注入 listMainTimes)
// ═══════════════════════════════════════════════════════════════════════

test('reapSessions:注入 byParent ⇒ A 的子代理用 A 的边界、B 的用 B 的', async () => {
  const root = tempRoot()
  try {
    const sessionsRoot = join(root, 'sessions')
    // A 的边界宽(NOW-30h),B 的边界窄(NOW-2h);两条"同样老"的子代理命运相反
    const B_A = NOW - 30 * HOUR
    const B_B = NOW - 2 * HOUR
    seedSubagents(sessionsRoot, [
      ['ses-a-old', NOW - 20 * HOUR, 'ses-A'], // A 的窗口内 ⇒ 留
      ['ses-b-old', NOW - 20 * HOUR, 'ses-B'], // B 的窗口外 ⇒ 删
      ['ses-a-new', NOW - 1 * HOUR, 'ses-A'],
      ['ses-b-new', NOW - 1 * HOUR, 'ses-B'],
      ['ses-orphan', NOW - 20 * HOUR, 'ses-NOWHERE'] // 父不在表里 ⇒ 留
    ])
    const calls = []
    const res = await reapSessions({
      sessionsRoot,
      projcacheRoot: join(root, 'pc'),
      auditDir: join(root, 'audit'),
      now: NOW,
      windowTurns: 300,
      windowMs: 100 * HOUR, // 时长窗口一条都不删;生效的必须是"按父各算各的"
      keepNewest: 0,
      listMainTimes: async (args) => {
        calls.push(args)
        return {
          turns: 300,
          windows: [
            { sid: 'ses-A', turnsUsed: 500, boundaryMs: B_A, partial: false, keepAll: false },
            { sid: 'ses-B', turnsUsed: 500, boundaryMs: B_B, partial: false, keepAll: false }
          ],
          byParent: { 'ses-A': B_A, 'ses-B': B_B },
          latestMs: B_B,
          partial: false
        }
      }
    })
    assert.equal(calls.length, 1, '取数器每次回收只跑一次(父这一层算完,子代理只查表)')
    assert.equal(calls[0].turns, 300)
    assert.equal(res.turnBoundary.fallback, false)
    assert.equal(res.turnBoundary.ms, null, '按父各算各的 ⇒ 没有单一全局边界')
    assert.deepEqual(res.turnBoundary.byParent, { 'ses-A': B_A, 'ses-B': B_B })
    assert.equal(res.turnBoundary.windows.length, 2)
    assert.deepEqual(res.reaped.map((r) => r.sid), ['ses-b-old'])
    assert.deepEqual(res.kept, 4)
    assert.equal(typeof res.ms, 'number', '要回报本次实际耗时')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reapSessions:按父各算各的 —— 父 partial(null)名下全留', async () => {
  const root = tempRoot()
  try {
    const sessionsRoot = join(root, 'sessions')
    seedSubagents(sessionsRoot, [
      ['ses-p-old', NOW - 500 * HOUR, 'ses-P'], // P 是 partial ⇒ 全留
      ['ses-q-old', NOW - 500 * HOUR, 'ses-Q'] // Q 有边界 ⇒ 删
    ])
    const res = await reapSessions({
      sessionsRoot,
      projcacheRoot: join(root, 'pc'),
      auditDir: join(root, 'audit'),
      now: NOW,
      windowMs: 100 * HOUR,
      keepNewest: 0,
      listMainTimes: async () => ({
        turns: 300,
        windows: [
          { sid: 'ses-P', turnsUsed: 7, boundaryMs: null, partial: true, keepAll: true },
          { sid: 'ses-Q', turnsUsed: 400, boundaryMs: NOW - 1 * HOUR, partial: false, keepAll: false }
        ],
        byParent: { 'ses-P': null, 'ses-Q': NOW - 1 * HOUR },
        latestMs: NOW - 1 * HOUR,
        partial: true
      })
    })
    assert.deepEqual(res.reaped.map((r) => r.sid), ['ses-q-old'])
    assert.equal(res.turnBoundary.partial, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reapSessions:注入只给全局 boundaryMs(旧形状)⇒ 仍按全局窗口删留', async () => {
  const root = tempRoot()
  try {
    const sessionsRoot = join(root, 'sessions')
    const B = NOW - 5 * HOUR
    seedSubagents(sessionsRoot, [
      ['ses-old1', NOW - 20 * HOUR],
      ['ses-old2', B - 1],
      ['ses-on', B],
      ['ses-new', NOW - 30 * MIN]
    ])
    const res = await reapSessions({
      sessionsRoot,
      projcacheRoot: join(root, 'pc'),
      auditDir: join(root, 'audit'),
      now: NOW,
      windowTurns: 300,
      windowMs: 100 * HOUR, // 时长窗口会一条都不删;生效的必须是轮数窗口
      keepNewest: 0,
      listMainTimes: async () => ({
        boundaryMs: B,
        turns: 300,
        partial: true,
        sources: [{ sid: 'ses-main', turnsUsed: 7, boundaryMs: B }]
      })
    })
    assert.equal(res.turnBoundary.fallback, false)
    assert.equal(res.turnBoundary.ms, B)
    assert.equal(res.turnBoundary.byParent, null)
    assert.equal(res.turnBoundary.partial, true)
    assert.deepEqual(res.turnBoundary.windows, [{ sid: 'ses-main', turnsUsed: 7, boundaryMs: B }])
    assert.deepEqual(res.reaped.map((r) => r.sid).sort(), ['ses-old1', 'ses-old2'])
    assert.equal(res.reaped.some((r) => r.sid === 'ses-on'), false, '正好在边界上要留')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reapSessions:注入返回 null ⇒ 退回时长窗口兜底(fallback:true),一个都不误删', async () => {
  const root = tempRoot()
  try {
    const sessionsRoot = join(root, 'sessions')
    seedSubagents(sessionsRoot, [
      ['ses-fresh', NOW - 30 * MIN],
      ['ses-inwin', NOW - 90 * MIN],
      ['ses-old', NOW - 20 * HOUR]
    ])
    const before = listFiles(root)
    const res = await reapSessions({
      sessionsRoot,
      projcacheRoot: join(root, 'pc'),
      auditDir: join(root, 'audit'),
      now: NOW,
      windowMs: 2 * HOUR,
      windowTurns: 300,
      keepNewest: 0,
      apply: false,
      listMainTimes: async () => null
    })
    assert.equal(res.turnBoundary.fallback, true)
    assert.equal(res.turnBoundary.ms, NOW - 2 * HOUR, '兜底边界 = now - windowMs')
    assert.equal(res.turnBoundary.turns, 300)
    assert.equal(res.turnBoundary.partial, false)
    assert.equal(res.turnBoundary.byParent, null)
    assert.deepEqual(res.turnBoundary.windows, [])
    assert.deepEqual(res.reaped.map((r) => r.sid), ['ses-old'])
    assert.equal(res.reaped.some((r) => r.sid === 'ses-fresh' || r.sid === 'ses-inwin'), false, '兜底不许误删窗口内的')
    assert.deepEqual(listFiles(root), before, 'dry-run 一个文件都不该少')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reapSessions:显式 boundaryMs 优先,连取数器都不调用;清单行带 boundaryMs / turns', async () => {
  const root = tempRoot()
  try {
    const sessionsRoot = join(root, 'sessions')
    const B = NOW - 3 * HOUR
    const made = seedSubagents(sessionsRoot, [['ses-old', NOW - 20 * HOUR], ['ses-new', NOW - 30 * MIN]])
    let called = 0
    const res = await reapSessions({
      sessionsRoot,
      projcacheRoot: join(root, 'pc'),
      auditDir: join(root, 'audit'),
      now: NOW,
      boundaryMs: B,
      windowTurns: 42,
      windowMs: 100 * HOUR,
      keepNewest: 0,
      apply: true,
      listMainTimes: async () => { called += 1; return null }
    })
    assert.equal(called, 0, '显式 boundaryMs 时不该再去算轮数窗口')
    assert.equal(res.turnBoundary.fallback, false)
    assert.equal(res.turnBoundary.ms, B)
    assert.equal(res.turnBoundary.turns, 42)
    assert.deepEqual(res.reaped.map((r) => r.sid), ['ses-old'])
    assert.equal(existsSync(made[0].dir), false)
    assert.equal(existsSync(made[1].dir), true)
    const rec = JSON.parse(readFileSync(res.manifestPath, 'utf8').trim())
    assert.equal(rec.boundaryMs, B)
    assert.equal(rec.turns, 42)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reapSessions:取数器抛异常 ⇒ fail-soft 退回时长窗口,不抛', async () => {
  const root = tempRoot()
  try {
    const sessionsRoot = join(root, 'sessions')
    seedSubagents(sessionsRoot, [['ses-old', NOW - 20 * HOUR]])
    const warned = []
    const res = await reapSessions({
      sessionsRoot,
      projcacheRoot: join(root, 'pc'),
      auditDir: join(root, 'audit'),
      now: NOW,
      windowMs: 2 * HOUR,
      keepNewest: 0,
      listMainTimes: async () => { throw new Error('注入的取数器炸了') },
      log: { warn: (m) => warned.push(m) }
    })
    assert.equal(res.turnBoundary.fallback, true)
    assert.deepEqual(res.reaped.map((r) => r.sid), ['ses-old'])
    assert.ok(warned.some((m) => m.includes('轮数窗口取数器抛了')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reapSessions:默认(DEFAULT_WINDOW_TURNS)在临时夹具上算不出轮数边界 ⇒ 安全退回', async () => {
  const root = tempRoot()
  try {
    const sessionsRoot = join(root, 'sessions')
    seedSubagents(sessionsRoot, [['ses-old', NOW - 20 * HOUR], ['ses-new', NOW - 30 * MIN]])
    const res = await reapSessions({
      sessionsRoot,
      projcacheRoot: join(root, 'pc'),
      auditDir: join(root, 'audit'),
      now: NOW,
      windowMs: 2 * HOUR,
      keepNewest: 0
    })
    assert.equal(res.turnBoundary.turns, DEFAULT_WINDOW_TURNS)
    assert.equal(res.turnBoundary.fallback, true)
    assert.deepEqual(res.reaped.map((r) => r.sid), ['ses-old'], '退回时长窗口后仍按 windowMs 判')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
