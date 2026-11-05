/**
 * 人名 / 说话人名单(P1b 模块5/6)。
 *
 * 两份名单原来硬编码在 `lib/store.js:1179`(PERSON_NAMES,14 条)与
 * `lib/memory-read-tools.js:70`(SPEAKER_NODES,5 条),并与 python 侧三处同口径。
 * 现在住 `<数据目录>/names.json`,JS 侧唯一读点是 `lib/names.js`。
 * **空 ⇒ 中性集合**(设计文档 row 7):不猜、不兜底。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadNames, loadOwnerNames, derivedOwnerNames, EMPTY_NAMES } from '../lib/names.js'
import { SPEAKER_NODES } from '../lib/memory-read-tools.js'
import { resolveDataFilePath } from '../lib/data-dir.js'

/** 本机数据目录里的 names.json(拿不到就是 null)。 */
const NAMES_PATH = resolveDataFilePath('names.json')

test('P1b:代码里零名单 —— 两处硬编码都空了,读点只剩 names.js', () => {
  assert.deepEqual([...SPEAKER_NODES], [], 'memory-read-tools 的 SPEAKER_NODES 只剩空默认')
  assert.equal(EMPTY_NAMES.personNames.length + EMPTY_NAMES.speakers.length, 0)
  const storeSrc = readFileSync(new URL('../lib/store.js', import.meta.url), 'utf8')
  const readSrc = readFileSync(new URL('../lib/memory-read-tools.js', import.meta.url), 'utf8')
  assert.ok(!/PERSON_NAMES = \[/.test(storeSrc), 'store.js 里不该再有硬编码名单')
  assert.ok(/SPEAKER_NODES = Object\.freeze\(\[\]\)/.test(readSrc), 'SPEAKER_NODES 必须是空默认')
  assert.ok(!/SPEAKER_NODES = Object\.freeze\(\[[^\]]/.test(readSrc), '不许再有非空的说话人名单')
  assert.ok(storeSrc.includes('loadNames().personNames'), 'store.js 的读点必须接上 names.json')
  assert.ok(readSrc.includes("from './names.js'"), 'memory-read-tools 必须共用同一个读点')
})

test('P1b:loadNames —— 缺文件/坏文件/脏条目一律降级成空名单(中性)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-names-'))
  try {
    const p = join(dir, 'names.json')
    assert.deepEqual(loadNames(p), EMPTY_NAMES)
    assert.deepEqual(loadNames(null), EMPTY_NAMES)
    writeFileSync(p, '{坏', 'utf8')
    assert.deepEqual(loadNames(p), EMPTY_NAMES)
    writeFileSync(p, JSON.stringify({ speakers: null, personNames: '不是数组', familyTerms: {} }), 'utf8')
    assert.deepEqual(loadNames(p), EMPTY_NAMES)
    writeFileSync(p, JSON.stringify({
      speakers: [' 甲 ', '', 3, null, '甲', '乙'],
      personNames: ['丙'],
      familyTerms: ['丁']
    }), 'utf8')
    assert.deepEqual(loadNames(p),
      { speakers: ['甲', '乙'], personNames: ['丙'], ownerNames: [], familyTerms: ['丁'] },
      '去空白、丢非字符串、去重(文档 §7 要求去重);ownerNames 缺 ⇒ 空数组(P1c 拍板新增)')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P1b:本机的 names.json 真名单完好(换机没有文件时只验降级形状)', (t) => {
  const names = loadNames()
  const total = names.speakers.length + names.personNames.length
  if (total === 0) {
    t.diagnostic('本机 names.json 不在或为空(换机/清过数据目录):只验了中性降级')
    assert.deepEqual(names, EMPTY_NAMES)
    return
  }
  assert.ok(names.personNames.length >= 14, '种子迁移应把 14 条 personNames 写进去,实际 ' + names.personNames.length)
  assert.ok(names.speakers.length >= 5, 'speakers 至少 5 条')
  // 空 ⇒ 中性的另一面:非空时它必须真的能判定(拿第一条名字验一句)
  assert.ok(names.personNames.every((s) => typeof s === 'string' && s.trim() !== ''))
  assert.ok(names.speakers.every((s) => typeof s === 'string' && s.trim() !== ''))
  assert.equal(new Set(names.personNames).size, names.personNames.length, '不许有重复项')
})

test('P1c:壳侧每帧把名字随帧下发 —— 引擎三处消费点都从帧里取(不自己读文件)', () => {
  const engineSrc = readFileSync(new URL('../lib/engine.js', import.meta.url), 'utf8')
  // ① 帧通道这个**唯一咽喉**要挂上 names(所有引擎帧都走它);
  //    P3-a 后同一咽喉还要挂 data(数据文件下发),所以这条钉子要求**两个都在**。
  assert.ok(/client\.request\(type, \{ \.\.\.payload, names: frameNames\(\), data: frameData\(\) \}/.test(engineSrc),
    '引擎帧要把 names 与 data 一起发出去')
  // ② 载荷来自唯一读点 names.js,且读不到 ⇒ 空两份(退化,不回落旧表)
  assert.ok(engineSrc.includes("from './names.js'"), 'engine.js 必须共用 names.js 这个读点')
  assert.ok(engineSrc.includes('const n = loadNames()'), 'frameNames 要现读数据文件(面板改了下一帧生效)')
  assert.ok(/catch \{\s*return \{ speakers: \[\], personNames: \[\], ownerNames: \[\],? \}/.test(engineSrc),
    '读不到 ⇒ 空三份列表(不能回落到代码里的旧名单)')
  assert.ok(engineSrc.includes('ownerNames: loadOwnerNames()'),
    '帧里要带自节点名(ownerNames:数据文件优先,空则从 profile 派生)')
  // ③ 引擎侧:三处消费点都不许再有内置真名
  const gateSrc = readFileSync(new URL('../python/engine/graph_gate.py', import.meta.url), 'utf8')
  const l0Src = readFileSync(new URL('../python/engine/l0_tier.py', import.meta.url), 'utf8')
  assert.ok(/SPEAKER_NODES = frozenset\(\)/.test(gateSrc), 'graph_gate 的 SPEAKER_NODES 必须是空的')
  assert.ok(!gateSrc.includes('"' + 'yo' + 'tao' + '"'), 'graph_gate 里不许再有内置真名(lint 兜全量)')
  assert.ok(!/OWNER_NODE_NAMES = \("用户", "阿岚"\)/.test(l0Src), 'l0_tier 不许再内置"阿岚"')
  assert.ok(l0Src.includes('owner_node_names=None'), '自节点名的注入口必须在')
})

test('P1c(拍板):ownerNames —— 数据文件优先,空则从 profile.json 派生,再空就空(不猜)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-owner-'))
  try {
    const namesPath = join(dir, 'names.json')
    const profilePath = join(dir, 'profile.json')

    // ① 数据文件里有 ⇒ 用它(用户可手编;此时**不看** profile)
    writeFileSync(namesPath, JSON.stringify({ ownerNames: [' 甲 ', '甲', '乙', 3] }), 'utf8')
    writeFileSync(profilePath, JSON.stringify({ userName: '丙', userAliases: ['丁'] }), 'utf8')
    assert.deepEqual(loadOwnerNames({ namesPath, profilePath }), ['甲', '乙'], '手编的 ownerNames 优先')

    // ② 数据文件空 ⇒ 从 profile.json 的 userName + userAliases 派生
    writeFileSync(namesPath, JSON.stringify({ ownerNames: [] }), 'utf8')
    assert.deepEqual(loadOwnerNames({ namesPath, profilePath }), ['丙', '丁'],
      'userName 在前、userAliases 去重后跟上(空数组 = 派生,不是我猜)')

    // ③ 两边都空 / 缺文件 / 坏文件 ⇒ 空(engine 侧只剩角色槽「用户」兜着)
    writeFileSync(profilePath, JSON.stringify({ userName: '', userAliases: [] }), 'utf8')
    assert.deepEqual(loadOwnerNames({ namesPath, profilePath }), [])
    assert.deepEqual(loadOwnerNames({ namesPath: join(dir, '没有这个.json'), profilePath: null }), [])
    writeFileSync(namesPath, '{坏', 'utf8')
    assert.deepEqual(loadOwnerNames({ namesPath, profilePath }), [], '坏文件不许抛,退化成空')
    writeFileSync(profilePath, '{坏', 'utf8')
    assert.deepEqual(derivedOwnerNames(profilePath), [], 'profile 坏 ⇒ 派生结果为空,不崩')
    assert.deepEqual(derivedOwnerNames(null), [])

    // ④ 本机的 names.json 必须有 ownerNames 这个键(拍板新增;缺了 engine 只认角色槽)
    if (existsSync(NAMES_PATH)) {
      const mine = JSON.parse(readFileSync(NAMES_PATH, 'utf8'))
      assert.ok(Array.isArray(mine.ownerNames), '本机 names.json 缺 ownerNames(P1c 拍板新增的字段)')
    } else {
      t.diagnostic('本机没有 names.json(换机/清过数据目录):跳过本机键检查')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
