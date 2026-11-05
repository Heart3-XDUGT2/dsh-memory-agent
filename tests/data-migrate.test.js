/**
 * dsh-echo — P3 迁移执行器(lib/data-migrate.js)+ 记账写入口(lib/data-dir.js)
 * ============================================================
 * 全部在**临时目录**里跑(绝不碰 ~/.dsh/echo);每个用例自己建、自己删。
 *
 * 盯住 P3 设计 §4.3 的三条幂等规则 + §5.2 的验收断言:
 *   ① 门先判:同一个键跑两遍只生效一次,第二遍**零写盘**;
 *   ② 写前快照:摘要 before/after 相等 ⇒ 不写文件、只记账;
 *   ③ 失败不记账:写盘失败 ⇒ 不 append 这个键,`notes` 追一行,下次重试。
 * 外加两条本批才有的约束:
 *   ④ **首次安装 ⇒ 全部跳过并登记**(没有可导的旧值),而 dataDirStatus 仍要零问题;
 *   ⑤ P3 **不** bump `schemaRev`/`dataRev`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DATA_FILES, DATA_REV_FILE, PROGRAM_DATA_REV, validateFile } from '../lib/data-schema.js'
import {
  KNOWN_MIGRATIONS, appendAppliedMigrations, dataDirStatus, ensureDataDir, firstInstallOf
} from '../lib/data-dir.js'
import { MIGRATION_TARGETS, migrateDataDir, planMigrations } from '../lib/data-migrate.js'
import { writeDataFile } from '../lib/data-write.js'

/** 脚手架注入的时间(ISO;ensureDataDir 收函数、migrateDataDir 收字符串)。 */
const FIXED = '2026-10-05T12:00:00.000Z'
const FIXED2 = '2026-10-05T13:00:00.000Z'
const NOW_FN = () => FIXED

function tempDir () {
  return mkdtempSync(join(tmpdir(), 'echo-data-migrate-'))
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

/** 8 个数据文件的 sha + mtime(记账文件**不在内** —— 它本来就会被追加)。 */
function snapData (dir) {
  const out = {}
  for (const name of DATA_FILES) {
    const p = join(dir, name)
    out[name] = { sha: sha(p), mtime: statSync(p).mtimeMs }
  }
  return out
}

function assertDataUntouched (dir, before, why) {
  for (const name of DATA_FILES) {
    assert.equal(sha(join(dir, name)), before[name].sha, name + ' 内容被改过(' + why + ')')
    assert.equal(statSync(join(dir, name)).mtimeMs, before[name].mtime, name + ' mtime 变过 —— 说明写了(' + why + ')')
  }
}

const readRev = (dir) => JSON.parse(readFileSync(join(dir, DATA_REV_FILE), 'utf8'))

/** 建一份"刚 scaffold 完"的空目录(与挂载链一致:先 ensureDataDir,再迁移)。 */
async function scaffold (dir) {
  await ensureDataDir({ dir, now: NOW_FN })
}

/** 造一份"他填过东西"的目录:先 scaffold,再把 lexicon 写成非空 ⇒ 不算首装。 */
async function scaffoldFilled (dir, lexicon) {
  await scaffold(dir)
  writeFileSync(join(dir, 'lexicon.json'), JSON.stringify({ schemaRev: PROGRAM_DATA_REV, ...lexicon }, null, 2), 'utf8')
}

// ---------------------------------------------------------------- ⓪ 键集与目标位置

test('P3:17 个键与目标位置一一对上,一个不多一个不少(改了键名=重新跑一遍)', () => {
  assert.equal(KNOWN_MIGRATIONS.length, 17)
  assert.equal(new Set(KNOWN_MIGRATIONS).size, 17, '不许有重键')
  assert.ok(Object.isFrozen(KNOWN_MIGRATIONS))
  for (const key of KNOWN_MIGRATIONS) {
    assert.match(key, /^p3\.[a-z0-9-]+$/, '键名必须是小写 ASCII:' + key)
    assert.ok(MIGRATION_TARGETS[key] !== undefined, '没登记目标位置:' + key)
    assert.ok(MIGRATION_TARGETS[key].file === null || DATA_FILES.includes(MIGRATION_TARGETS[key].file),
      key + ' 指向了不在白名单里的文件')
  }
  assert.equal(Object.keys(MIGRATION_TARGETS).length, 17)
})

// ---------------------------------------------------------------- ① 门先判 / 首装

test('迁移:首装空目录 ⇒ 全部跳过并登记,8 个数据文件一个字节不动', async () => {
  const dir = tempDir()
  try {
    await scaffold(dir)
    const before = snapData(dir)
    const r = migrateDataDir({ dir, now: FIXED })

    assert.equal(r.ok, true)
    assert.equal(r.firstInstall, true, '空模板目录必须认出"首次安装"')
    assert.deepEqual(r.registered, [...KNOWN_MIGRATIONS], '17 个键要全部登记')
    assert.deepEqual(r.failed, [])
    assert.deepEqual(r.wrote, [], '首装没有可导的旧值 ⇒ 一个文件都不许写')
    assertDataUntouched(dir, before, '首装迁移')

    const rev = readRev(dir)
    assert.deepEqual(rev.appliedMigrations, [...KNOWN_MIGRATIONS])
    assert.equal(rev.dataRev, PROGRAM_DATA_REV, 'P3 不 bump dataRev')
    assert.equal(rev.createdAt, FIXED, 'createdAt 是首次创建时间,追加记账不许动它')
    assert.equal(rev.notes.length, 17, '逐条要留一行人话')
    for (const key of KNOWN_MIGRATIONS) {
      const line = rev.notes.find((n) => n.includes(' ' + key + ': '))
      assert.ok(line !== undefined, '缺 ' + key + ' 的 note')
      assert.ok(line.startsWith(FIXED + ' '), 'note 要带时间戳:' + line)
      assert.ok(line.includes('首次安装'), '首装的 note 要写明为什么跳过:' + line)
    }
    assert.equal(validateFile(DATA_REV_FILE, rev).ok, true, '记账文件自己必须过校验')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('迁移:同一批跑两遍只生效一次(第二遍连记账文件都不写)', async () => {
  const dir = tempDir()
  try {
    await scaffold(dir)
    const first = migrateDataDir({ dir, now: FIXED })
    assert.equal(first.registered.length, 17)
    const before = snapData(dir)
    const revBefore = sha(join(dir, DATA_REV_FILE))

    const second = migrateDataDir({ dir, now: FIXED2 })
    assert.equal(second.ok, true)
    assert.deepEqual(second.registered, [])
    assert.deepEqual(second.planned, [])
    assert.equal(second.skipped.length, 17, '已登记的键走 skipped 这条路')
    assert.deepEqual(second.notes, [], '没什么可记的就不留 note')
    assertDataUntouched(dir, before, '第二遍')
    assert.equal(sha(join(dir, DATA_REV_FILE)), revBefore, '第二遍不该碰记账文件(连 lastCheckAt 都不刷新)')
    assert.deepEqual(readRev(dir).appliedMigrations, [...KNOWN_MIGRATIONS])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('迁移:目标字段已有值 ⇒ 一字不动 + 补记账(永不覆盖用户文件)', async () => {
  const dir = tempDir()
  try {
    // stopwords 是他从面板填过的 ⇒ 这一条"目标字段已有值"
    await scaffoldFilled(dir, { stopwords: ['他填的'] })
    const before = snapData(dir)
    const r = migrateDataDir({ dir, now: FIXED })

    assert.equal(r.firstInstall, false, '填过东西就不算首装')
    assert.equal(r.ok, true)
    assert.equal(r.wrote.length, 0, '本批不搬值 ⇒ 不该写盘')
    assertDataUntouched(dir, before, '本批不搬值')
    const rev = readRev(dir)
    assert.deepEqual(rev.appliedMigrations, [...KNOWN_MIGRATIONS], '一字不动也要登记(不然每次开机重算)')
    const line = rev.notes.find((n) => n.includes('p3.lexicon-stopwords:'))
    assert.ok(line.includes('已有值'), '要明说"已有值 ⇒ 一字不动":' + line)
    assert.equal(JSON.parse(readFileSync(join(dir, 'lexicon.json'), 'utf8')).stopwords[0], '他填的')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- ② 写前快照

test('迁移:摘要 before/after 相等 ⇒ 不写文件、只记账(注入同值也不许落盘)', async () => {
  const dir = tempDir()
  try {
    await scaffoldFilled(dir, { topicStopwords: ['他填的'] })
    const before = snapData(dir)
    const calls = []
    // 值来源"照抄现值" ⇒ 摘要相等 ⇒ 走的是②,不是写盘
    const r = migrateDataDir({
      dir,
      now: FIXED,
      desiredOf: (key, info) => (key === 'p3.lexicon-topic-stopwords' ? info.current : undefined),
      writeFile: (name) => calls.push(name)
    })
    assert.equal(r.ok, true)
    assert.deepEqual(calls, [], '摘要相等却调了写口 = 幂等破了')
    assert.deepEqual(r.wrote, [])
    assertDataUntouched(dir, before, '摘要相等')
    assert.deepEqual(readRev(dir).appliedMigrations, [...KNOWN_MIGRATIONS])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('迁移:摘要真的变了才落盘,而且走唯一写路径(留下 backup/)', async () => {
  const dir = tempDir()
  try {
    await scaffoldFilled(dir, { stopwords: ['他填的'] })
    const seen = []
    // 落盘口照跑真的写路径,但顺手记一笔"传下来的 dir" ——
    // 曾经漏传 ⇒ writeDataFile 用它自己的默认值,把垃圾写进他**真实的数据目录**。
    const r = migrateDataDir({
      dir,
      now: FIXED,
      desiredOf: (key) => (key === 'p3.lexicon-topic-stopwords' ? ['今天', '明天'] : undefined),
      writeFile: (name, obj, opts) => { seen.push({ name, dir: opts?.dir }); writeDataFile(name, obj, opts) }
    })
    assert.equal(r.ok, true)
    assert.deepEqual(seen, [{ name: 'lexicon.json', dir }], '写口必须拿到本次的 dir,不许落到默认数据目录')
    assert.deepEqual(r.wrote, ['lexicon.json'])
    const lex = JSON.parse(readFileSync(join(dir, 'lexicon.json'), 'utf8'))
    assert.deepEqual(lex.topicStopwords, ['今天', '明天'])
    assert.deepEqual(lex.stopwords, ['他填的'], '别的字段一个字节不许动')
    assert.equal(lex.schemaRev, PROGRAM_DATA_REV, 'P3 不 bump schemaRev')
    assert.equal(validateFile('lexicon.json', lex).ok, true, '写下去的东西必须过校验')
    // 唯一写路径 = lib/data-write.js 的 writeDataFile ⇒ 它会先备份
    const baks = readdirSync(join(dir, 'backup'))
    assert.ok(baks.some((f) => f.startsWith('lexicon.json.') && f.endsWith('.bak')), '没留备份 = 绕过写路径了')
    assert.ok(readRev(dir).appliedMigrations.includes('p3.lexicon-topic-stopwords'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- ③ 失败不记账

test('迁移:写失败 ⇒ 不记账 + notes 一行,下次开机重试就补上', async () => {
  const dir = tempDir()
  try {
    await scaffoldFilled(dir, { stopwords: ['他填的'] })
    const KEY = 'p3.lexicon-topic-stopwords'
    const boom = migrateDataDir({
      dir,
      now: FIXED,
      desiredOf: (key) => (key === KEY ? ['今天'] : undefined),
      writeFile: () => { throw new Error('盘满了') }
    })
    assert.equal(boom.ok, false)
    assert.ok(boom.failed.some((f) => f.key === KEY && f.reason.includes('盘满了')), '失败要指名报出来')
    const rev = readRev(dir)
    assert.ok(!rev.appliedMigrations.includes(KEY), '写失败还记账 = 下次再也不会重试')
    assert.equal(rev.appliedMigrations.length, 16, '其它 16 个成功的键照常登记')
    assert.ok(rev.notes.some((n) => n.includes(KEY) && n.includes('失败 ⇒ 不记账')), 'notes 里要留一行原因')

    // 下次开机(盘好了)⇒ 重试成功,补齐 17 个(重试的那个键追加在末尾 —— 记账只往后接)
    const again = migrateDataDir({
      dir,
      now: FIXED2,
      desiredOf: (key) => (key === KEY ? ['今天'] : undefined)
    })
    assert.equal(again.ok, true)
    assert.deepEqual(again.registered, [KEY])
    assert.deepEqual([...readRev(dir).appliedMigrations].sort(), [...KNOWN_MIGRATIONS].sort())
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('迁移:记账文件写不进去 ⇒ 一个键都不记下(下次开机整批重来)', async () => {
  const dir = tempDir()
  try {
    await scaffold(dir)
    rmSync(join(dir, DATA_REV_FILE))
    mkdirSync(join(dir, DATA_REV_FILE))  // 占位成目录 ⇒ 记账落盘必失败
    const r = migrateDataDir({ dir, now: FIXED })
    assert.equal(r.ok, false)
    assert.deepEqual(r.registered, [], '记账失败 ⇒ 一个键都没记下')
    assert.ok(r.failed.some((f) => f.key === DATA_REV_FILE))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- ④ 干跑 + 体检口径

test('迁移:干跑只报计划,一个字节都不写', async () => {
  const dir = tempDir()
  try {
    await scaffold(dir)
    const before = snapData(dir)
    const revBefore = sha(join(dir, DATA_REV_FILE))
    const plan = planMigrations({ dir })
    assert.equal(plan.firstInstall, true)
    assert.deepEqual(plan.pending, [...KNOWN_MIGRATIONS])
    assert.deepEqual(plan.done, [])

    const dry = migrateDataDir({ dir, now: FIXED, dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.deepEqual(dry.planned, [...KNOWN_MIGRATIONS])
    assert.deepEqual(dry.registered, [])
    assert.equal(dry.notes.length, 17, '干跑要逐条说"会做什么"')
    assertDataUntouched(dir, before, '干跑')
    assert.equal(sha(join(dir, DATA_REV_FILE)), revBefore, '干跑不许碰记账文件')
    assert.deepEqual(readRev(dir).appliedMigrations, [], '干跑后记账还是空的')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('体检:刚 scaffold 完 + 迁完都零问题;pending 只在 dataRev 落后时才报', async () => {
  const dir = tempDir()
  try {
    await scaffold(dir)
    // 既有断言口径(tests/data-dir.test.js:264/:268):刚建完的目录零问题、pending 为空
    const fresh = dataDirStatus({ dir })
    assert.deepEqual(fresh.problems, [], '刚 scaffold 完的目录应当零问题')
    assert.deepEqual(fresh.pendingMigrations, [], '首装不是"落后",不该报 pending')

    migrateDataDir({ dir, now: FIXED })
    const done = dataDirStatus({ dir })
    assert.deepEqual(done.problems, [], '迁完仍要零问题')
    assert.deepEqual(done.pendingMigrations, [])
    assert.equal(done.dataRev.appliedMigrations.length, 17)

    // 版本位真落后(老目录 + 新程序)⇒ pending 照旧报得出来(这条口没被删掉)
    writeFileSync(join(dir, DATA_REV_FILE),
      JSON.stringify({ dataRev: PROGRAM_DATA_REV - 1, appliedMigrations: [], notes: [] }, null, 2), 'utf8')
    const stale = dataDirStatus({ dir })
    assert.equal(stale.dataRevStale, true)
    assert.equal(stale.pendingMigrations.length, 17)
    assert.ok(stale.problems.some((p) => p.includes('一次性迁移没应用')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- ⑤ 追加写入口

test('记账:追加绝不覆盖别人的键、不 bump 版本位,没新东西就不写盘', async () => {
  const dir = tempDir()
  try {
    await scaffold(dir)
    writeFileSync(join(dir, DATA_REV_FILE), JSON.stringify({
      dataRev: PROGRAM_DATA_REV,
      createdAt: FIXED,
      appliedMigrations: ['p0.别人记的', 'p3.lexicon-stopwords'],
      lastCheckAt: FIXED,
      notes: ['2026-01-01T00:00:00.000Z p0.别人记的: 别人的一行']
    }, null, 2), 'utf8')

    const r = appendAppliedMigrations(
      ['p3.lexicon-stopwords', 'p3.graph-display-tuning', 'p3.graph-display-tuning', '', null, 7],
      { dir, now: FIXED2, notes: [FIXED2 + ' p3.graph-display-tuning: 新一行'] }
    )
    assert.equal(r.ok, true)
    assert.equal(r.wrote, true)
    assert.deepEqual(r.added, ['p3.graph-display-tuning'], '重键/空值/非字符串都要滤掉')
    const rev = readRev(dir)
    assert.deepEqual(rev.appliedMigrations, ['p0.别人记的', 'p3.lexicon-stopwords', 'p3.graph-display-tuning'],
      '别人的键要原序保留,新的往后接')
    assert.deepEqual(rev.notes, ['2026-01-01T00:00:00.000Z p0.别人记的: 别人的一行',
      FIXED2 + ' p3.graph-display-tuning: 新一行'])
    assert.equal(rev.dataRev, PROGRAM_DATA_REV, '追加不是改版')
    assert.equal(rev.createdAt, FIXED)

    // 幂等:同一个键再追加一次 ⇒ 不写盘(连 mtime 都不动)
    const beforeSha = sha(join(dir, DATA_REV_FILE))
    const again = appendAppliedMigrations(['p3.graph-display-tuning'], { dir, now: '2026-10-05T14:00:00.000Z' })
    assert.equal(again.wrote, false)
    assert.equal(sha(join(dir, DATA_REV_FILE)), beforeSha)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('首装判据:空模板 ⇒ 首装;填过一个字段 ⇒ 不是首装(filled 报得出是哪个)', async () => {
  const dir = tempDir()
  try {
    await scaffold(dir)
    assert.deepEqual(firstInstallOf({ dir }), { firstInstall: true, filled: [] })
    writeFileSync(join(dir, 'names.json'),
      JSON.stringify({ schemaRev: PROGRAM_DATA_REV, speakers: ['谁'] }, null, 2), 'utf8')
    const fi = firstInstallOf({ dir })
    assert.equal(fi.firstInstall, false)
    assert.deepEqual(fi.filled, ['names.json.speakers'])
    // 只有结构记账的键(schemaRev)不算"填过"
    writeFileSync(join(dir, 'names.json'), JSON.stringify({ schemaRev: PROGRAM_DATA_REV }, null, 2), 'utf8')
    assert.equal(firstInstallOf({ dir }).firstInstall, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('迁移:目录建不出来时不抛错(与 ensureDataDir 同姿势,挂载不受影响)', () => {
  const base = tempDir()
  try {
    const blocker = join(base, '这是个文件')
    writeFileSync(blocker, 'x', 'utf8')
    const dir = join(blocker, 'echo')
    let threw = null
    let out = null
    try { out = migrateDataDir({ dir, now: FIXED }) } catch (err) { threw = err }
    assert.equal(threw, null, '迁移执行器不许抛错')
    assert.equal(out.ok, false)
    assert.deepEqual(out.registered, [])
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('迁移:坏/缺的数据文件按"空"处理,不判坏也不抛(风险 2)', async () => {
  const dir = tempDir()
  try {
    await scaffoldFilled(dir, {})
    rmSync(join(dir, 'graph.json'))
    writeFileSync(join(dir, 'names.json'), '{ 这不是 JSON', 'utf8')
    const r = migrateDataDir({ dir, now: FIXED })
    assert.equal(r.ok, true)
    assert.deepEqual(r.registered.length, 17)
    assert.ok(!existsSync(join(dir, 'graph.json')), '迁移不负责补文件(scaffold 的事)')
    assert.equal(JSON.parse(readFileSync(join(dir, 'lexicon.json'), 'utf8')).schemaRev, PROGRAM_DATA_REV)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
