/**
 * dsh-echo — 数据目录 scaffold(P0)
 * ============================================================
 * 全部在**临时目录**里跑(绝不碰 ~/.dsh/echo);每个用例自己建、自己删。
 *
 * 盯住 P0 的四条纪律:
 *   ① 空目录 ⇒ 8 个空模板 + backup/ + data-rev.json,幂等;
 *   ② **绝不覆盖用户文件**(存在的合法文件:内容与 mtime 一个字节都不变);
 *   ③ 读不出来的文件才允许留档重建(原文进 .bad-*,不丢字节);语义错**原样保留**;
 *   ④ 写盘失败**不抛错**(只记 warn + 回在返回值里)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync
} from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { DATA_FILES, DATA_REV_FILE, PROGRAM_DATA_REV, emptyTemplate, validateFile } from '../lib/data-schema.js'
import {
  dataDirStatus, describeEnsureResult, ensureDataDir, resolveConfigPath, resolveDataFilePath,
  resolveDataDir, resolveDbPath, resolvePersonaPath
} from '../lib/data-dir.js'

const FIXED = '2026-10-05T12:00:00.000Z'
const now = () => FIXED
const BACKUP = 'backup'

function tempDir () {
  return mkdtempSync(join(tmpdir(), 'echo-data-dir-'))
}

/** 跑一遍并把该收的都收掉(测试里不关心 logger 输出,只关心 warn 被调用过没有)。 */
function run (dir, opts = {}) {
  const warns = []
  const infos = []
  return ensureDataDir({
    dir,
    now,
    logger: { warn: (m) => warns.push(String(m)), info: (m) => infos.push(String(m)) },
    ...opts
  }).then((r) => ({ r, warns, infos }))
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function listDir (dir) {
  return readdirSync(dir).sort()
}

// ---------------------------------------------------------------- ① 建 + 幂等

test('空目录:建 8 个空模板 + backup/ + data-rev.json', async () => {
  const dir = tempDir()
  try {
    const { r, warns } = await run(dir)
    assert.equal(r.ok, true)
    assert.deepEqual(r.created, [...DATA_FILES], 'created 应当是全部 8 个')
    assert.deepEqual(r.validated, [])
    assert.deepEqual(r.failed, [])
    assert.deepEqual(warns, [], '干净目录不该有 warn')

    // 8 个文件都在,而且内容就是空模板(逐字节比)
    for (const name of DATA_FILES) {
      const p = join(dir, name)
      assert.ok(existsSync(p), name + ' 没建出来')
      assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), emptyTemplate(name), name + ' 不是空模板')
    }
    assert.ok(existsSync(join(dir, 'backup')), 'backup/ 没建出来')
    assert.ok(statSync(join(dir, 'backup')).isDirectory())

    // 记账文件
    const rev = JSON.parse(readFileSync(join(dir, DATA_REV_FILE), 'utf8'))
    assert.deepEqual(rev, {
      dataRev: PROGRAM_DATA_REV,
      createdAt: FIXED,
      appliedMigrations: [],
      lastCheckAt: FIXED,
      notes: []
    })
    assert.equal(validateFile(DATA_REV_FILE, rev).ok, true)

    // 目录里除了这 8+1+backup 不该有别的东西(尤其没有 .bad-*)
    assert.deepEqual(listDir(dir), [...DATA_FILES, BACKUP, DATA_REV_FILE].sort())
    assert.equal(dataDirStatus({ dir }).badResidue.length, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('幂等:第二遍 created 空、validated 8 个,所有文件内容与 mtime 不变', async () => {
  const dir = tempDir()
  try {
    await run(dir)
    const before = {}
    for (const name of [...DATA_FILES, DATA_REV_FILE]) {
      before[name] = { sha: sha(join(dir, name)), mtime: statSync(join(dir, name)).mtimeMs }
    }
    const first = JSON.parse(readFileSync(join(dir, DATA_REV_FILE), 'utf8'))

    const { r, warns } = await run(dir)
    assert.deepEqual(r.created, [])
    assert.deepEqual(r.validated, [...DATA_FILES], '存在的文件走"只读校验"这条路')
    assert.deepEqual(r.failed, [])
    assert.deepEqual(warns, [], '缺 schemaRev 之类只算 info,不算 warn')

    for (const name of DATA_FILES) {
      assert.equal(sha(join(dir, name)), before[name].sha, name + ' 内容被改过')
      assert.equal(statSync(join(dir, name)).mtimeMs, before[name].mtime, name + ' mtime 变过(说明写了)')
    }
    const second = JSON.parse(readFileSync(join(dir, DATA_REV_FILE), 'utf8'))
    assert.equal(second.createdAt, first.createdAt, 'createdAt 是"首次创建时间",不该被刷新')
    assert.equal(second.dataRev, PROGRAM_DATA_REV)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('缺一个文件:只补那一个(其余 7 个进 validated)', async () => {
  const dir = tempDir()
  try {
    await run(dir)
    rmSync(join(dir, 'profile.json'))
    const { r } = await run(dir)
    assert.deepEqual(r.created, ['profile.json'])
    assert.equal(r.validated.length, 7)
    assert.ok(!r.validated.includes('profile.json'))
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')), emptyTemplate('profile.json'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- ② 绝不覆盖用户文件

test('绝不覆盖:已有的合法文件内容与 mtime 一字不变', async () => {
  const dir = tempDir()
  try {
    // 一份"用户填好的"人格与配置(合法、有内容)
    writeFileSync(join(dir, 'persona.json'),
      JSON.stringify({ prefix: '用户写的身份段', suffix: '用户写的规矩段', edited: true }, null, 2), 'utf8')
    writeFileSync(join(dir, 'config.json'),
      JSON.stringify({ enabled: false, settings: { auditKeep: 55 } }, null, 2), 'utf8')
    const keep = {
      'persona.json': { sha: sha(join(dir, 'persona.json')), mtime: statSync(join(dir, 'persona.json')).mtimeMs },
      'config.json': { sha: sha(join(dir, 'config.json')), mtime: statSync(join(dir, 'config.json')).mtimeMs }
    }

    const { r } = await run(dir)
    assert.equal(r.ok, true)
    assert.ok(r.validated.includes('persona.json'))
    assert.ok(r.validated.includes('config.json'))
    assert.deepEqual(r.created.length, DATA_FILES.length - 2)
    for (const name of ['persona.json', 'config.json']) {
      assert.equal(sha(join(dir, name)), keep[name].sha, name + ' 被改写了')
      assert.equal(statSync(join(dir, name)).mtimeMs, keep[name].mtime, name + ' mtime 变过(说明写了)')
    }
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'persona.json'), 'utf8')).prefix, '用户写的身份段')
    assert.equal(dataDirStatus({ dir }).badResidue.length, 0, '没坏文件就不该有 .bad 残留')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- ③ 坏文件 / 语义错

test('读不出来的文件:留档 .bad-<时间戳> + 重建空模板(原文不丢)', async () => {
  const dir = tempDir()
  try {
    await run(dir)
    const brokenText = '{ 这不是 JSON'
    writeFileSync(join(dir, 'names.json'), brokenText, 'utf8')
    const { r, warns } = await run(dir)
    const one = r.failed.find((f) => f.file === 'names.json')
    assert.ok(one !== undefined, '坏文件必须进 failed')
    assert.equal(one.action, 'renamed-and-rebuilt')
    assert.equal(one.kept, 'names.json.bad-' + FIXED.replace(/[:.]/g, '-'))
    assert.ok(warns.some((w) => w.includes('names.json')))
    // 原文留在 .bad 里(逐字节)
    assert.equal(readFileSync(join(dir, one.kept), 'utf8'), brokenText)
    // 新文件是空模板
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'names.json'), 'utf8')), emptyTemplate('names.json'))
    assert.deepEqual(dataDirStatus({ dir }).badResidue, [one.kept])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('顶层不是对象(写了个数组):算"读不出来",同样留档重建', async () => {
  const dir = tempDir()
  try {
    await run(dir)
    writeFileSync(join(dir, 'aliases.json'), '[]', 'utf8')
    const { r } = await run(dir)
    const one = r.failed.find((f) => f.file === 'aliases.json')
    assert.equal(one.action, 'renamed-and-rebuilt')
    assert.ok(one.reason.includes('顶层不是 JSON 对象'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('语义错(JSON 合法但字段不合规):**原样保留**,只报 warn', async () => {
  const dir = tempDir()
  try {
    await run(dir)
    const weird = JSON.stringify({ prefix: 'x'.repeat(9999), suffix: 'y' }, null, 2)
    writeFileSync(join(dir, 'persona.json'), weird, 'utf8')
    const before = sha(join(dir, 'persona.json'))
    const { r, warns } = await run(dir)
    const one = r.failed.find((f) => f.file === 'persona.json')
    assert.ok(one !== undefined)
    assert.equal(one.action, 'kept', '语义错不许动文件')
    assert.equal(sha(join(dir, 'persona.json')), before, '文件被改写了 —— 这正是要防的')
    assert.ok(warns.some((w) => w.includes('保持原样')))
    assert.deepEqual(dataDirStatus({ dir }).badResidue, [], '语义错不产生 .bad 残留')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- ④ 写盘失败不抛错

test('目录建不出来(父路径是个文件):不抛错,ok=false,记在 failed 里', async () => {
  const base = tempDir()
  try {
    const blocker = join(base, '这是个文件')
    writeFileSync(blocker, 'x', 'utf8')
    const dir = join(blocker, 'echo')  // 父路径不是目录 ⇒ mkdir 必失败
    let threw = null
    let out = null
    try { out = (await run(dir)).r } catch (err) { threw = err }
    assert.equal(threw, null, 'ensureDataDir 不许抛错')
    assert.equal(out.ok, false)
    assert.equal(out.failed[0].file, '(数据目录)')
    assert.deepEqual(out.created, [])
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('某个目标位置写不进去(data-rev.json 被占成目录):不抛错 + 记 failed', async () => {
  const dir = tempDir()
  try {
    await run(dir)
    rmSync(join(dir, DATA_REV_FILE))
    mkdirSync(join(dir, DATA_REV_FILE))  // 占位成目录 ⇒ 落盘必失败
    let threw = null
    let out = null
    try { out = (await run(dir)).r } catch (err) { threw = err }
    assert.equal(threw, null, 'ensureDataDir 不许抛错')
    assert.equal(out.ok, false)
    assert.equal(out.dataRev, null)
    assert.ok(out.failed.some((f) => f.file === DATA_REV_FILE), '失败的记账文件要报出来')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- ⑤ 体检 / 路径 / 人话

test('dataDirStatus:目录不存在 ⇒ 明确说"还没建"', () => {
  const base = tempDir()
  try {
    const st = dataDirStatus({ dir: join(base, '不存在') })
    assert.equal(st.exists, false)
    assert.equal(st.files.length, 0)
    assert.ok(st.problems.join('; ').includes('还不存在'))
  } finally { rmSync(base, { recursive: true, force: true }) }
})

test('dataDirStatus:就绪目录 ⇒ 零问题;缺文件/.bad 残留/记账落后都能报出来', async () => {
  const dir = tempDir()
  try {
    await run(dir)
    const okSt = dataDirStatus({ dir })
    assert.equal(okSt.exists, true)
    assert.equal(okSt.writable, true)
    assert.equal(okSt.backupExists, true)
    assert.deepEqual(okSt.problems, [], '刚 scaffold 完的目录应当零问题')
    assert.equal(okSt.files.length, 8)
    assert.ok(okSt.files.every((f) => f.ok))
    assert.equal(okSt.dataRevStale, false)
    assert.deepEqual(okSt.pendingMigrations, [])
    // 还没有 schemaRev 的文件(刚建的空模板其实有 schemaRev,所以这里换成老文件)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: true }), 'utf8')
    const legacy = dataDirStatus({ dir })
    assert.equal(legacy.files.find((f) => f.file === 'config.json').rev, null)
    assert.deepEqual(legacy.problems, [], '缺 schemaRev 是合法的,不算问题')

    rmSync(join(dir, 'lexicon.json'))
    writeFileSync(join(dir, 'lexicon.json.bad-2026-10-05T12-00-00-000Z'), '{坏', 'utf8')
    const dirty = dataDirStatus({ dir })
    assert.ok(dirty.problems.some((p) => p.includes('lexicon.json')))
    assert.deepEqual(dirty.badResidue, ['lexicon.json.bad-2026-10-05T12-00-00-000Z'])

    // 字段不合规(JSON 合法)与"文件版本比程序新"都要在体检里现形
    writeFileSync(join(dir, 'state-defaults.json'), JSON.stringify({ schemaRev: 1, moodIntensity: '不是数字' }), 'utf8')
    writeFileSync(join(dir, 'lexicon.json'), JSON.stringify({ schemaRev: 9 }), 'utf8')
    const worse = dataDirStatus({ dir })
    assert.ok(worse.problems.some((p) => p.includes('state-defaults.json') && p.includes('字段不合规')))
    assert.equal(worse.files.find((f) => f.file === 'lexicon.json').rev, 9, '体检要报出文件自己的版本号')
    assert.equal(worse.files.find((f) => f.file === 'lexicon.json').ok, true, '版本比程序新只算警告,不算错')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('resolveDataDir:ECHO_DATA_DIR > DSH_HOME > ~/.dsh', () => {
  assert.equal(resolveDataDir({ ECHO_DATA_DIR: 'D:/mine', DSH_HOME: 'C:/dsh' }), 'D:/mine')
  assert.equal(resolveDataDir({ DSH_HOME: 'C:/dsh' }), join('C:/dsh', 'echo'))
  assert.ok(resolveDataDir({}).endsWith(join('.dsh', 'echo')))
  // 空串/空白 = 没设(不许把数据写到当前目录)
  assert.equal(resolveDataDir({ ECHO_DATA_DIR: '   ', DSH_HOME: 'C:/dsh' }), join('C:/dsh', 'echo'))
  assert.equal(resolveDataDir({ ECHO_DATA_DIR: 'D:/mine' }), 'D:/mine')
})

test('resolveDbPath:ECHO_DB 覆盖,否则跟数据目录走(与 soul-snapshot 同口径)', () => {
  assert.equal(resolveDbPath({ ECHO_DB: 'C:/tmp/x.db', DSH_HOME: 'C:/dsh' }), 'C:/tmp/x.db')
  assert.equal(resolveDbPath({ DSH_HOME: 'C:/dsh' }), join('C:/dsh', 'echo', 'echo.db'))
  assert.equal(resolveDbPath({ ECHO_DATA_DIR: 'D:/mine' }), join('D:/mine', 'echo.db'))
  assert.ok(resolveDbPath({}).endsWith(join('echo', 'echo.db')))
})

test('describeEnsureResult:说人话,数字对得上', async () => {
  const dir = tempDir()
  try {
    const { r } = await run(dir)
    const line = describeEnsureResult(r)
    assert.ok(line.includes('新建 8 个模板'))
    assert.ok(line.includes('校验 0 个'))
    const again = describeEnsureResult((await run(dir)).r)
    assert.ok(again.includes('新建 0 个模板'))
    assert.ok(again.includes('校验 8 个'))
    assert.equal(typeof describeEnsureResult(null), 'string')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------- ⑥ 接线(源码级)

test('接线:挂载链里先 ensureDataDir 再 loadPersona(顺序反了就是"读了个还没建的家")', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const atData = src.indexOf('ensureDataDir({ dir: resolveDataDir()')
  const atPersona = src.indexOf('return loadPersona()')
  assert.ok(src.includes("from './data-dir.js'"), 'index.js 没 import lib/data-dir.js —— 脚手架没接上')
  assert.ok(atData > 0, 'index.js 没调 ensureDataDir —— 数据目录不会自动建')
  assert.ok(atPersona > 0)
  assert.ok(atPersona > atData, 'ensureDataDir 必须在 loadPersona 之前跑')
  // P1a:三处路径都改走路径真源,index.js 里不许再出现自己拼的数据路径
  assert.ok(src.includes('const DB_PATH = resolveDbPath()'), 'DB_PATH 没走 resolveDbPath()')
  assert.ok(!src.includes("join(DATA_DIR, 'echo.db')"), '还有地方在自己拼 echo.db 的路径')
})

// ---------------------------------------------------------------- ⑦ P1a:路径统一

test('P1a:三条路径只有一个真源(resolveConfigPath / resolvePersonaPath / resolveDataFilePath)', () => {
  const home = { DSH_HOME: 'C:/dsh' }
  const dir = join('C:/dsh', 'echo')
  assert.equal(resolveDataDir(home), dir)
  assert.equal(resolvePersonaPath(home), join(dir, 'persona.json'))
  assert.equal(resolveConfigPath(home), join(dir, 'config.json'))
  assert.equal(resolveDbPath(home), join(dir, 'echo.db'))
  for (const name of DATA_FILES) {
    assert.equal(resolveDataFilePath(name, home), join(dir, name))
  }
  // 不在册的名字不瞎拼(路径拼接是最容易被打穿的一环)
  assert.equal(resolveDataFilePath('../../etc/passwd', home), null)
  assert.equal(resolveDataFilePath('echo.db', home), null, 'echo.db 不是"数据文件",走 resolveDbPath')
  assert.equal(resolveDataFilePath(DATA_REV_FILE, home), join(dir, DATA_REV_FILE))
})

test('P1a:不设任何 env 时,四条路径与 P0 之前逐字节一致(不会悄悄搬家)', () => {
  const none = { ECHO_DATA_DIR: undefined, ECHO_DB: undefined, DSH_HOME: undefined }
  const oldDataDir = join(homedir(), '.dsh', 'echo')   // = 旧的 join($DSH_HOME ?? ~/.dsh, 'echo')
  assert.equal(resolveDataDir(none), oldDataDir)
  assert.equal(resolvePersonaPath(none), join(oldDataDir, 'persona.json'))
  assert.equal(resolveConfigPath(none), join(oldDataDir, 'config.json'))
  assert.equal(resolveDbPath(none), join(oldDataDir, 'echo.db'))
})

test('P1a:设了 ECHO_DATA_DIR,persona / config / db 三者一起搬过去(不分裂)', async () => {
  const tmp = tempDir()
  const saved = { ECHO_DATA_DIR: process.env.ECHO_DATA_DIR, ECHO_DB: process.env.ECHO_DB }
  try {
    delete process.env.ECHO_DB
    process.env.ECHO_DATA_DIR = tmp
    // ⚠️ 必须在**本进程第一次** import 这两个模块之前设好 env:
    // DATA_DIR / PERSONA_PATH / CONFIG_PATH 是模块级常量(首次 import 时定死)。
    // 本文件此前只 import 过 data-dir.js / data-schema.js,而它们**都不再**牵 persona.js
    // (P1a 拆了 persona → data-dir → data-schema → persona 那个环),所以这里是干净的首次。
    const persona = await import('../lib/persona.js')
    const toggle = await import('../lib/toggle.js')
    assert.equal(persona.DATA_DIR, tmp)
    assert.equal(persona.PERSONA_PATH, join(tmp, 'persona.json'))
    assert.equal(toggle.CONFIG_PATH, join(tmp, 'config.json'))
    assert.equal(resolveDbPath(), join(tmp, 'echo.db'))   // index.js 的 DB_PATH 用的就是它
    // 三者同一个家 —— 这条才是"不分裂"的本体
    assert.equal(dirname(persona.PERSONA_PATH), tmp)
    assert.equal(dirname(toggle.CONFIG_PATH), tmp)
    assert.equal(dirname(resolveDbPath()), tmp)
    // 脚手架也跟着搬:ensureDataDir() / dataDirStatus() 不传 dir 时用同一个真源
    const { r } = await run(undefined)
    assert.equal(r.dir, tmp)
    assert.equal(r.created.length, DATA_FILES.length)
    assert.equal(dataDirStatus().dir, tmp)
    // ★ 冻结语义(P1a 起的正式不变量):进程内第一个问到的值定死,env 之后再变也不动。
    //   5 处"新模块实例仍从盘上读得到"的落盘持久断言依赖它;别改成"每次现读"。
    process.env.ECHO_DATA_DIR = join(tmpdir(), 'echo-这个不该生效')
    assert.equal(resolveDataDir(), tmp, '进程内数据目录应当已经冻住')
    assert.equal(resolveDbPath(), join(tmp, 'echo.db'))
    assert.equal(resolveConfigPath(), join(tmp, 'config.json'))
    // 显式 env 不受冻结影响(纯推法,给测试留的口子)
    assert.equal(resolveDataDir({ ECHO_DATA_DIR: 'D:/mine' }), 'D:/mine')
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('P1a:ECHO_DB 只让库单独走开,人格与开关不动', () => {
  const env = { ECHO_DATA_DIR: 'D:/home', ECHO_DB: 'D:/db/mine.db' }
  assert.equal(resolveDbPath(env), 'D:/db/mine.db')
  assert.equal(resolvePersonaPath(env), join('D:/home', 'persona.json'))
  assert.equal(resolveConfigPath(env), join('D:/home', 'config.json'))
})
