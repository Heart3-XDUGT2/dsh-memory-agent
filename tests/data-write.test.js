/**
 * P2 · B0:`lib/data-write.js` 的时序钉子。
 *
 * 这里验的不是"函数能跑",而是**顺序**:
 *   白名单 → 校验(不过就一个字节都不写)→ 备份(失败就中止)→ 原子替换 → 失效缓存。
 * 每个用例都在**临时目录**里跑;每次调用都显式传 `dir`,并且开头就断言
 * "这个 dir 在 tmpdir 底下" —— 绝不许碰真数据目录(沿用 toggle.test.js 的纪律)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DataWriteError, WRITE_EFFECTIVE, backupForFileOf, deepLinkOf, effectiveOf, fileStatus,
  isEmptyContent, isWritableFile, listBackups, readDataFile, registerCacheInvalidator,
  setupStatus, templateOf, validateDataFile, writeDataFile
} from '../lib/data-write.js'
import { DATA_FILES, emptyTemplate, validateFile } from '../lib/data-schema.js'

function freshDir () {
  const dir = mkdtempSync(join(tmpdir(), 'echo-datawrite-'))
  assert.ok(dir.startsWith(tmpdir()), '测试目录必须落在临时目录里:' + dir)
  return dir
}

function withDir (fn) {
  const dir = freshDir()
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const goodProfile = () => ({ ...emptyTemplate('profile.json'), userName: '某人' })

test('白名单:只有登记的 8 个数据文件能写,echo.db 永远出局', () => {
  withDir((dir) => {
    assert.equal(DATA_FILES.length, 8)
    assert.equal(isWritableFile('persona.json'), true)
    for (const bad of ['echo.db', '../persona.json', 'data-rev.json', 'nope.json', '']) {
      assert.equal(isWritableFile(bad), false, bad + ' 不该能写')
      assert.throws(() => writeDataFile(bad, {}), (err) => {
        assert.ok(err instanceof DataWriteError)
        assert.equal(err.code, 'not-allowed')
        return true
      })
    }
    assert.deepEqual(readdirSync(dir), [], '被拒的写不许留下任何文件')
  })
})

test('校验不过 ⇒ 一个字节都不写(旧文件原样)', () => {
  withDir((dir) => {
    const p = join(dir, 'profile.json')
    writeFileSync(p, JSON.stringify(goodProfile(), null, 2), 'utf8')
    const before = readFileSync(p, 'utf8')
    const beforeBytes = readFileSync(p)
    // schemaRev 不是正整数 ⇒ 硬错
    assert.throws(() => writeDataFile('profile.json', { schemaRev: 'x', userName: '某人' }, { dir }), (err) => {
      assert.equal(err.code, 'invalid')
      assert.ok(err.errors.length > 0, '要给明细')
      return true
    })
    // 顶层不是对象 ⇒ 硬错
    assert.throws(() => writeDataFile('profile.json', 'not-an-object', { dir }), (err) => {
      assert.equal(err.code, 'invalid')
      return true
    })
    assert.equal(readFileSync(p, 'utf8'), before, '校验不过时文件必须一字不变')
    assert.deepEqual(readFileSync(p), beforeBytes)
    assert.equal(existsSync(join(dir, 'backup')), false, '校验不过 ⇒ 连备份都不该产生')
    assert.equal(readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0, '不许留 tmp 残渣')
  })
})

test('校验器就是字段表那份(不复制钳位):干跑 validate 与落盘前同一结论', () => {
  withDir((dir) => {
    const okObj = goodProfile()
    const dry = validateDataFile('profile.json', okObj)
    assert.equal(dry.ok, validateFile('profile.json', okObj).ok)
    const bad = { ...okObj, userAliases: 'not-an-array' }
    assert.equal(validateDataFile('profile.json', bad).ok, false)
    assert.equal(validateDataFile('echo.db', {}).ok, false, '白名单外干跑也不许 ok')
    // 干跑**不落盘**
    assert.equal(existsSync(join(dir, 'profile.json')), false)
  })
})

test('保存时序:先备份旧内容 → 再原子替换;备份内容 = 写之前的旧字节', () => {
  withDir((dir) => {
    const p = join(dir, 'profile.json')
    const old = { ...goodProfile(), userName: '旧的' }
    writeFileSync(p, JSON.stringify(old, null, 2), 'utf8')
    const oldBytes = readFileSync(p, 'utf8')

    const r = writeDataFile('profile.json', { ...goodProfile(), userName: '新的' },
      { dir, now: '2026-10-05T07:30:00.000Z' })
    assert.equal(r.ok, true)
    assert.equal(r.file, 'profile.json')
    assert.equal(r.effective, WRITE_EFFECTIVE.now)
    assert.ok(r.backupPath.endsWith('backup\\profile.json.2026-10-05T07-30-00-000Z.bak')
      || r.backupPath.endsWith('backup/profile.json.2026-10-05T07-30-00-000Z.bak'), r.backupPath)
    assert.equal(readFileSync(r.backupPath, 'utf8'), oldBytes, '备份必须是写之前的旧内容')
    assert.equal(JSON.parse(readFileSync(p, 'utf8')).userName, '新的')
    assert.equal(readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0, 'rename 之后不许留 tmp')
    // 落盘的就是传进来的**完整**内容(不是 patch)
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { ...goodProfile(), userName: '新的' })
  })
})

test('备份失败 ⇒ 中止,不继续写(旧文件原样)', () => {
  withDir((dir) => {
    const p = join(dir, 'profile.json')
    writeFileSync(p, JSON.stringify(goodProfile(), null, 2), 'utf8')
    const before = readFileSync(p, 'utf8')
    writeFileSync(join(dir, 'backup'), 'backup 这个名字被一个文件占了 ⇒ 建不出备份目录', 'utf8')
    assert.throws(() => writeDataFile('profile.json', { ...goodProfile(), userName: '改' }, { dir }), (err) => {
      assert.equal(err.code, 'backup-failed')
      assert.ok(/备份失败/.test(err.message))
      return true
    })
    assert.equal(readFileSync(p, 'utf8'), before, '备份失败时半成品都不许出现')
    assert.equal(readdirSync(dir).filter((f) => f.includes('.tmp-')).length, 0)
  })
})

test('首次创建(文件不存在)⇒ 没有旧文件可备份,但仍按同一时序落盘', () => {
  withDir((dir) => {
    const r = writeDataFile('names.json', emptyTemplate('names.json'), { dir })
    assert.equal(r.ok, true)
    assert.equal(r.backupPath, '', '没旧文件的备份是空路径')
    assert.equal(existsSync(join(dir, 'backup')), false, '不必为一个不存在的旧文件造备份目录')
    assert.equal(existsSync(join(dir, 'names.json')), true)
  })
})

test('缓存失效:注册的回调被调用,拿得到新对象;回调抛错不影响写盘结果', () => {
  withDir((dir) => {
    const seen = []
    registerCacheInvalidator((name, obj, c) => { seen.push([name, obj.userName, c.dir === dir]) })
    const r = writeDataFile('profile.json', { ...goodProfile(), userName: '触发失效' }, { dir })
    assert.equal(r.ok, true)
    assert.deepEqual(seen.at(-1), ['profile.json', '触发失效', true], '回调要拿到 (name, 新对象, ctx)')
    assert.deepEqual(r.notes, [], '没有回调抛错时 notes 为空')

    registerCacheInvalidator(() => { throw new Error('故意炸') })
    const r2 = writeDataFile('profile.json', { ...goodProfile(), userName: '再写' }, { dir })
    assert.equal(r2.ok, true, '失效回调炸不许把已经落盘的写判死')
    assert.equal(r2.notes.length, 1)
    assert.ok(/故意炸/.test(r2.notes[0]), r2.notes.join('|'))
  })
})

test('生效语义 (§6.5) 与文件深链:表就是唯一出处', () => {
  assert.equal(effectiveOf('config.json'), 'now')
  assert.equal(effectiveOf('persona.json'), 'next-turn')
  assert.equal(effectiveOf('profile.json'), 'now')
  for (const f of ['aliases.json', 'names.json', 'graph.json', 'state-defaults.json', 'lexicon.json']) {
    assert.equal(effectiveOf(f), 'next-engine-call', f)
  }
  assert.equal(effectiveOf('不认识.json'), 'now', '未知文件按立即,不炸')
  assert.deepEqual(
    DATA_FILES.map((f) => effectiveOf(f)),
    ['now', 'next-turn', 'now', 'next-engine-call', 'next-engine-call', 'next-engine-call', 'next-engine-call', 'next-engine-call']
  )
  assert.equal(deepLinkOf('names.json'), '#/aliases')
  assert.equal(deepLinkOf('graph.json'), '#/tuning')
  assert.equal(deepLinkOf('不认识.json'), '#/cfg')
})

test('读:文件不存在 / 坏 JSON 都不抛,状态说得清楚', () => {
  withDir((dir) => {
    assert.deepEqual(readDataFile('persona.json', { dir }), { file: 'persona.json', exists: false, value: null, raw: '', bytes: 0 })
    writeFileSync(join(dir, 'persona.json'), '{ 这不是 JSON', 'utf8')
    const got = readDataFile('persona.json', { dir })
    assert.equal(got.exists, true)
    assert.equal(got.unreadable, true)
    assert.ok(got.parseError.length > 0)
    assert.throws(() => readDataFile('echo.db', { dir }), (err) => err.code === 'not-allowed')
  })
})

test('fileStatus / setupStatus:空目录 ⇒ 8 缺、未配置;填一个 ⇒ 已配置;坏了 ⇒ 进 broken', () => {
  withDir((dir) => {
    const empty = setupStatus({ dir })
    assert.equal(empty.configured, false)
    assert.equal(empty.missing.length, 8)
    assert.deepEqual(empty.broken, [])
    assert.equal(empty.files.length, 8)
    assert.equal(empty.hints.length, 8)
    for (const h of empty.hints) assert.ok(h.deepLink.startsWith('#/'), h.file)
    assert.equal(empty.dataDir, dir)

    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...emptyTemplate('profile.json'), userName: '' }), 'utf8')
    const stillEmpty = setupStatus({ dir })
    assert.equal(stillEmpty.configured, false, '文件在但一个值都没填 ⇒ 还不算配置过')
    assert.ok(stillEmpty.empty.includes('profile.json'))

    writeFileSync(join(dir, 'profile.json'), JSON.stringify({ ...emptyTemplate('profile.json'), userName: '某人' }), 'utf8')
    const conf = setupStatus({ dir })
    assert.equal(conf.configured, true)
    assert.ok(!conf.empty.includes('profile.json'))

    writeFileSync(join(dir, 'lexicon.json'), '{ 坏', 'utf8')
    const broken = setupStatus({ dir })
    assert.deepEqual(broken.broken, ['lexicon.json'])
    assert.ok(broken.hints.some((h) => h.file === 'lexicon.json'))
    assert.equal(fileStatus('lexicon.json', { dir }).broken, true)
    assert.equal(fileStatus('lexicon.json', { dir }).exists, true)
  })
})

test('isEmptyContent:空串/空数组/空对象/false 算空;填了值(含 0)就算填过', () => {
  assert.equal(isEmptyContent('profile.json', { schemaRev: 1, userAliases: [] }), true)
  assert.equal(isEmptyContent('profile.json', { userName: '  ' }), true, '全空白也算空')
  assert.equal(isEmptyContent('persona.json', { prefix: '', suffix: '', edited: false }), true, 'false 是默认态,不是填过的值')
  assert.equal(isEmptyContent('graph.json', { weights: {}, thresholds: {} }), true, '空对象算空')
  assert.equal(isEmptyContent('lexicon.json', { timeWords: { '早上': 'morning' } }), false)
  assert.equal(isEmptyContent('profile.json', { userName: '某人' }), false)
  assert.equal(isEmptyContent('config.json', { auditKeep: 0 }), false, '0 是有意义的取值,不替用户做主')
  assert.equal(isEmptyContent('config.json', { auditKeep: false }), true)
  assert.equal(isEmptyContent('config.json', { 表里没登记的键: 'x' }), false, '表外的用户数据也算填过')
  assert.equal(isEmptyContent('profile.json', null), true)
})

test('备份清单:只列不删;能认得 P1 时期的老命名', () => {
  withDir((dir) => {
    const bdir = join(dir, 'backup')
    mkdirSync(bdir, { recursive: true })
    writeFileSync(join(bdir, 'profile.json.2026-10-05T07-30-00-000Z.bak'), '{}', 'utf8')
    writeFileSync(join(bdir, 'profile-pre-p1-2026-10-05T06-58-01-703Z.json'), '{}', 'utf8')
    writeFileSync(join(bdir, 'mystery.txt'), 'x', 'utf8')
    assert.equal(backupForFileOf('profile.json.2026-10-05T07-30-00-000Z.bak'), 'profile.json')
    assert.equal(backupForFileOf('profile-pre-p1-2026-10-05T06-58-01-703Z.json'), 'profile.json')
    assert.equal(backupForFileOf('mystery.txt'), null)
    const rows = listBackups({ dir })
    assert.equal(rows.length, 3)
    for (const r of rows) assert.ok(r.bytes >= 1 && typeof r.mtime === 'string')
    assert.equal(listBackups({ dir: join(dir, 'nope') }).length, 0, '没有备份目录 ⇒ 空清单,不抛')
    assert.equal(existsSync(join(bdir, 'mystery.txt')), true, '只列不删')
    assert.equal(statSync(join(bdir, 'mystery.txt')).size, 1)
  })
})

test('模板:每个白名单文件都有空模板,模板本身能过校验(新装只落空模板)', () => {
  for (const f of DATA_FILES) {
    const t = templateOf(f)
    assert.equal(typeof t, 'object')
    const v = validateFile(f, t)
    assert.equal(v.ok, true, f + ' 的空模板必须是合法内容:' + v.errors.join('|'))
    assert.equal(isEmptyContent(f, t), true, f + ' 的空模板必须算"空"')
  }
})
