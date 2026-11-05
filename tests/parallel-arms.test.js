/**
 * 并行支接线 —— **正交契约**（2026-10-21）
 * ==================================================================
 * ## 这一组为什么存在（比修 bug 本身更重要）
 *
 * `query_expand` 全库 0 行拖了 11 天，根因是 `lib/index.js` 的 claim 回调里
 * 两个**正交**的开关被写成了**嵌套**：`auditArm` / `t0Expand` 声明在情绪支的块里，
 * 却被扩展支跨块引用 —— 后来扩展支挪出那个块，就 `ReferenceError`，
 * 求值发生在构造 `begin()` 实参时 ⇒ **`queryExpander.begin()` 一次都没被调用**，
 * 而且**静默**（只进 `ctx.logger.warn`）。
 *
 * 所以这里钉的不是"修好了"，是**"两支不许互相牵连"这条契约本身**：
 *
 *   ① `emotionSameTurn` 只管情绪支 —— 关掉它，**扩展支必须照跑**；
 *   ② `recallExpand` 只管扩展支 —— 关掉它，**情绪支必须照跑**；
 *   ③ 某一支起跑抛异常 —— **另一支必须照跑**。
 *
 * 三条都是**假对象注入**（`begin` 记调用、`onSettleOf` 记回调），
 * 不起真模型、不 sleep、不碰网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { startParallelArms } from '../lib/parallel-arms.js'

/**
 * 造一套假依赖。
 *
 * @param {{ emotionThrows?: boolean, expandThrows?: boolean, startAt?: number }} [opts]
 */
function fake (opts = {}) {
  const calls = {
    emotion: [],   // sameTurnEmotion.begin 的入参
    expand: [],    // queryExpander.begin 的入参
    settle: [],    // onSettleOf 被调用的记录 {arm, step, t0}
    warn: []
  }
  let tick = Number.isFinite(opts.startAt) ? Number(opts.startAt) : 1000

  const deps = {
    st: null,
    sid: 'session-1',
    agent: { name: 'fake-agent' },
    prev: { emotionVector: [0.1, 0.2] },
    userText: '在吗',
    sameTurnEmotion: {
      begin: (sid, o) => {
        calls.emotion.push({ sid, opts: o })
        if (opts.emotionThrows === true) throw new Error('情绪打分起不来')
      }
    },
    queryExpander: {
      begin: (sid, o) => {
        calls.expand.push({ sid, opts: o })
        if (opts.expandThrows === true) throw new Error('查询扩展起不来')
      }
    },
    onSettleOf: (arm, step, t0) => {
      calls.settle.push({ arm, step, t0 })
      return (r) => { calls.settle[calls.settle.length - 1].ran = r }
    },
    // 每次 now() 递增 1ms ⇒ 两支的 t0 必然不同，能验证"各取各的"
    now: () => (tick += 1),
    warn: (m) => { calls.warn.push(m) }
  }
  return { deps, calls }
}

// ---- 契约 ①：关掉情绪支，扩展支必须照跑 --------------------------------

test('① ★ emotionSameTurn=false ⇒ queryExpander.begin **必须**被调用', () => {
  const { deps, calls } = fake()
  deps.st = { emotionSameTurn: false, recallExpand: true }

  const r = startParallelArms(deps)

  assert.equal(calls.expand.length, 1,
    '★ 旧写法：扩展支嵌在情绪支块里 ⇒ 情绪支一关，扩展支跟着死（这就是 query_expand 全 0 的成因）')
  assert.equal(calls.emotion.length, 0, '情绪支被关掉，不该起')
  assert.equal(r.emotion, false)
  assert.equal(r.expand, true, '返回值也要如实说"扩展支起了"')
})

test('①′ emotionSameTurn=false + recallExpand **不写**（默认开）⇒ 同样要跑扩展', () => {
  const { deps, calls } = fake()
  deps.st = { emotionSameTurn: false }   // recallExpand 缺省 = 不关

  startParallelArms(deps)

  assert.equal(calls.expand.length, 1, '缺省不等于 false')
  assert.equal(calls.emotion.length, 0)
})

// ---- 契约 ②：关掉扩展支，情绪支必须照跑 --------------------------------

test('② ★ recallExpand=false ⇒ sameTurnEmotion.begin 必须被调用、queryExpander **不许**被调用', () => {
  const { deps, calls } = fake()
  deps.st = { emotionSameTurn: true, recallExpand: false }

  const r = startParallelArms(deps)

  assert.equal(calls.emotion.length, 1, '★ 扩展支关掉不该连带情绪支')
  assert.equal(calls.expand.length, 0, '扩展支被关掉，不许起')
  assert.equal(r.emotion, true)
  assert.equal(r.expand, false)
})

// ---- 契约 ③：一支炸了不许带走另一支 -----------------------------------

test('③ ★ 情绪支 begin 抛异常 ⇒ 扩展支**仍然**被调用', () => {
  const { deps, calls } = fake({ emotionThrows: true })
  deps.st = null   // 两支都开

  const r = startParallelArms(deps)

  assert.equal(calls.emotion.length, 1, '先起情绪支（它抛了）')
  assert.equal(calls.expand.length, 1, '★ 情绪支炸了，扩展支必须照跑')
  assert.equal(r.emotion, false, '失败的那支不算"起了"')
  assert.equal(r.expand, true)
  assert.equal(r.errors.length, 1, '失败要留痕')
  assert.match(r.errors[0], /same_turn_emotion/, '要说清是**哪个支**')
})

test('③′ 扩展支 begin 抛异常 ⇒ 情绪支**仍然**被调用', () => {
  const { deps, calls } = fake({ expandThrows: true })
  deps.st = null

  const r = startParallelArms(deps)

  assert.equal(calls.emotion.length, 1, '★ 扩展支炸了，情绪支必须照跑')
  assert.equal(calls.expand.length, 1)
  assert.equal(r.emotion, true)
  assert.equal(r.expand, false)
  assert.match(r.errors[0], /query_expand/, '要说清是哪个支')
})

test('③″ 起跑失败要 warn，且 warn 里带支名（不许只 warning 一句"都失败"）', () => {
  const { deps, calls } = fake({ expandThrows: true })
  startParallelArms(deps)

  assert.equal(calls.warn.length, 1)
  assert.match(calls.warn[0], /query_expand/, 'warn 里必须能看出是哪一支')
  assert.match(calls.warn[0], /查询扩展起不来/, '也要带原始错误')
})

// ---- 其它必须成立的性质 -----------------------------------------------

test('④ 两个开关都关 ⇒ 一支都不起', () => {
  const { deps, calls } = fake()
  deps.st = { emotionSameTurn: false, recallExpand: false }

  const r = startParallelArms(deps)

  assert.equal(calls.emotion.length, 0)
  assert.equal(calls.expand.length, 0)
  assert.equal(calls.settle.length, 0, '连审计工厂都不该被调')
  assert.deepEqual(r.errors, [])
})

test('⑤ st=null（读不到设置）⇒ 两支都开（老默认）', () => {
  const { deps, calls } = fake()
  deps.st = null

  const r = startParallelArms(deps)

  assert.equal(calls.emotion.length, 1)
  assert.equal(calls.expand.length, 1)
  assert.equal(r.emotion, true)
  assert.equal(r.expand, true)
})

test('⑥ ★ 两支的 t0 **各取各的**（不许共用一行）', () => {
  const { deps, calls } = fake()

  startParallelArms(deps)

  const emotionSettle = calls.settle.find((s) => s.arm === 'same_turn_emotion')
  const expandSettle = calls.settle.find((s) => s.arm === 'query_expand')
  assert.ok(emotionSettle, '情绪支要拿到自己的 onSettle')
  assert.ok(expandSettle, '扩展支要拿到自己的 onSettle')
  assert.notEqual(emotionSettle.t0, expandSettle.t0,
    '★ 两个 t0 必须独立（旧代码里它们并排写在同一个块里，扩展支那个还会出作用域）')
  assert.equal(emotionSettle.step, 21)
  assert.equal(expandSettle.step, 22)
})

test('⑦ sid 为空 ⇒ 一支都不起（连审计工厂都不调）', () => {
  const { deps, calls } = fake()
  deps.sid = ''

  const r = startParallelArms(deps)

  assert.equal(calls.emotion.length, 0)
  assert.equal(calls.expand.length, 0)
  assert.equal(calls.settle.length, 0)
  assert.deepEqual(r, { emotion: false, expand: false, errors: [] })
})

test('⑧ 传进来的东西原样交给两支（userText / parent / prevVector）', () => {
  const { deps, calls } = fake()
  startParallelArms(deps)

  const e = calls.emotion[0]
  const x = calls.expand[0]
  assert.equal(e.sid, 'session-1')
  assert.equal(e.opts.userText, '在吗')
  assert.equal(e.opts.parent, deps.agent)
  assert.deepEqual(e.opts.prevVector, [0.1, 0.2])
  assert.equal(typeof e.opts.onSettle, 'function')

  assert.equal(x.sid, 'session-1')
  assert.equal(x.opts.userText, '在吗')
  assert.equal(x.opts.parent, deps.agent)
  assert.equal(typeof x.opts.onSettle, 'function')
  // 扩展支**不需要** prevVector（情绪支专属）
  assert.equal('prevVector' in x.opts, false)
})

test('⑨ 永不抛：连 onSettleOf 自己炸了也不能把这一轮带走', () => {
  const { deps } = fake()
  deps.onSettleOf = () => { throw new Error('审计工厂自己炸了') }

  const r = startParallelArms(deps)   // 不该抛

  assert.equal(r.emotion, false, '构造 onSettle 时炸 ⇒ 这一支算没起')
  assert.equal(r.expand, false)
  assert.equal(r.errors.length, 2, '两支各记一条')
})
