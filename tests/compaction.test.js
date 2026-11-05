/**
 * v0.20.0 D1:预设替换件与 soul 只读快照的电池。
 *
 * 前者钉住"只换压缩那一行,别的一个字不动";后者钉住**真实列名** ——
 * 我在这上面栽过:`episodic_memory` 没有 `created_at`(是
 * timestamp/occurred_at/learned_at),所以拿真库跑一遍 SQL 是必要的,
 * 光看代码看不出来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  patchPresetComposition, presetMetadata, DEFAULT_ENTRY_NAME,
  DEFAULT_THRESHOLD_RATIO, DEFAULT_RETAIN_RATIO
} from '../lib/preset-patch.js'
import {
  readSoulSnapshot, fallbackText, dbPathOf,
  capThreadsByKind, THREAD_KIND_MAX_AGE_SEC, THREAD_KIND_CAPS
} from '../lib/soul-snapshot.js'

/** 出厂组合里 compaction 域那几行的真形状(装机版 standard/agent.cordis.yml:138-155)。 */
const FIXTURE = [
  '# ── compaction ──────────────────────────────',
  '- id: compaction',
  '  name: cordis:group',
  '  group: true',
  '  isolate:',
  '    compaction: true',
  '    toolResultPruner: true',
  '  config:',
  "    - id: compaction-basic",
  "      name: '@deepseek-ai/dsh-compaction-basic'",
  '',
  '    - id: command-compact',
  "      name: '@deepseek-ai/dsh-command-compact'",
  '',
  '    - id: tool-result-pruner',
  "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
  '      config:',
  '        thresholdChars: 8192',
  ''
].join('\n')

test('预设替换:只动 compaction-basic 那两行,其余逐字保留', () => {
  const out = patchPresetComposition(FIXTURE)
  assert.equal(out.changed, true)
  assert.equal(out.reason, 'patched')
  assert.equal(out.text.includes('compaction-basic'), false, '出厂那行要被换掉')
  assert.ok(out.text.includes("    - id: compaction-echo\n      name: " + DEFAULT_ENTRY_NAME))
  assert.ok(out.text.includes('thresholdRatio: ' + DEFAULT_THRESHOLD_RATIO))
  assert.ok(out.text.includes('retainRatio: ' + DEFAULT_RETAIN_RATIO))
  // 别的行一个都没动:把被换掉的那一段掐掉,前后两半必须逐字相同
  const cut = (s, start, end) => [s.slice(0, s.indexOf(start)), s.slice(s.indexOf(end))]
  const [aHead, aTail] = cut(out.text, '    - id: compaction-echo', '\n\n    - id: command-compact')
  const [bHead, bTail] = cut(FIXTURE, '    - id: compaction-basic', '\n\n    - id: command-compact')
  assert.equal(aHead, bHead, '换掉那段之前的每个字符都该一样')
  assert.equal(aTail, bTail, '换掉那段之后的每个字符都该一样')
})

test('预设替换:命令 / 修剪器 / 隔离域都留着(它们与后端无关)', () => {
  const out = patchPresetComposition(FIXTURE)
  for (const keep of ['command-compact', 'tool-result-pruner', 'isolate:', 'compaction: true', 'thresholdChars: 8192']) {
    assert.ok(out.text.includes(keep), keep + ' 被误删了')
  }
})

test('预设替换:幂等 —— 已经换过的不再动', () => {
  const once = patchPresetComposition(FIXTURE)
  const twice = patchPresetComposition(once.text)
  assert.equal(twice.changed, false)
  assert.equal(twice.reason, 'already-patched')
  assert.equal(twice.text, once.text)
})

test('预设替换:找不到出厂那两行时**明确报出来**(宿主换挂法了,别悄悄写错)', () => {
  const out = patchPresetComposition('- id: compaction\n  name: cordis:group\n')
  assert.equal(out.changed, false)
  assert.equal(out.reason, 'stock-entry-not-found')
  assert.equal(out.text, '- id: compaction\n  name: cordis:group\n')
})

test('预设替换:空输入不当成改成功', () => {
  assert.equal(patchPresetComposition('').reason, 'empty')
  assert.equal(patchPresetComposition(null).changed, false)
})

test('预设元数据:roster 要的三行都在', () => {
  const meta = presetMetadata({ name: 'X', description: 'Y', order: 9 })
  assert.ok(meta.includes('name: X'))
  assert.ok(meta.includes('description: Y'))
  assert.ok(meta.includes('order: 9'))
})

// ---- soul 只读快照:真库真列名 ----

function fixtureDb () {
  const dir = mkdtempSync(join(tmpdir(), 'echo-soul-'))
  const path = join(dir, 't.db')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE user_profile (user_id TEXT PRIMARY KEY, name TEXT, core_traits TEXT, affinity INTEGER, emotion_state TEXT, last_updated REAL);
    CREATE TABLE episodic_memory (memory_id INTEGER PRIMARY KEY, user_id TEXT, keywords TEXT, summary TEXT, emotion_score REAL, timestamp REAL, is_active INTEGER, intrinsic_value REAL, recall_count INTEGER);
    CREATE TABLE pending_threads (thread_id INTEGER PRIMARY KEY, user_id TEXT, content TEXT, status TEXT, follow_up_after REAL, session_id TEXT, kind TEXT, cooling_at REAL, created_at REAL, updated_at REAL, archived_at REAL, last_mentioned_at REAL);
    CREATE TABLE agent_state (session_id TEXT, mood_intensity REAL, user_emotion TEXT, mood_reason TEXT, emotion_vector TEXT, updated_at REAL);
    CREATE TABLE conversation_log (turn_id INTEGER PRIMARY KEY, session_id TEXT, channel TEXT, user_text TEXT, reply_text TEXT, created_at REAL);
    CREATE TABLE graph_nodes (node_id INTEGER PRIMARY KEY, name TEXT, node_type TEXT, is_active INTEGER);
  `)
  db.prepare('INSERT INTO user_profile VALUES (?,?,?,?,?,?)')
    .run('master', '阿岚', '{"语言":"中文"}', 50, 'neutral', 1790361736)
  db.prepare('INSERT INTO episodic_memory VALUES (?,?,?,?,?,?,?,?,?)')
    .run(1, 'master', '跑步', '他说三公里跑欠着', 8.0, 1790360000, 1, 7.0, 2)
  db.prepare('INSERT INTO episodic_memory VALUES (?,?,?,?,?,?,?,?,?)')
    .run(2, 'master', '旧事', '很久以前的琐事', 1.0, 1700000000, 0, 0.1, 0)
  db.prepare('INSERT INTO pending_threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(2, 'master', '三公里跑要补', 'open', 1790450000, 's1', 'promise', 0, 1790360000, 1790360000, 0, 0)
  db.prepare('INSERT INTO agent_state VALUES (?,?,?,?,?,?)')
    .run('s1', 6.0, '疲惫', '他加班到很晚', '{}', 1790361700)
  db.prepare('INSERT INTO conversation_log VALUES (?,?,?,?,?,?)').run(1, 's1', 'QQ', '在吗', '在', 1790360000)
  db.prepare('INSERT INTO conversation_log VALUES (?,?,?,?,?,?)').run(2, 's1', 'DSH', '嗯', '嗯嗯', 1790361736)
  db.prepare('INSERT INTO graph_nodes VALUES (?,?,?,?)').run(1, '他怕疼', 'belief', 1)
  db.close()
  return { path, dir }
}

test('快照:按真列名取到画像/计数/悬置/记忆/情绪', () => {
  const { path, dir } = fixtureDb()
  try {
    const snap = readSoulSnapshot(path, 1790361736)
    assert.equal(snap.profile.name, '阿岚')
    assert.equal(snap.counts.memories, 1, 'is_active=1 才算(停用的那条不算)')
    assert.equal(snap.counts.beliefs, 1)
    assert.equal(snap.counts.turns, 2)
    assert.equal(snap.counts.firstAt, 1790360000)
    assert.equal(snap.counts.lastAt, 1790361736)
    assert.equal(snap.threads.length, 1)
    assert.equal(snap.threads[0].content, '三公里跑要补')
    assert.equal(snap.moments.length, 1, 'summary 为空/停用的不进来')
    assert.equal(snap.moments[0].summary, '他说三公里跑欠着')
    assert.equal(snap.mood.user_emotion, '疲惫')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('夹具守卫:夹具表必须有模块真正会读的那些列(防 many() 把列名错静默吞掉)', () => {
  // 现场:2026-10-06 D3 给 SQL 加了 `last_mentioned_at`,夹具表没有这一列 ⇒
  // `many()` 的 `catch → []` 把 "no such column" 吞了,快照静默变空、测试只说
  // "threas 少了" —— 这类静默失败最难查。所以这里把"读哪些列"钉死。
  const { path, dir } = fixtureDb()
  const db = new DatabaseSync(path)
  try {
    const cols = db.prepare('PRAGMA table_info(pending_threads)').all().map((r) => r.name)
    for (const need of ['content', 'status', 'follow_up_after', 'created_at', 'updated_at',
      'kind', 'cooling_at', 'archived_at', 'last_mentioned_at']) {
      assert.ok(cols.includes(need), '夹具的 pending_threads 少了 ' + need + '(模块会读它)')
    }
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('快照:库不存在 → {} (调用方走 fallback),不抛', () => {
  const snap = readSoulSnapshot(join(tmpdir(), 'echo-not-there-' + Date.now() + '.db'))
  assert.deepEqual(snap, {})
  assert.ok(fallbackText().includes('压缩备忘'))
  assert.ok(fallbackText().trim() !== '')
})

test('快照:表缺了也不抛(单条查询失败退化成空)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-soul-bare-'))
  const path = join(dir, 'b.db')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE user_profile (user_id TEXT, name TEXT, core_traits TEXT, affinity INTEGER)')
  db.prepare('INSERT INTO user_profile VALUES (?,?,?,?)').run('master', '阿岚', null, 50)
  db.close()
  try {
    const snap = readSoulSnapshot(path, 1790361736)
    assert.equal(snap.profile.name, '阿岚')
    assert.equal(snap.counts.memories, 0)
    assert.deepEqual(snap.threads, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('D3 与门:冷却 / 归档 / 未分类 / 过龄的一律不进注入快照', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-soul-d3-'))
  const path = join(dir, 'd3.db')
  const db = new DatabaseSync(path)
  const NOW = 1790361736
  const day = 86400
  db.exec(`
    CREATE TABLE user_profile (user_id TEXT PRIMARY KEY, name TEXT, core_traits TEXT, affinity INTEGER, emotion_state TEXT, last_updated REAL);
    CREATE TABLE episodic_memory (memory_id INTEGER PRIMARY KEY, user_id TEXT, keywords TEXT, summary TEXT, emotion_score REAL, timestamp REAL, is_active INTEGER, intrinsic_value REAL, recall_count INTEGER);
    CREATE TABLE pending_threads (thread_id INTEGER PRIMARY KEY, user_id TEXT, content TEXT, status TEXT, follow_up_after REAL, session_id TEXT, kind TEXT, last_mentioned_at REAL, created_at REAL, updated_at REAL, cooling_at REAL, archived_at REAL);
    CREATE TABLE agent_state (session_id TEXT, mood_intensity REAL, user_emotion TEXT, mood_reason TEXT, emotion_vector TEXT, updated_at REAL);
    CREATE TABLE conversation_log (turn_id INTEGER PRIMARY KEY, session_id TEXT, channel TEXT, user_text TEXT, reply_text TEXT, created_at REAL);
    CREATE TABLE graph_nodes (node_id INTEGER PRIMARY KEY, name TEXT, node_type TEXT, is_active INTEGER);
  `)
  const ins = db.prepare('INSERT INTO pending_threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
  const add = (id, text, kind, { fu = 0, created = NOW - day, cooling = 0, archived = 0, mentioned = 0, status = 'open' } = {}) =>
    ins.run(id, 'master', text, status, fu, 's1', kind, mentioned, created, NOW - day, cooling, archived)
  add(1, '活跃-承诺', 'promise')
  add(2, '活跃-日程', 'schedule', { fu: NOW - 2 * 3600 })   // 已到期(过了 6h 宽限才会冷却,这里没过)
  add(3, '冷却的', 'promise', { cooling: NOW - day })
  add(4, '归档的', 'promise', { archived: NOW - day })
  add(5, '未分类的', '')
  add(6, '过龄承诺', 'promise', { created: NOW - 20 * day })
  add(7, '过龄关心', 'care', { created: NOW - 5 * day })
  add(8, '新关心', 'care', { created: NOW - day })
  add(9, '旧话题', 'topic', { created: NOW - 40 * day })
  add(10, '新话题', 'topic', { created: NOW - day })
  db.close()
  try {
    const snap = readSoulSnapshot(path, NOW)
    const got = snap.threads.map((t) => t.content)
    assert.deepEqual(got, ['活跃-日程', '活跃-承诺', '新关心', '新话题'], '只留活跃 × 有类别 × 类内时效')
    for (const bad of ['冷却的', '归档的', '未分类的', '过龄承诺', '过龄关心', '旧话题']) {
      assert.ok(!got.includes(bad), bad + ' 不该进注入快照')
    }
    // 行上带 kind / updated_at(curation 要用)
    assert.equal(snap.threads[0].kind, 'schedule')
    assert.ok(snap.threads[0].updated_at > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('D3 配额:同类最多占几席(topic ≤2 / schedule ≤2 / care ≤1)', () => {
  assert.deepEqual(THREAD_KIND_CAPS, { topic: 2, schedule: 2, care: 1 })
  const mk = (kind, n) => Array.from({ length: n }, (_, i) => ({ kind, content: kind + '-' + i }))
  const capped = capThreadsByKind([...mk('topic', 4), ...mk('schedule', 3), ...mk('care', 3), ...mk('promise', 3)])
  const count = (k) => capped.filter((r) => r.kind === k).length
  assert.equal(count('topic'), 2)
  assert.equal(count('schedule'), 2)
  assert.equal(count('care'), 1)
  assert.equal(count('promise'), 3, '没列到的类不限')
  assert.deepEqual(THREAD_KIND_MAX_AGE_SEC, { promise: 14 * 86400, care: 3 * 86400, topic: 30 * 86400 })
  // 顺序保持(配额只丢超出的,不重排)
  assert.equal(capped[0].content, 'topic-0')
  assert.equal(capped[capped.length - 1].content, 'promise-2')
})

test('快照:只读打开 —— 绝不写库(文件 mtime 不变)', async () => {
  const { path, dir } = fixtureDb()
  try {
    const before = (await import('node:fs')).statSync(path).mtimeMs
    readSoulSnapshot(path, 1790361736)
    const after = (await import('node:fs')).statSync(path).mtimeMs
    assert.equal(after, before, '只读快照不许改库(写是 lib/index.js 的事)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('库路径:与 lib/index.js 同一套解析(DSH_HOME/echo/echo.db)', () => {
  const old = process.env.ECHO_DB
  try {
    process.env.ECHO_DB = 'C:/tmp/x.db'
    assert.equal(dbPathOf(), 'C:/tmp/x.db')
  } finally {
    if (old === undefined) delete process.env.ECHO_DB
    else process.env.ECHO_DB = old
  }
  assert.ok(dbPathOf().endsWith(join('echo', 'echo.db')))
})

// ---- 打包/挂载契约(静态:宿主耦合的那个文件不 import,只看它写了什么)----

test('契约:exports 里必须有 ./compaction,且指向真文件', async () => {
  const { readFileSync, existsSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  assert.equal(pkg.exports['./compaction'], './lib/compaction.js')
  assert.ok(existsSync(fileURLToPath(new URL('../lib/compaction.js', import.meta.url))))
  assert.ok(pkg.files.includes('lib/') && pkg.files.includes('scripts/'),
    'exports 指的 lib/ 与生成预设的 scripts/ 都得进分发包')
})

test('契约:EchoCompactionEngine 只覆写宿主那一个钩子,签名是三个参数', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(fileURLToPath(new URL('../lib/compaction.js', import.meta.url)), 'utf8')
  assert.ok(src.includes('class EchoCompactionEngine extends BasicCompactionEngine'))
  assert.ok(src.includes('async summarize (input, agent, signal)'),
    '装机版钩子是 3 个参数(不是 03 §8 猜的 5 个)')
  assert.ok(src.includes('static inject = [...BasicCompactionEngine.inject]'))
  // 零额外 LLM 调用:不许出现 llm.stream / summarizeWithLlm
  assert.equal(src.includes('llm.stream'), false)
  assert.equal(src.includes('summarizeWithLlm'), false)
  // 溯源诚实
  assert.ok(src.includes("CURATION_PROVIDER = 'dsh-echo'") && src.includes("CURATION_MODEL = 'soul-curation'"))
  // 只读库
  assert.ok(src.includes('readSoulSnapshot'))
  assert.ok(readFileSync(fileURLToPath(new URL('../lib/soul-snapshot.js', import.meta.url)), 'utf8')
    .includes('{ readOnly: true }'), 'soul 库只读打开')
})

test('契约:生成预设的脚本在,且写的是宿主认的目录 .agent-presets', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const src = readFileSync(fileURLToPath(new URL('../scripts/install-preset.mjs', import.meta.url)), 'utf8')
  assert.ok(src.includes("'.agent-presets'"), '与 dsh-agent-presets 的 USER_PRESET_DIR 同名')
  assert.ok(src.includes('--check') && src.includes('--remove'))
  assert.ok(src.includes('preset.yml'), 'roster 元数据也要写')
})
