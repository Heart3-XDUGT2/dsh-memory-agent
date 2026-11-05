/**
 * 人格基线(`lib/her-baseline.js`)单测 —— 设计 §2 / 拍板 ⑦⑧。
 *
 * 钉三件事:
 *   ① **只有 P/A 两维,`d` 恒 `null`** —— dominance 在本仓"已登记未启用",
 *      基线不许把第三维编出来(缺维就空着,不填 0、不填 5);
 *   ② **原生值口径**:P 与 `global.valence`(−10..10)同尺、A 与 `global.arousal`(1..10)
 *      同尺,不经联合空间桥接;要上立方体时才由 `baselineUnit()` 现算双极坐标;
 *   ③ **没填/总闸关 = 没有基线**(不是"基线在中心"):`set:false`、`baselineUnit():null`、
 *      `describeBaseline():null` —— 面板那一块整块跳过,不画假点。
 *
 * 纯函数集合:不读文件、不写库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BASELINE_SOURCES, DEFAULT_HER_BASELINE, resolveHerBaseline,
  readBaseline, baselineFromMean, baselineUnit, describeBaseline
} from '../lib/her-baseline.js'

test('出厂:没有基线 —— d 恒 null,set=false,画不出来也说不出来', () => {
  assert.equal(DEFAULT_HER_BASELINE.p, null)
  assert.equal(DEFAULT_HER_BASELINE.a, null)
  assert.equal(DEFAULT_HER_BASELINE.d, null)
  const b = resolveHerBaseline({})
  assert.equal(b.set, false)
  assert.equal(b.d, null)
  assert.equal(baselineUnit(b), null)
  assert.equal(describeBaseline(b), null)
  // 脏输入一律不抛
  for (const bad of [null, undefined, 42, 'x', [], true]) {
    const r = resolveHerBaseline(bad)
    assert.equal(r.set, false, String(bad) + ' 该当"没有基线"')
    assert.equal(r.d, null)
  }
})

test('resolveHerBaseline:钳位 + source 白名单 + **只填一个不算填**', () => {
  const b = resolveHerBaseline({ p: 2.34, a: 3.06, source: 'mean', updatedAt: 123 })
  assert.equal(b.p, 2.3)
  assert.equal(b.a, 3.1)
  assert.equal(b.d, null, 'd 永远是 null(哪怕传了值)')
  assert.equal(b.source, 'mean')
  assert.equal(b.updatedAt, 123)
  assert.equal(b.set, true)
  // 越界夹取
  assert.equal(resolveHerBaseline({ p: 99, a: -99 }).p, 10)
  assert.equal(resolveHerBaseline({ p: 99, a: -99 }).a, 1)
  // 认不出来的来源 ⇒ manual(不猜)
  assert.equal(resolveHerBaseline({ p: 0, a: 3, source: 'vibes' }).source, 'manual')
  // 只填一个 = 没填(不半画一个点)
  assert.equal(resolveHerBaseline({ p: 2 }).set, false)
  assert.equal(resolveHerBaseline({ a: 3 }).set, false)
  assert.equal(resolveHerBaseline({ p: '', a: 3 }).set, false)
  // 传进来的 d 直接被无视(硬约定)
  assert.equal(resolveHerBaseline({ p: 1, a: 3, d: 5 }).d, null)
  assert.deepEqual(BASELINE_SOURCES, ['manual', 'mean', 'inferred'])
})

test('readBaseline:读扁平设置键;**总闸关着 ⇒ 一样是"没有"**', () => {
  const on = readBaseline({ herBaselineEnabled: true, herBaselineP: 2, herBaselineA: 3, herBaselineSource: 'manual', herBaselineUpdatedAt: 99 })
  assert.equal(on.set, true)
  assert.equal(on.enabled, true)
  assert.equal(on.p, 2)
  assert.equal(on.a, 3)
  assert.equal(on.d, null)
  assert.equal(on.updatedAt, 99)
  // 数还在配置里,但总闸关了 ⇒ 不该画
  const off = readBaseline({ herBaselineEnabled: false, herBaselineP: 2, herBaselineA: 3 })
  assert.equal(off.enabled, false)
  assert.equal(off.set, false)
  assert.equal(baselineUnit(off), null)
  assert.equal(describeBaseline(off), null)
  // 总闸开着但没填 ⇒ 也是"没有"
  assert.equal(readBaseline({ herBaselineEnabled: true }).set, false)
  // 兼容:嵌套形状(扁平键全空时才认)
  const nested = readBaseline({ herBaselineEnabled: true, herBaseline: { p: 1, a: 4, source: 'mean' } })
  assert.equal(nested.p, 1)
  assert.equal(nested.a, 4)
})

test('baselineUnit:原生值 → 立方体双极([−1,1]),第三维不画', () => {
  const u = baselineUnit({ p: 0, a: 3 })
  assert.equal(u.p, 0, 'valence 0 ⇒ 双极 0')
  assert.ok(u.a > -1 && u.a < 1)
  assert.equal(u.d, null, 'd 不画')
  assert.equal(baselineUnit({ p: 10, a: 10 }).p, 1)
  assert.equal(baselineUnit({ p: -10, a: 1 }).p, -1)
  assert.equal(baselineUnit({ p: -10, a: 1 }).a, -1, 'arousal 下界 ⇒ 双极 −1')
  assert.equal(baselineUnit({ p: 2 }), null, '只填一个 ⇒ 不算')
})

test('baselineFromMean:只吃 P/A、跳过缺维;**一条有效样本都没有 ⇒ null(不编)**', () => {
  const rows = [
    { global: { valence: 2, arousal: 3 } },
    { global: { valence: 4, arousal: 5 } },
    { global: { valence: 6, arousal: 7 } }
  ]
  const b = baselineFromMean(rows)
  assert.equal(b.p, 4)
  assert.equal(b.a, 5)
  assert.equal(b.d, null)
  assert.equal(b.source, 'mean')
  assert.equal(b.n, 3)
  assert.equal(b.set, true)
  // 缺维/脏行跳过
  const mixed = baselineFromMean([
    { global: { valence: 2, arousal: 3 } },
    { global: { valence: 4 } },
    { global: {} },
    { global: { valence: 'x', arousal: 5 } },
    null,
    42,
    { target_master: { affection: 9 } }
  ])
  assert.equal(mixed.n, 1)
  assert.equal(mixed.p, 2)
  assert.equal(mixed.a, 3)
  assert.equal(baselineFromMean([]), null)
  assert.equal(baselineFromMean(null), null)
  assert.equal(baselineFromMean([{ global: {} }]), null)
  // limit 只看最近几条
  const limited = baselineFromMean([
    { global: { valence: 0, arousal: 1 } },
    { global: { valence: 10, arousal: 10 } },
    { global: { valence: 10, arousal: 10 } }
  ], { limit: 2 })
  assert.equal(limited.p, 10)
  assert.equal(limited.n, 2)
})

test('describeBaseline:一行人话,来源如实标;没填就没话说', () => {
  const line = describeBaseline({ p: 2, a: 3, source: 'manual' })
  assert.ok(line.includes('P 2'))
  assert.ok(line.includes('A 3'))
  assert.ok(line.includes('手填'))
  assert.ok(line.includes('d 未启用'), '缺的那一维要说出来,不许装看不见')
  assert.ok(describeBaseline({ p: 2, a: 3, source: 'mean' }).includes('均值'))
  assert.ok(describeBaseline({ p: 2, a: 3, source: 'inferred' }).includes('推断'))
  assert.equal(describeBaseline({ p: 2, a: 3, enabled: false }), null, '总闸关了就没话说')
})
