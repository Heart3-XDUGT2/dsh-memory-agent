/**
 * 图谱实体归一规则(M2)。
 *
 * ★ P1b(2026-10-05):规则表从代码搬进了数据目录的 aliases.json(种子也进了
 *   echo.db 的 graph_aliases 表)。于是这里分两层:
 *   · **逻辑**断言用合成规则验(`canonicalOf` / `planMerges` 都支持显式传入)——
 *     与真名无关,换台机器一样跑;
 *   · 真规则的完整性由一条 `loadAliasRules()` 守卫兜着(他机器上真的会跑;
 *     换机无数据文件时只验降级形状,并 t.diagnostic 说清)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeName, canonicalOf, planMerges, loadAliasRules, ALIAS_TIER1, ALIAS_TIER2
} from '../lib/graph-aliases.js'

const T1 = [
  { alias: 'A简称', canonical: 'A大学', why: '同一所学校的简称/全称' },
  { alias: 'A大学计算机专业', canonical: 'A大学', why: '专业与学校是同一条边的两个写法' },
  { alias: '大一新生', canonical: '大一学生', why: '同一身份的不同说法' }
]
const T2 = [
  { alias: '助手', canonical: 'Echo', why: '合并后成自环,需丢弃该边' },
  { alias: '记忆架构', canonical: 'Echo记忆架构', why: '可能是同一个项目,也可能泛指' }
]
const RULES = { tier1: T1, tier2: T2 }
const NONE = { tier1: [], tier2: [] }

test('P1b:程序里零真名 —— 代码表是空表,源码里扫不到实体真名', () => {
  assert.equal(ALIAS_TIER1.length, 0, 'P1b:Tier1 只剩通用空默认')
  assert.equal(ALIAS_TIER2.length, 0, 'P1b:Tier2 只剩通用空默认')
  const src = readFileSync(new URL('../lib/graph-aliases.js', import.meta.url), 'utf8')
  for (const needle of ['西电', '西安电子科技大学', '新工科大学', '3km速度限制', 'AI记忆架构']) {
    assert.ok(!src.includes(needle), '源码里还留着实体真名:' + needle)
  }
  // 接线:不给规则时要能从 aliases.json 现读(路径真源不许自己拼)
  assert.ok(src.includes("resolveDataFilePath('aliases.json')"), '默认规则必须走 data-dir 的路径真源')
})

test('normalizeName:去空白/全角空格/大小写差异', () => {
  assert.equal(normalizeName('  Echo '), 'echo')
  assert.equal(normalizeName('ＥＣＨＯ'), 'echo')
  assert.equal(normalizeName('A大学'), 'a大学')
  assert.equal(normalizeName(''), '')
})

test('canonicalOf:Tier1 高置信同实体', () => {
  assert.equal(canonicalOf('A简称', T1), 'A大学')
  assert.equal(canonicalOf('A大学', T1), null)  // 规范名不是别名 → 不用改写
  assert.equal(canonicalOf('大一新生', T1), '大一学生')
})

test('canonicalOf:Tier2 也在规则表里,但只有 Tier1 能自动并', () => {
  // canonicalOf 认全表(写入侧接地时该复用规范名),分野在 planMerges:
  // 「记忆架构」与「Echo记忆架构」可能是两件事(别家方案 vs 自己项目)。
  assert.equal(canonicalOf('记忆架构', RULES.tier1.concat(RULES.tier2)), 'Echo记忆架构')
  assert.equal(canonicalOf('助手', T2), 'Echo')
  assert.equal(canonicalOf('记忆架构', T1), null)   // 只给 Tier1 → 不认
  assert.equal(canonicalOf('完全没见过的名字', RULES.tier1.concat(RULES.tier2)), null)
  assert.equal(canonicalOf('', T1), null)
})

test('planMerges:按库里实际存在的节点出计划', () => {
  const nodes = [
    { id: 'n1', name: 'A简称' },
    { id: 'n2', name: 'A大学' },
    { id: 'n3', name: '大一新生' },
    { id: 'n4', name: '大一学生' },
    { id: 'n5', name: '记忆架构' },
    { id: 'n6', name: 'Echo记忆架构' },
    { id: 'n7', name: '校园跑' }
  ]
  const plan = planMerges(nodes, RULES)
  const t1 = plan.tier1.map((m) => m.loser + '→' + m.canonical).sort()
  assert.deepEqual(t1, ['大一新生→大一学生', 'A简称→A大学'].sort())
  assert.ok(plan.tier2.some((m) => m.loser === '记忆架构' && m.canonical === 'Echo记忆架构'))
  // 每一条都要带上「为什么」,否则审阅单上没人敢点头
  for (const m of [...plan.tier1, ...plan.tier2]) assert.ok(String(m.why).length > 0)
})

test('planMerges:规范名不在库里就不出这条(不凭空造节点)', () => {
  const plan = planMerges([{ id: 'n1', name: '大一新生' }], RULES)
  assert.equal(plan.tier1.length, 0)
  // 但规范名缺席时也没崩:启发式那栏照旧给候选
  assert.ok(Array.isArray(plan.heuristic))
})

test('planMerges:启发式只报「一个名字包含另一个」,不下手', () => {
  const plan = planMerges([
    { id: 'n1', name: 'Echo' },
    { id: 'n2', name: 'Echo后端架构' },
    { id: 'n3', name: '章鱼小丸子' },
    { id: 'n4', name: '做章鱼小丸子' }
  ], NONE)
  const pairs = plan.heuristic.map((h) => h.names.slice().sort().join('|')).sort()
  assert.ok(pairs.includes(['Echo', 'Echo后端架构'].sort().join('|')))
  assert.ok(pairs.includes(['章鱼小丸子', '做章鱼小丸子'].sort().join('|')))
  assert.equal(plan.tier1.length + plan.tier2.length, 0)
})

test('planMerges:没有规则表也能跑(空表降级 —— 只报启发式,不瞎并)', () => {
  const plan = planMerges([{ id: 'n1', name: 'A简称' }, { id: 'n2', name: 'A大学' }], NONE)
  assert.equal(plan.tier1.length, 0)
  assert.equal(plan.tier2.length, 0)
  assert.deepEqual(plan.heuristic, [], '没有规则时,唯一候选是"归一后同名",这里两个名字并不同名')
})

test('loadAliasRules:从 aliases.json 读规则,按 tier 分开;脏/缺/坏一律降级', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-alias-rules-'))
  try {
    const p = join(dir, 'aliases.json')
    // 缺文件
    assert.deepEqual(loadAliasRules(p), NONE)
    assert.deepEqual(loadAliasRules(null), NONE)
    // 坏 JSON
    writeFileSync(p, '{不是 JSON', 'utf8')
    assert.deepEqual(loadAliasRules(p), NONE)
    // 正常:两级 + 一条 tier 越界的(按 Tier2 处理:宁可少并,不可错并)+ 两条脏条目
    writeFileSync(p, JSON.stringify({
      schemaRev: 1,
      rules: [
        { alias: ' A简称 ', canonical: ' A大学 ', tier: 1, why: '简称' },
        { alias: '记忆架构', canonical: 'Echo记忆架构', tier: 2, why: '待过目' },
        { alias: '越界tier', canonical: '某规范名', tier: 7, why: '不该出现' },
        { alias: '  ', canonical: 'x', tier: 1 },
        { alias: 'y', tier: 1 },
        { alias: 'z', canonical: 'w' },
        null
      ],
      updatedAt: null
    }), 'utf8')
    const loaded = loadAliasRules(p)
    assert.equal(loaded.tier1.length, 1, 'tier1:只有显式 tier:1 的那条')
    assert.equal(loaded.tier2.length, 3, 'tier2:记忆架构 + 越界 tier + 没写 tier 的 z(都走人工过目那侧)')
    assert.deepEqual(loaded.tier1[0], { alias: 'A简称', canonical: 'A大学', why: '简称' }, '两端空白要修掉')
    assert.equal(loaded.tier2[1].alias, '越界tier', '越界 tier 落到 Tier2(人工过目那一侧)')
    assert.equal(loaded.tier2[2].alias, 'z', '没写 tier 也落 Tier2 —— 宁可少并,不可错并')
    assert.equal(loaded.tier2[2].why, '', '缺 why 就是空串(不编)')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('loadAliasRules:本机(或装机)的 aliases.json 真规则完好', (t) => {
  const real = loadAliasRules()
  const total = real.tier1.length + real.tier2.length
  if (total === 0) {
    t.diagnostic('本机 aliases.json 不在或为空(换机/清过数据目录):这条只验了降级形状,没验真规则')
    assert.deepEqual(real, NONE)
    return
  }
  assert.ok(total >= 13, 'P1b 种子迁移应把 13 条真规则写进 aliases.json,实际 ' + total)
  assert.ok(real.tier1.length >= 6, 'Tier1 至少 6 条')
  assert.ok(real.tier2.length >= 7, 'Tier2 至少 7 条')
  for (const r of [...real.tier1, ...real.tier2]) {
    assert.ok(r.alias !== '' && r.canonical !== '', '每条都要有 alias 与 canonical')
    assert.ok(typeof r.why === 'string', 'why 字段要在(审阅单上没人敢给没理由的合并点头)')
  }
  // 真规则能落到节点上:拿规则里的 canonical 造一对节点,必须出 tier1 计划
  const first = real.tier1[0]
  const plan = planMerges([
    { id: 'n1', name: first.alias },
    { id: 'n2', name: first.canonical }
  ], real)
  assert.equal(plan.tier1.length, 1, '真规则要在 planMerges 里真的生效')
  assert.equal(plan.tier1[0].canonical, first.canonical)
})
