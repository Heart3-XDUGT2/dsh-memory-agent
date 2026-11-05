/**
 * 「语气候选」(`lib/style-hint.js`)的电池 —— 方案 C。
 *
 * 钉这几件事:
 *   ① **降级矩阵**:门禁 4 × 唤醒度 4(高/中/低/**缺**)× 心情 3(正/负/**缺**)
 *      × delta 4(正/零/负/**缺**)= **192 格**,每格都断言四条硬约束 + 三条文案准确律;
 *   ② 硬约束:`1`(自然)与 `6`(突出)**永不进候选、也不进禁区**;产出的号永远 ∈ `1..6`;
 *   ③ 硬约束:门禁 `yellow`/`red`/`unknown` 时**文案里不出现共享轴**(且 `s` 只在 `green`
 *      且心情读数缺时当兜底 —— 单独用一个对照用例钉死);
 *   ④ 硬约束:`delta = 0` 与"读不出变化"⇒ **`line === ''`**;
 *   ⑤ ②新增:**自身读数全缺 ⇒ 任何门禁都不出行**(红带 + 自身也缺是重点);
 *   ⑥ ②新增:文案准确律 —— 没读到的字段不许出现在文案里(唤醒度/心情),
 *      绿灯不许声称"两套坐标一致",且一律**正向表述**(不出现"不合适/不能用");
 *   ⑦ 契约:**这一层不维护样式表**(不拉表、不缓存、不校验);
 *   ⑧ 接线:`describeMood` 只负责"有就插、插在行为要求之前",且**不 import** 本模块。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  statusToStyleCandidates, STYLE_LABEL, STYLE_MIN, STYLE_MAX, STYLE_NEVER, LINE_MAX
} from '../lib/style-hint.js'
import { describeMood } from '../lib/context.js'

const src = readFileSync(fileURLToPath(new URL('../lib/style-hint.js', import.meta.url)), 'utf8')

/** 门禁四档(第四档 = 结构化读数整个没有 ⇒ 归入"未知")。 */
const GATES = ['green', 'yellow', 'red', 'unknown']
/** 唤醒度四档:高 / 中 / 低 / **缺**(null)。 */
const AROUSALS = [['up', 8], ['mid', 5], ['down', 2], ['missing', null]]
/** 心情三档:正 / 负 / **缺**。 */
const VALENCES = [['pos', 3], ['neg', -3], ['unknown', null]]
/** delta 四档:正 / 零 / 负 / **缺**(任一侧没读数)。 */
const DELTAS = [['pos', 6, 4], ['zero', 5, 5], ['neg', 4, 6], ['unknown', null, 4]]

const make = (gate, arousal, valence, [, cur, prev]) => statusToStyleCandidates({
  moodIntensity: cur,
  prevMoodIntensity: prev,
  emotionVector: { global: { arousal, valence, fatigue: 2 } },
  gate,
  union: { s: -0.154823, a: -0.5698, d: -0.6 }
})

test('① 降级矩阵 192 格:四条硬约束 + 三条文案准确律,格格里都成立', () => {
  let made = 0
  let blank = 0
  let longest = 0
  for (const gate of GATES) {
    for (const [, arousal] of AROUSALS) {
      for (const [, valence] of VALENCES) {
        for (const delta of DELTAS) {
          const r = make(gate, arousal, valence, delta)
          const tag = `gate=${gate} arousal=${arousal} valence=${valence} delta=${delta[0]}`
          made += 1
          const quiet = delta[0] === 'zero' || delta[0] === 'unknown' || r.candidates.length === 0
          if (quiet) {
            assert.equal(r.line, '', '不出行的格不许有文案:' + tag)
            blank += 1
          } else {
            assert.ok(r.line.startsWith('- 语气候选'), tag)
            assert.ok(r.line.length <= LINE_MAX, '文案超长(' + r.line.length + '):' + tag)
            longest = Math.max(longest, r.line.length)
          }
          // —— 硬约束 ①:号永远在号域内
          for (const n of [...r.candidates, ...r.avoid]) {
            assert.ok(Number.isInteger(n) && n >= STYLE_MIN && n <= STYLE_MAX, '越界号 ' + n + ':' + tag)
          }
          // —— 硬约束 ②:1 与 6 永不出现(候选、禁区都不行)
          for (const never of STYLE_NEVER) {
            assert.ok(!r.candidates.includes(never), never + ' 不许进候选:' + tag)
            assert.ok(!r.avoid.includes(never), never + ' 不许进禁区:' + tag)
          }
          assert.ok(r.candidates.length <= 2, '候选个数:' + tag)
          assert.equal(new Set(r.candidates).size, r.candidates.length, '候选重复:' + tag)
          for (const n of r.avoid) assert.ok(!r.candidates.includes(n), '候选与禁区相交于 ' + n + ':' + tag)
          // —— 硬约束 ③:文案里不出现共享轴;非绿带一律不信 s
          assert.ok(!/s\s*=|共享轴/.test(r.line), '文案里漏了共享轴:' + tag)
          if (gate !== 'green') assert.equal(r.sTrusted, false, tag)
          // —— 文案准确律 A:没读到的字段不许出现
          if (r.arousalKnown === false) assert.ok(!/唤醒/.test(r.line), '唤醒度没读到却写了唤醒:' + tag)
          if (r.valenceKnown === false) assert.ok(!/心情偏/.test(r.line), '心情没读到却写了心情偏X:' + tag)
          // —— 文案准确律 B:不许声称"两套坐标一致"(绿带尾巴干脆不说)
          assert.ok(!/一致/.test(r.line), '文案里出现了"一致"这种断言:' + tag)
          // —— 文案准确律 C:一律正向表述
          assert.ok(!/不合适|不能用|禁止|不许/.test(r.line), '文案出现了否定式断言:' + tag)
          // 兜底来的心情符号不许当"读到的心情"写出来
          if (r.valenceFromS === true) assert.equal(r.valenceKnown, false, tag)
        }
      }
    }
  }
  assert.equal(made, 4 * 4 * 3 * 4, '矩阵格数:4 门禁 × 4 唤醒度 × 3 心情 × 4 delta')
  assert.ok(blank > 0 && blank < made, '既要有不出行的格,也要有出行的格')
  assert.ok(longest > 0 && longest <= LINE_MAX, '最长行 ' + longest + ' 字')
})

test('⑤ 自身读数全缺 ⇒ 任何门禁都不出行(红带 + 自身也缺是重点)', () => {
  for (const gate of GATES) {
    const r = statusToStyleCandidates({
      moodIntensity: 6,
      prevMoodIntensity: 4,
      emotionVector: { global: { fatigue: 2 } },   // 唤醒、心情都没有
      gate,
      union: { s: -0.42 }                          // 绿带也救不回来:两套坐标不可互推,单靠 s 不足以挑语气
    })
    assert.deepEqual(r.candidates, [], gate + ':自身读数全缺 ⇒ 不推号')
    assert.deepEqual(r.avoid, [], gate + ':也没东西可列禁区')
    assert.equal(r.line, '', gate + ':不出行')
    assert.equal(r.arousalBand, 'unknown', gate + ':读不到就是 unknown,不许假装居中')
  }
})

test('③ 门禁只影响一件事:s 仅当 green 且心情读数缺时当兜底(黄/红不碰)', () => {
  const args = {
    moodIntensity: 6,
    prevMoodIntensity: 4,
    emotionVector: { global: { arousal: 8, valence: null } }, // 心情缺 ⇒ 只有 s 能用
    union: { s: -0.5 }
  }
  const green = statusToStyleCandidates({ ...args, gate: 'green' })
  assert.equal(green.sTrusted, true)
  assert.equal(green.valenceFromS, true)
  assert.deepEqual(green.candidates, [5], '绿带 + s 负 ⇒ 按负向 ⇒ 紧张')
  assert.equal(green.valenceKnown, false, 's 兜底不算"读到了心情"')
  assert.ok(green.line.includes('心情读数缺'), '文案要如实说心情没读到')
  assert.ok(!/心情偏/.test(green.line), '更不许说"心情偏负"')
  for (const gate of ['yellow', 'red', 'unknown']) {
    const r = statusToStyleCandidates({ ...args, gate })
    assert.equal(r.sTrusted, false, gate + ' 不许信 s')
    assert.deepEqual(r.candidates, [2], gate + ' 时只按体感推(保守:上扬)')
    assert.ok(!/s\s*=|共享轴/.test(r.line), gate + ' 文案里出现了共享轴')
  }
})

test('① 平静不推号:低唤醒 + 心情偏正 ⇒ 一个号都不推(默认语气就是对的)', () => {
  // real-data 复盘(2026-10-05):真实那几轮是「唤醒 3 + 心情 +2」,
  // 第一版推了 <emo type="4">(低沉)—— 与"心情偏正"自相矛盾。
  const down = { emotionVector: { global: { arousal: 3, valence: 2 } }, moodIntensity: 3, prevMoodIntensity: 2 }
  const calm = statusToStyleCandidates({ ...down, gate: 'green' })
  assert.deepEqual(calm.candidates, [], '平静 ⇒ 不推号')
  assert.deepEqual(calm.avoid, [2, 3], '禁区照样给(上扬/急促都不合平静)')
  assert.equal(calm.line, '', '平静 ⇒ 不出行')
  assert.equal(calm.delta, 'pos', 'delta 仍然照算(只是不出行)')
  // 心情偏负 + 低唤醒才是真的"低沉"
  const blue = statusToStyleCandidates({ ...down, gate: 'green', emotionVector: { global: { arousal: 3, valence: -2 } } })
  assert.deepEqual(blue.candidates, [4])
  assert.ok(blue.line.includes('<emo type="4">(低沉)'))
  // 心情读不出 + 低唤醒(黄/红:不信 s):保守,不指着她说"压低声"
  const unknown = statusToStyleCandidates({ ...down, gate: 'red', emotionVector: { global: { arousal: 3, valence: null } } })
  assert.deepEqual(unknown.candidates, [])
  assert.equal(unknown.line, '')
})

test('⑥ 文案:正向表述 + 括号里只写真读到的字段 + 绿灯不啰嗦', () => {
  const fire = (gate, arousal, valence) => statusToStyleCandidates({
    moodIntensity: 6, prevMoodIntensity: 4, emotionVector: { global: { arousal, valence } }, gate
  }).line
  const green = fire('green', 8, 3)
  assert.ok(green.includes('偏向用 <emo type="2">(上扬)'), green)
  assert.ok(green.includes('<emo type="4">/<emo type="5"> 不优先'), '禁区用正向措辞:' + green)
  assert.ok(green.includes('(朗读用)'), '与"行为要求"划清边界:' + green)
  assert.ok(green.endsWith('没转折就不加。'), '绿灯不加尾巴:' + green)
  assert.ok(!/唤醒度/.test(green), '文案用"唤醒偏高",不用"唤醒度偏高"(省 2 字)')
  // 唤醒度缺 ⇒ 不提唤醒;心情缺 ⇒ 如实说缺
  const noArousal = fire('green', null, 3)
  assert.ok(!/唤醒/.test(noArousal), noArousal)
  assert.ok(!noArousal.includes('心情读数缺'), noArousal)
  const noValence = fire('red', 8, null)
  assert.ok(noValence.includes('唤醒偏高') && noValence.includes('心情读数缺'), noValence)
  assert.ok(noValence.includes('(按体感)'), noValence)
  // 黄与红同一句尾巴(对模型来说要做的动作一样),绿灯没有尾巴
  const y = fire('yellow', 8, 3)
  const rd = fire('red', 8, 3)
  assert.equal(y.slice(green.length), rd.slice(green.length), '黄/红尾巴同句')
  assert.equal(y.slice(green.length), '(按体感)')
})

test('⑦ 契约:这一层不维护样式表(不拉表、不缓存、不校验)', () => {
  assert.ok(!/fetch\s*\(/.test(src), 'style-hint 不该发任何请求')
  // 文件头**可以**提到 `/characters`(说明权威在那边)—— 所以这里查的是"能不能真去拿":
  // 没有 fetch、没有任何 URL,就拿不到表 ⇒ 也就谈不上维护它。
  assert.ok(!/https?:\/\//.test(src), '不许出现任何 URL')
  assert.ok(/不维护样式表/.test(src), '文件头要写明这条契约')
  // 显示字典:故意不含 1/6
  assert.equal(STYLE_LABEL[1], undefined)
  assert.equal(STYLE_LABEL[6], undefined)
  assert.deepEqual([STYLE_MIN, STYLE_MAX, ...STYLE_NEVER], [1, 6, 1, 6])
  // 坏输入不抛(全空 / 非对象)
  for (const bad of [undefined, null, 0, 'x', {}, { emotionVector: null, union: 'x', gate: 7 }]) {
    const r = statusToStyleCandidates(bad)
    assert.equal(typeof r.line, 'string')
    assert.ok(Array.isArray(r.candidates) && Array.isArray(r.avoid))
  }
})

test('⑧ 接线:describeMood 只管"有就插",插在行为要求之前;不传就一个字不多', () => {
  const state = {
    moodIntensity: 6,
    prevMoodIntensity: 4,
    emotionVector: { global: { fatigue: 2, valence: 3, arousal: 8 }, target_master: { affection: 8 } }
  }
  const plain = describeMood(state)
  assert.ok(!plain.includes('语气候选'), '不传 styleHint ⇒ 一个字都不多')
  assert.equal(describeMood(state, { styleHint: '   ' }), plain, '空白等于没传')
  const r = statusToStyleCandidates({ ...state, gate: 'green' })
  const withHint = describeMood(state, { styleHint: r.line })
  const iScript = withHint.indexOf('- 剧本:')
  const iHint = withHint.indexOf('- 语气候选')
  const iBehavior = withHint.indexOf('行为要求:')
  assert.ok(iScript >= 0 && iHint > iScript && iBehavior > iHint, '语气候选夹在剧本与行为要求之间')
  // 口径只在 style-hint 一处:context.js 不许自己算候选
  const ctx = readFileSync(fileURLToPath(new URL('../lib/context.js', import.meta.url)), 'utf8')
  assert.ok(!/statusToStyleCandidates/.test(ctx), 'context.js 不该 import 它(只做插槽)')
})

test('⑨ 接线:宿主端点把这一行交给面板(②:看不见就调不动)', () => {
  const host = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
  assert.ok(host.includes("path: '/api/echo/emotion-space'"), '端点还在')
  assert.ok(/statusToStyleCandidates\(\{/.test(host), '端点要调用同一个纯函数')
  assert.ok(host.includes("source: 'recomputed'"), '端点必须标明这是现算')
  assert.ok(host.includes('enabled: readSettings().styleHint !== false'), '端点要带开关状态')
  assert.ok(/\n {10}styleHint,\n/.test(host), 'styleHint 要真的进 payload(不是算了不用)')
  const view = readFileSync(fileURLToPath(new URL('../web/views/emotion-space.js', import.meta.url)), 'utf8')
  assert.ok(view.includes('styleLinesOf'), '面板要有这一块')
})
