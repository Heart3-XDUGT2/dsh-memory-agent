import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEDUPE_DEFAULTS, normText, keywordList, jaccard, bigrams, summaryOverlap,
  digitSig, isNearDuplicate, findDuplicateGroups, pickSurvivor, normalizeLayer
} from '../lib/memory-dedupe.js'

// 与 python/tests/test_memory_v016.py 的 DedupeJudge 同一组夹具 ——
// 两边判据必须一致(写入闸在 python,清理脚本在 JS,判错一边就自相矛盾)。
const mem = (summary, keywords, layer = 'L2', status = 'active', extra = {}) => ({
  summary, keywords: JSON.stringify(keywords), layer, status, ...extra
})

test('判据:换说法讲同一件事 → 重复', () => {
  const a = mem('用户参与校园跑，要求跑3km且有速度限制', ['校园跑', '3km'])
  const b = mem('用户提到校园跑有要求，需要跑3km且有速度限制', ['校园跑', '3km'])
  assert.equal(isNearDuplicate(a, b), true)
})

test('判据:只在数字上不同 → 不是重复(第1只猫 ≠ 第2只猫)', () => {
  const a = mem('用户说他的第1只猫很可爱', ['猫'])
  const b = mem('用户说他的第2只猫很可爱', ['猫'])
  assert.equal(digitSig(a.summary), digitSig(b.summary))
  assert.equal(isNearDuplicate(a, b), false)
})

test('判据:层不同是硬门(L0 与 L2 永不同判)', () => {
  const a = mem('用户就读于西安电子科技大学', ['西电'], 'L0')
  const b = mem('用户就读于西安电子科技大学', ['西电'], 'L2')
  assert.equal(isNearDuplicate(a, b), false)
})

// ---- 2026-10-10:空层读侧归一(不改历史数据),与 Python 侧同一组夹具 ----

test('归一:空 / null / 空白 ⇒ L2;具名层原样(大小写不敏感)', () => {
  assert.equal(normalizeLayer(''), 'L2')
  assert.equal(normalizeLayer(null), 'L2')
  assert.equal(normalizeLayer(undefined), 'L2')
  assert.equal(normalizeLayer('   '), 'L2')
  assert.equal(normalizeLayer('L0'), 'L0')
  assert.equal(normalizeLayer('l1'), 'L1')
  assert.equal(normalizeLayer('L2'), 'L2')
})

test('判据:空层与 L2 视为同层(历史 47 行空层重新能被去重命中)', () => {
  const a = mem('用户参与校园跑，要求跑3km且有速度限制', ['校园跑', '3km'], '')
  const b = mem('用户提到校园跑有要求，需要跑3km且有速度限制', ['校园跑', '3km'], 'L2')
  assert.equal(isNearDuplicate(a, b), true)
  assert.equal(isNearDuplicate(b, a), true)
})

test('判据:空层归一为 L2,**不是**「任意层」—— 撞 L0 / L1 仍是硬门', () => {
  // 防的是把归一写成「空层跟谁都比得上」:那会让身份画像(L0)被碎片合并掉
  for (const other of ['L0', 'L1']) {
    const a = mem('用户就读于西安电子科技大学', ['西电'], '')
    const b = mem('用户就读于西安电子科技大学', ['西电'], other)
    assert.equal(isNearDuplicate(a, b), false, `空层不该跟 ${other} 混判`)
  }
})

test('判据:status 不同不互判(隔离不与正式行合并)', () => {
  const a = mem('用户说他养了一只叫年糕的猫', ['猫'], 'L2', 'active')
  const b = mem('用户说他养了一只叫年糕的猫', ['猫'], 'L2', 'quarantined')
  assert.equal(isNearDuplicate(a, b), false)
})

test('判据:关键词一致但摘要八竿子打不着 → 不合并(保守)', () => {
  const a = mem('用户说猫很可爱', ['猫'])
  const b = mem('用户学校的猫舍下周要拆掉重建', ['猫'])
  assert.equal(isNearDuplicate(a, b), false)
})

test('判据:阈值 0 = 关闭(零回归开关)', () => {
  const a = mem('用户说猫很可爱', ['猫'])
  const b = mem('用户说猫很可爱', ['猫'])
  assert.equal(isNearDuplicate(a, b, { kwThreshold: 0, summaryThreshold: 0 }), false)
  assert.equal(isNearDuplicate(a, b), true)
})

test('判据:完全相同句子也算重复(清理脚本才收拾得掉历史堆叠)', () => {
  const a = mem('用户计划明天学习数据结构', [])
  const b = mem('用户计划明天学习数据结构', [])
  assert.equal(isNearDuplicate(a, b), true)
})

test('判据:摘要阈值单独就能定案(关键词漂移时靠它兜住)', () => {
  const a = mem('用户表示以后会学着做章鱼小丸子', ['章鱼小丸子'])
  const b = mem('用户表示以后会学做章鱼小丸子', ['吃的'])
  assert.ok(summaryOverlap(a.summary, b.summary) >= DEDUPE_DEFAULTS.summaryThreshold)
  assert.equal(jaccard(keywordList(a.keywords), keywordList(b.keywords)), 0)
  assert.equal(isNearDuplicate(a, b), true)
})

test('分组:union-find 把传递性连成一组,且同层才成组', () => {
  const rows = [
    { memoryId: 1, ...mem('用户计划明天开始学习数据结构', []) },
    { memoryId: 2, ...mem('用户计划明天学习数据结构', []) },
    { memoryId: 3, ...mem('用户计划明天学习数据结构', [], 'L1') },
    { memoryId: 4, ...mem('用户讨厌方便面', ['方便面']) }
  ]
  const groups = findDuplicateGroups(rows, { survivorRule: 'value' })
  const grouped = groups.map((g) => [g.survivor.memoryId, ...g.losers.map((l) => l.memoryId)])
  // I/learnedAt 都缺席 → 回退到 id 最大者当 survivor(留新不留旧:L0 已被
  // 提示词教成「更新换代」,旧的让位比删掉安全)
  assert.deepEqual(grouped, [[2, 1]])
})

test('survivor:value 规则 = I 最高 → 更新 → id 最大', () => {
  const rows = [
    { memoryId: 1, ...mem('同一句话在这里出现', []), intrinsicValue: 10, learnedAt: 900 },
    { memoryId: 2, ...mem('同一句话在这里出现', []), intrinsicValue: 30, learnedAt: 100 },
    { memoryId: 3, ...mem('同一句话在这里出现', []), intrinsicValue: 30, learnedAt: 500 }
  ]
  const [g] = findDuplicateGroups(rows, { survivorRule: 'value' })
  assert.equal(g.survivor.memoryId, 3)
  assert.deepEqual(g.losers.map((l) => l.memoryId), [2, 1])
})

test('survivor:recent 规则 = 最近学到的', () => {
  const rows = [
    { memoryId: 1, ...mem('同一句话在这里出现', []), intrinsicValue: 99, learnedAt: 100 },
    { memoryId: 2, ...mem('同一句话在这里出现', []), intrinsicValue: 1, learnedAt: 900 }
  ]
  const [g] = findDuplicateGroups(rows, { survivorRule: 'recent' })
  assert.equal(g.survivor.memoryId, 2)
})

test('纯函数:normText / bigrams / jaccard 基本性质', () => {
  assert.equal(normText('用户说：猫！'), normText('用户说 猫'))
  assert.equal(jaccard([], []), 0)          // 两边都空 → 0(不是 1)
  assert.equal(jaccard(['a'], ['a']), 1)
  assert.equal(bigrams('猫').size, 1)       // 单字也能成对,别返回空
})
