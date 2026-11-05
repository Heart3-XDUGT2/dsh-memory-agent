/**
 * 无限递归的闭环回归(v0.41.0 事故修复)。
 *
 * 这一份不测「某个函数返回什么」,而是**把闭环本身搭出来**,看它到底闭不闭得上:
 *
 *   他开口 → claim → 情绪打分器起一个子代理 → 宿主把任务投进孩子的 inbox
 *   → **孩子开轮也 claim 一次** → 打分器又起一个子代理 → ……(宿主卡死)
 *
 * 环上的每一环都是**真的**,逐环有宿主源码可查:
 *   · 子代理的初始任务经 `child.followup(createUserMessage({ source:{kind:'user'} }))`
 *     投递(`dsh-subagent-in-process-driver/lib/index.js:207-210`)⇒ 孩子在
 *     `latestDirectUserText` 眼里就是「用户这一轮说的话」;
 *   · `agent/inbox/claimed` 是**按 agent 派发**的(宿主 `agentEvents()` 把
 *     `agent` 融进载荷),插件的 `ctx.on` 挂在根上下文 ⇒ 子代理的 claim 一样收得到;
 *   · 打分器的每一次调用都是一次 `subagents.start`(真 LLM 调用)。
 *
 * 所以这份电池的重点是两件事:
 *   ① **结构性**(不靠调用方记性):就算接线处**故意不设**「子代理会话」前置闸
 *      (模拟将来有人把判据挪走/忘了加),`createSameTurnScorer.begin` 与
 *      `runStructured` 里那两道闸也必须把环咬断 —— 深度停在 1;
 *   ② 跳过要**记账**(`skippedSubagent`),不许静默(静默失败是 P2 那次
 *      45 小时无人察觉的教训)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSameTurnScorer } from '../lib/emotion-score.js'
import { runStructured } from '../lib/reflect.js'

const SCORE_OK = {
  global: { fatigue: 2, valence: -3, arousal: 5 },
  target_master: { affection: 6, playfulness: 4, sadness: 1, dependency: 5 },
  intensity: 6,
  reason: '他那句"我今天好累"'
}

/**
 * 宿主替身:够真的最小模型 ——
 *   · `subagents.start` 起一个**子代理会话**(header 逐字照抄宿主
 *     `childSessionMeta()`),随后像宿主那样把它自己的任务 claim 一次;
 *   · claim 的接线**照抄 index.js**,但**故意少掉**那一层
 *     `!isSubagentSession(agent)` 前置闸 —— 要验的就是深处那两道。
 */
function makeHost () {
  const log = { started: [], claims: [], startedFrom: [] }
  const root = { session: { id: 'session-echo-companion', header: { delegationDepth: 0 } } }

  const scorer = createSameTurnScorer({
    run: (prompt, schema, parent) => runStructured(subagents, {
      prompt, schema, label: 'echo-emotion', parent, signal: null
    })
  })

  const subagents = {
    list: () => ['spawn'],
    start: async (provider, req) => {
      const parent = req?.parent
      const depth = Number(parent?.session?.header?.delegationDepth ?? 0) + 1
      const id = 'sub-' + String(depth) + '-' + String(log.started.length + 1)
      log.started.push(id)
      log.startedFrom.push(String(parent?.session?.id ?? '?'))
      const child = {
        session: {
          id,
          header: { origin: 'subagent', parentSession: String(parent?.session?.id ?? ''), delegationDepth: depth }
        }
      }
      // 宿主把任务投进孩子的 inbox;孩子开轮 ⇒ claim(这一拍就是环)
      claim(child, '你只做一件事:读下面这句话之后,Echo 的情绪变成什么样。')
      return {
        result: Promise.resolve({ stopReason: 'completed', structured: SCORE_OK }),
        dispose: async () => { }
      }
    }
  }

  function claim (agent, message) {
    log.claims.push(String(agent?.session?.id ?? '?'))
    scorer.begin(String(agent?.session?.id ?? ''), { userText: message, parent: agent })
  }

  return { log, root, claim, scorer, rootSid: 'session-echo-companion' }
}

test('v0.41.0 闭环:子代理的 claim 不会再起子代理 —— 深度停在 1(没有前置闸也咬得住)', async () => {
  const host = makeHost()
  // 他开口那一刻(与 index.js 同款接线:claim → begin)
  host.claim(host.root, '阿岚,我今天好累')
  // 等闭环跑完(打分那一趟 + 孩子那一拍)
  const got = await host.scorer.take(host.rootSid)
  await new Promise((r) => setImmediate(r))

  assert.equal(host.log.started.length, 1, '只许起一个子代理(他那轮的读数)—— 起第二个就是递归回来了')
  assert.deepEqual(host.log.startedFrom, [host.rootSid], '那一个子代理的 parent 必须是他那个顶层会话')
  assert.deepEqual(host.log.claims, [host.rootSid, 'sub-1-1'], '孩子确实 claim 过一次(闭环确实搭出来了)')
  assert.notEqual(got, null, '他那轮照常拿到读数(闸不许误伤他这一边)')
  assert.equal(got.score.intensity, 6)
  const st = host.scorer.stats()
  assert.equal(st.started, 1)
  assert.equal(st.skippedSubagent, 1, '孩子那一拍必须记成 skippedSubagent —— 跳过不许静默')
})

test('v0.41.0 闭环:就算有人绕过 begin() 直接调结构化通道,总闸也回 null', async () => {
  const host = makeHost()
  const child = { session: { id: 'sub-9', header: { origin: 'subagent', parentSession: 'session-echo-companion', delegationDepth: 3 } } }
  const out = await runStructured({
    list: () => ['spawn'],
    start: async () => { host.log.started.push('VIOLATION'); throw new Error('不该走到这里') }
  }, { prompt: 'x', schema: null, label: 'echo-emotion', parent: child, signal: null })
  assert.equal(out, null)
  assert.deepEqual(host.log.started, [], '绕不过去:subagents.start 一次都没被调到')
})
