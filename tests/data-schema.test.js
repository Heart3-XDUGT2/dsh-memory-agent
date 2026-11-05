/**
 * dsh-echo — 数据文件的结构真源(P0)
 * ============================================================
 * 这套电池盯四件事:
 *   ① **空模板真的是空的** —— 任何非空字符串 / 非零数字 / true / 非空容器都不许出现
 *      (这条是"程序里零数据"的第一道闸:谁往模板里塞了一个真人值,这里当场红);
 *   ② 空模板永远过自己的校验(自洽:否则 scaffold 会陷入"建了又不合法");
 *   ③ 校验函数放过合法输入、抓住非法输入(逐文件、逐条规矩);
 *   ④ schemaRev 检查:缺=老文件(合法)、比程序新=只警告、非正整数=错。
 *
 * 纯件(零 IO):不碰任何真文件,不依赖 DSH_HOME。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  ARCHIVE_FILES, DATA_FILES, DATA_REV_FILE, MANAGED_FILES, PROGRAM_DATA_REV,
  checkSchemaRev, dataRevTemplate, emptyTemplate, expectedRev, fieldsOf, isUnreadable,
  specOf, validateFile
} from '../lib/data-schema.js'
import { PERSONA_MAX_CHARS } from '../lib/persona.js'

/** 把对象摊成叶子列表:['path', 'kind:值']。容器为空时记 '[]' / '{}'。 */
function leaves (v, path = '', out = []) {
  if (v === null) { out.push([path, 'null']); return out }
  if (Array.isArray(v)) {
    if (v.length === 0) out.push([path, '[]'])
    else v.forEach((x, i) => leaves(x, path + '[' + i + ']', out))
    return out
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    if (keys.length === 0) out.push([path, '{}'])
    else for (const k of keys) leaves(v[k], path === '' ? k : path + '.' + k, out)
    return out
  }
  out.push([path, typeof v + ':' + JSON.stringify(v)])
  return out
}

// ---------------------------------------------------------------- ① 清单与空模板

test('清单:8 个数据文件 + 1 个记账文件,顺序稳定', () => {
  assert.equal(DATA_FILES.length, 8)
  assert.deepEqual([...DATA_FILES], [
    'config.json', 'persona.json', 'profile.json', 'aliases.json',
    'names.json', 'graph.json', 'state-defaults.json', 'lexicon.json'
  ])
  assert.equal(MANAGED_FILES.length, 10)
  assert.ok(MANAGED_FILES.includes(DATA_REV_FILE))
  // P1b(2026-10-05 拍板):档案文件受管 —— 能解析路径、能被体检,但**不参与建仓**
  assert.deepEqual([...ARCHIVE_FILES], ['persona-legacy-defaults.json'])
  assert.ok(MANAGED_FILES.includes('persona-legacy-defaults.json'))
  assert.ok(!DATA_FILES.includes('persona-legacy-defaults.json'), '档案不该进建仓清单(新装凭空造史料没有意义)')
  assert.equal(PROGRAM_DATA_REV, 1)
})

test('空模板是**真空值**:非空字符串/非零数字/true/非空容器一个都不许有', () => {
  const names = [...DATA_FILES, DATA_REV_FILE]
  for (const name of names) {
    const tpl = name === DATA_REV_FILE ? dataRevTemplate() : emptyTemplate(name)
    assert.equal(typeof tpl, 'object')
    for (const [path, kind] of leaves(tpl)) {
      // 唯一允许的"有值"叶子:schemaRev / dataRev = 程序版本号(版本记账,不是数据)
      if (path === 'schemaRev' || path === 'dataRev') {
        assert.equal(kind, 'number:' + PROGRAM_DATA_REV, name + ':' + path + ' 版本号不对')
        continue
      }
      // 允许的空值全家桶:'' / null / [] / {} / false
      assert.ok(
        kind === 'null' || kind === '[]' || kind === '{}'
          || kind === 'boolean:false' || kind === 'string:""',
        name + ' 的空模板里 ' + path + ' 是 ' + kind + ' —— 空模板只许空值'
          + '(真人值/程序默认值都不许进这里)'
      )
    }
  }
})

test('空模板永远过自己的校验(自洽:不然 scaffold 会反复建一个"不合法"的文件)', () => {
  for (const name of [...DATA_FILES, DATA_REV_FILE]) {
    const tpl = name === DATA_REV_FILE ? dataRevTemplate() : emptyTemplate(name)
    const v = validateFile(name, tpl)
    assert.deepEqual(v.errors, [], name + ' 的空模板没通过自己的校验')
    assert.equal(v.ok, true)
  }
})

test('空模板每次都是新的(调用方改了不影响下一次)', () => {
  const a = emptyTemplate('names.json')
  a.speakers.push('被污染的')
  const b = emptyTemplate('names.json')
  assert.deepEqual(b.speakers, [])
  assert.notEqual(a, b)
})

// ---------------------------------------------------------------- ② 字段表接口

test('字段表:expectedRev / fieldsOf / specOf 的边界', () => {
  assert.equal(expectedRev('persona.json'), PROGRAM_DATA_REV)
  assert.equal(expectedRev('没有这个文件.json'), null)
  assert.equal(specOf('没有这个文件.json'), null)
  assert.equal(fieldsOf('没有这个文件.json'), null)
  assert.ok(fieldsOf('persona.json').length > 0)
  // 拿到的是副本:外部改了不影响真源
  const f = fieldsOf('persona.json')
  f[0].key = '被改过'
  assert.equal(fieldsOf('persona.json')[0].key, 'schemaRev')
})

test('persona 字段表的上限与 lib/persona.js 的 PERSONA_MAX_CHARS 同源(防漂移)', () => {
  const prefix = fieldsOf('persona.json').find((f) => f.key === 'prefix')
  const suffix = fieldsOf('persona.json').find((f) => f.key === 'suffix')
  assert.equal(prefix.maxLen, PERSONA_MAX_CHARS)
  assert.equal(suffix.maxLen, PERSONA_MAX_CHARS)
})

test('P1a 拆环:data-schema.js 不许再 import persona.js(否则 persona 先加载就撞 TDZ)', () => {
  const src = readFileSync(new URL('../lib/data-schema.js', import.meta.url), 'utf8')
  assert.ok(!src.includes("from './persona.js'"),
    'data-schema.js 又 import persona.js 了 —— persona → data-dir → data-schema → persona 成环')
  // 上限值的单一性靠上面那条"同源"用例看住,不靠 import 边
  assert.ok(src.includes('const PERSONA_MAX_CHARS = 4000'))
})

// ---------------------------------------------------------------- ③ 校验:逐文件

test('校验:顶层不是对象 ⇒ 一律不合法(这是唯一允许"重建"的情形)', () => {
  for (const bad of [[], '字符串', 42, true, null, undefined]) {
    const v = validateFile('names.json', bad)
    assert.equal(v.ok, false)
    assert.ok(v.errors.join('; ').includes('顶层不是 JSON 对象'))
  }
  assert.equal(isUnreadable([]), true)
  assert.equal(isUnreadable({ a: 1 }), false)
})

test('校验:persona.json —— 必填 prefix/suffix、超长、类型', () => {
  assert.equal(validateFile('persona.json', { prefix: 'a', suffix: 'b' }).ok, true)
  // 老文件没有 schemaRev:合法(只有 warning)
  const legacy = validateFile('persona.json', { prefix: 'a', suffix: 'b' })
  assert.ok(legacy.warnings.some((w) => w.includes('缺 schemaRev')))
  assert.equal(validateFile('persona.json', { prefix: 'a' }).ok, false)
  assert.equal(validateFile('persona.json', { prefix: 'a', suffix: 2 }).ok, false)
  assert.equal(validateFile('persona.json', { prefix: 'a', suffix: 'b', schemaRev: '1' }).ok, false)
  const tooLong = validateFile('persona.json', { prefix: 'x'.repeat(PERSONA_MAX_CHARS + 1), suffix: 'b' })
  assert.equal(tooLong.ok, false)
  assert.ok(tooLong.errors.join('; ').includes('超过上限'))
})

test('校验:profile.json —— 昵称正则必须是合法正则', () => {
  assert.equal(validateFile('profile.json', emptyTemplate('profile.json')).ok, true)
  assert.equal(validateFile('profile.json', { nicknamePatterns: ['^(?:甲|乙)说[:：]'] }).ok, true)
  const bad = validateFile('profile.json', { nicknamePatterns: ['^(a$'] })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.join('; ').includes('不是合法正则'))
  assert.equal(validateFile('profile.json', { userAliases: ['x'.repeat(33)] }).ok, false)
})

test('校验:aliases.json —— tier 只能 1/2、alias/canonical 不许空', () => {
  const ok = { rules: [{ alias: '简称', canonical: '全称', tier: 1, why: '同一实体' }] }
  assert.equal(validateFile('aliases.json', ok).ok, true)
  assert.equal(validateFile('aliases.json', { rules: [{ alias: 'a', canonical: 'b', tier: 3 }] }).ok, false)
  assert.equal(validateFile('aliases.json', { rules: [{ alias: '', canonical: 'b', tier: 1 }] }).ok, false)
  assert.equal(validateFile('aliases.json', { rules: [{ alias: 'a', canonical: 'b' }] }).ok, false, 'tier 缺了也算错')
  assert.equal(validateFile('aliases.json', { rules: ['不是对象'] }).ok, false)
  const warn = validateFile('aliases.json', { rules: [{ alias: 'a', canonical: 'b', tier: 1, 额外: 1 }] })
  assert.equal(warn.ok, true, '规则里的未知键只警告、不判错')
  assert.ok(warn.warnings.some((w) => w.includes('保留不动')))
})

test('校验:graph.json —— 子对象里逐键查类型,未知键只警告', () => {
  assert.equal(validateFile('graph.json', { weights: { wUnstale: 1, wEmotion: 0.5 } }).ok, true)
  assert.equal(validateFile('graph.json', { weights: { wUnstale: '1' } }).ok, false)
  assert.equal(validateFile('graph.json', { windows: { cooldownMin: -1 } }).ok, false)
  assert.equal(validateFile('graph.json', { weights: [] }).ok, false, 'weights 必须是对象')
  const warn = validateFile('graph.json', { display: { wMin: 1, wMax: 9, 不认识的键: 1 } })
  assert.equal(warn.ok, true)
  assert.ok(warn.warnings.some((w) => w.includes('display.不认识的键')))
})

test('校验:state-defaults.json / names.json / config.json 的类型口径', () => {
  assert.equal(validateFile('state-defaults.json', { moodIntensity: 3 }).ok, true)
  assert.equal(validateFile('state-defaults.json', { moodIntensity: -1 }).ok, false)
  assert.equal(validateFile('state-defaults.json', { moodIntensity: '3' }).ok, false)
  assert.equal(validateFile('state-defaults.json', { affinity: null }).ok, true, 'null = 还没填')

  assert.equal(validateFile('names.json', { speakers: ['甲', '乙'] }).ok, true)
  assert.equal(validateFile('names.json', { speakers: '甲' }).ok, false)
  assert.equal(validateFile('names.json', { personNames: [1] }).ok, false)

  assert.equal(validateFile('config.json', {}).ok, true)
  assert.equal(validateFile('config.json', { enabled: 'true' }).ok, false, '字符串 true 不算布尔')
  assert.equal(validateFile('config.json', { enabled: true, settings: {} }).ok, true)
  assert.equal(validateFile('config.json', { sessionLabels: [] }).ok, false)
  const warn = validateFile('config.json', { 程序没登记过的键: 1 })
  assert.equal(warn.ok, true)
  assert.ok(warn.warnings.some((w) => w.includes('字段表里没有这个键')))
})

test('校验:lexicon.json —— 同义词组至少两个字', () => {
  assert.equal(validateFile('lexicon.json', { synonymGroups: [['甲', '乙'], ['丙', '丁', '戊']] }).ok, true)
  const one = validateFile('lexicon.json', { synonymGroups: [['甲']] })
  assert.equal(one.ok, false)
  assert.ok(one.errors.join('; ').includes('至少两个字'))
  assert.equal(validateFile('lexicon.json', { synonymGroups: [['甲', 1]] }).ok, false)
  assert.equal(validateFile('lexicon.json', { synonymGroups: '不是数组' }).ok, false)
  assert.equal(validateFile('lexicon.json', { bannedWords: ['x'.repeat(33)] }).ok, false)
})

test('校验:记账文件 data-rev.json 的 dataRev 是必填', () => {
  assert.equal(validateFile(DATA_REV_FILE, dataRevTemplate()).ok, true)
  const missing = validateFile(DATA_REV_FILE, { createdAt: null })
  assert.equal(missing.ok, false)
  assert.ok(missing.errors.join('; ').includes('dataRev'))
  assert.equal(validateFile(DATA_REV_FILE, { dataRev: 0 }).ok, false)
})

test('校验:没登记过的文件名 ⇒ 明确报错(不是静默放过)', () => {
  const v = validateFile('不存在的.json', { a: 1 })
  assert.equal(v.ok, false)
  assert.ok(v.errors.join('; ').includes('没有登记过'))
})

// ---------------------------------------------------------------- ④ schemaRev

test('schemaRev:缺 = 老文件(合法 + 警告)', () => {
  const r = checkSchemaRev({ prefix: 'a' }, 1)
  assert.equal(r.ok, true)
  assert.equal(r.errors.length, 0)
  assert.ok(r.warnings.some((w) => w.includes('P0 之前')))
})

test('schemaRev:与程序一致 ⇒ 一句话都不说', () => {
  const r = checkSchemaRev({ schemaRev: 1 }, 1)
  assert.deepEqual(r, { ok: true, errors: [], warnings: [] })
})

test('schemaRev:比程序新 ⇒ 只警告、不许判坏(别把用户的新文件当垃圾)', () => {
  const r = checkSchemaRev({ schemaRev: 9 }, 1)
  assert.equal(r.ok, true)
  assert.ok(r.warnings.some((w) => w.includes('比程序期望')))
})

test('schemaRev:落后 ⇒ 警告(等一次性迁移补)', () => {
  const r = checkSchemaRev({ schemaRev: 0 }, 1)
  assert.equal(r.ok, false, '0 不是正整数')
  const older = checkSchemaRev({ schemaRev: 1 }, 2)
  assert.equal(older.ok, true)
  assert.ok(older.warnings.some((w) => w.includes('落后')))
})

test('schemaRev:非法类型 ⇒ 错', () => {
  for (const bad of ['1', 1.5, true, {}]) {
    const r = checkSchemaRev({ schemaRev: bad }, 1)
    assert.equal(r.ok, false, JSON.stringify(bad) + ' 不该放过')
  }
})
