/**
 * 审计面板映射 —— reflection / reflection_failed 归到「提取」档（2026-10-19）
 * ==================================================================
 * 现场（他报「反思在审计界面看不见」）：
 *
 *   数据其实**早就有了**（漏解包装修好之后 10-19 成功 4 次，游标 467→496），
 *   但两个面板各自归错了格：
 *
 *   ① `audit-cards.html` 的 `N2S` **没有 `reflection` / `reflection_failed`**
 *      ⇒ `stepOf` 依次查 step → tool_call → stage → trace_id#，三处全是 0
 *      ⇒ `gk` 返回 `u` ⇒ 整固行掉进「未标注（没有 stage / step）」
 *
 *   ② `audit-view.js` 的 `TOOL_BUCKET` 有 `reflection` 但**漏了 `reflection_failed`**
 *      ⇒ 落默认 `other` 桶
 *      ⇒ 而 `app.js:801` 的 `CONTENT_BUCKETS = ['talk','her','reflect']` 是
 *        「对话优先」档的**白名单** ⇒ 默认档位下整固失败被整个滤掉
 *
 * 两处都归到「提取」族：`BUCKETS.reflect` 的定义本来就写着
 * 「把这一轮收成记忆（提取器旁白 / **记忆整固**）」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

// ── 把 audit-cards.html 的归类函数抠出来（stepOf / gk / N2S）
function loadCardsClassifier () {
  const h = read('../web/audit-cards.html')
  const a = h.indexOf('const ST=[0,')
  const b = h.indexOf('const gname=')
  assert.ok(a > 0 && b > a, '抽不到 stepOf/gk 段')
  const code = h.slice(a, b).replace(/\bconst /g, 'var ').replace(/\blet /g, 'var ')
  const out = {}
  // eslint-disable-next-line no-new-func
  new Function('out', code + '\n; out.stepOf=stepOf; out.gk=gk; out.N2S=N2S;')(out)
  return out
}

// ── audit-view.js 整个模块
function loadView () {
  const src = read('../web/audit-view.js')
  const sb = {}
  // eslint-disable-next-line no-new-func
  new Function('globalThis', src)(sb)
  return sb.EchoAuditView
}

/** 真实的整固行形状（下划线字段，与 audit-cards 内部一致）。 */
const reflectionRow = (toolCall) => ({
  tool_call: toolCall,
  stage: 'reflection',
  step: 0,
  user_input: toolCall === 'reflection' ? '(记忆整固·过阈)' : '(记忆整固·失败)',
  trace_id: 't-' + toolCall
})

test('① ★ audit-cards：reflection 归到「7 提取」，不再是「未标注」', () => {
  const C = loadCardsClassifier()
  assert.equal(C.N2S.reflection, 7, '★ N2S 必须有 reflection:7')
  const g = C.gk(reflectionRow('reflection'))
  assert.equal(g, 's7', '★ 应归 s7（第 7 格「提取」），实际 ' + g)
  assert.notEqual(g, 'u', '★ 不许再掉进「未标注」')
})

test('② ★ audit-cards：reflection_failed 也归「7 提取」', () => {
  const C = loadCardsClassifier()
  assert.equal(C.N2S.reflection_failed, 7, '★ N2S 必须有 reflection_failed:7')
  assert.equal(C.gk(reflectionRow('reflection_failed')), 's7')
})

test('③ ★ audit-view：reflection_failed 归 reflect 桶（原来落 other）', () => {
  const V = loadView()
  V.setProfile({ userName: '阿岚', agentName: 'Echo' })
  assert.equal(V.classify({ toolCall: 'reflection_failed' }).bucket, 'reflect',
    '★ 失败整固要归 reflect；原来落 other 会被「对话优先」档整个滤掉')
  assert.equal(V.classify({ toolCall: 'reflection' }).bucket, 'reflect', '成功那条本来就对，别改坏')
})

test('④ ★ 默认档位（对话优先）能看到 reflection_failed', () => {
  const V = loadView()
  V.setProfile({ userName: '阿岚', agentName: 'Echo' })
  // 这是 app.js:801 的 CONTENT_BUCKETS —— 白名单，「对话优先」档只显示它们
  const CONTENT_BUCKETS = ['talk', 'her', 'reflect']
  for (const tc of ['reflection', 'reflection_failed']) {
    const bucket = V.classify({ toolCall: tc }).bucket
    assert.ok(CONTENT_BUCKETS.includes(bucket),
      '★ ' + tc + ' 的桶是 ' + bucket + '，不在对话优先白名单里 ⇒ 默认档位看不见')
  }
  // contentRows 用同一个默认白名单，再验一次行为
  const rows = [
    { toolCall: 'relay_in', userInput: 'a', traceId: '1' },
    { toolCall: 'reflection_failed', userInput: '(记忆整固·失败)', traceId: '2' },
    { toolCall: 'reflection', userInput: '(记忆整固·过阈)', traceId: '3' }
  ]
  const kept = V.contentRows(rows, 10)
  assert.equal(kept.length, 3, '★ 三行都该留在「对话优先」里，实际留下 ' + kept.length)
})

test('⑤ 别的行没被这次改动带偏（回归闸）', () => {
  const V = loadView()
  V.setProfile({ userName: '阿岚', agentName: 'Echo' })
  assert.equal(V.classify({ toolCall: 'relay_in' }).bucket, 'talk')
  assert.equal(V.classify({ toolCall: 'extract' }).bucket, 'reflect')
  assert.equal(V.classify({ toolCall: 'structured_output' }).bucket, 'machine')

  const C = loadCardsClassifier()
  assert.equal(C.gk({ tool_call: 'extract', stage: 'extract', step: 7, trace_id: 'x' }), 's7')
  assert.equal(C.gk({ tool_call: 'relay_in', stage: '', step: 0, trace_id: 'y' }), 's1',
    'relay_in 靠 tool_call 映射到 1，不能坏')
})
