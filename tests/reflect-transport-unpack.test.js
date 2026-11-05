/**
 * `reflectTransport()` 必须**解包** `.transport` —— 2026-10-18
 * ==================================================================
 * 现场（他报「审计面板显示她的记忆整固功能一直失败」）：
 *
 *   `reflection_state.last_at = 2026-10-05 03:25` —— 游标 13 天没动，
 *   全库 `tool_call='reflection'` **0 行**，只有 `reflection_failed` 7 行，
 *   原因 7/7 完全相同：「LLM 未产出结构化结果(游标不动,下轮重试)」。
 *
 * 根因**不在 LLM**，在调用点：
 *
 *   `index.js:1397` 的 `reflectTransport(sid)` 返回的是**包装对象**
 *   `{ transport, note }`（2026-10-06 `b1dd6044` 改的），
 *   但三处**内联直传**没跟着取 `.transport`：
 *     · `runReflection(reflectTransport(), …)`   ← 记忆整固
 *     · `callTransport(reflectTransport(), …)`   ← 话题复盘
 *     · `callTransport(reflectTransport(), …)`   ← 漂移体检
 *
 *   ⇒ `callTransport` 看 `transport.mode === 'llm'` —— 包装对象没有 `mode`
 *   ⇒ 落到 `runStructured(transport, args)`
 *   ⇒ `runStructured` 第一行 `if (typeof subagents.list !== 'function') return null`
 *   ⇒ **null**（实测：包装对象无论 llm 还是 subagents 模式都返回 null，
 *      而且 `llm.structured` **一次都没被调到** —— 请求根本没发出去）。
 *
 * 这个文件把那三条教训钉成闸：
 *   ① **内联直传**（`xxx(reflectTransport(...), …)`）**必须**跟 `.transport`；
 *   ② **赋值形式**（`const t = reflectTransport(...)`）允许，但那个变量
 *      必须在别处被 `.transport` 取过；
 *   ③ 包装对象长什么样（`{ transport, note }`）不许再被当成 transport 直传。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SRC = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
const LINES = SRC.split('\n')

/** 找出所有「真的在调用」reflectTransport 的行（排除定义与注释）。 */
function callLines () {
  const out = []
  LINES.forEach((s, i) => {
    const t = s.trim()
    if (t.startsWith('//') || t.startsWith('*')) return
    if (!s.includes('reflectTransport(')) return
    if (s.includes('const reflectTransport =')) return    // 定义行
    out.push({ n: i + 1, line: s })
  })
  return out
}

test('① ★ 内联直传必须取 .transport（这就是记忆整固 13 天全败的那个 bug）', () => {
  const bad = []
  for (const { n, line } of callLines()) {
    // 赋值形式：`= reflectTransport(...)` ⇒ 另判（见 ②）
    if (/=\s*reflectTransport\s*\(/.test(line)) continue
    // 其余都是「直接当参数传出去」⇒ 必须紧跟 .transport
    const re = /reflectTransport\s*\([^()]*\)\s*\.transport/
    if (!re.test(line)) bad.push('L' + n + ': ' + line.trim())
  }
  assert.deepEqual(bad, [],
    '★ 这些地方把 reflectTransport() 的**包装对象** {transport, note} 直接传进 callTransport/runReflection —— '
    + '它没有 .mode 也没有 .list，会一路走到 runStructured 的 return null，'
    + '表现成「LLM 未产出结构化结果」但模型其实一次都没被调用:\n  ' + bad.join('\n  '))
})

test('② 赋值形式允许，但那个变量必须在别处被 .transport 取过', () => {
  const bad = []
  for (const { n, line } of callLines()) {
    const m = line.match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*reflectTransport\s*\(/)
    if (!m) continue
    const varName = m[1]
    // 同一行后面就有 .transport 也行
    if (new RegExp(varName + '\\s*\\.transport').test(line)) continue
    // 否则全文找 `变量.transport`
    const used = new RegExp('\\b' + varName + '\\s*\\.\\s*transport\\b').test(SRC)
    if (!used) bad.push('L' + n + ' 变量 ' + varName + ' 没被 .transport 取过')
  }
  assert.deepEqual(bad, [], '★ 赋值了就要解包，否则同样是包装对象直传:\n  ' + bad.join('\n  '))
})

test('③ 包装对象的形状没变（{ transport, note }）—— 形态变了这条闸就得重写', () => {
  // 找定义块
  const at = SRC.indexOf('const reflectTransport = (sid) => {')
  assert.ok(at > 0, 'reflectTransport 的定义必须在')
  const block = SRC.slice(at, at + 2400)
  assert.match(block, /return\s*\{[\s\S]{0,400}?transport:/,
    '★ reflectTransport 返回的必须是包装对象（带 transport 键）—— '
    + '如果哪天改成直接返回 transport，本文件的 ①② 两条闸就要跟着改')
  assert.ok(block.includes('note:'), '包装对象还要带 note（面板上的"为什么走这条"靠它）')
})

test('④ 三处已知调用点都在，且都解包了（回归时一眼看得出哪处又漏了）', () => {
  const need = [
    { key: 'runReflection(reflectTransport().transport', why: '记忆整固（reflection）' },
    { key: 'callTransport(reflectTransport().transport', why: '话题复盘 / 漂移体检' }
  ]
  for (const { key, why } of need) {
    assert.ok(SRC.includes(key), '★ ' + why + ' 的那处又漏解包了（找不到 `' + key + '`）')
  }
  // runReflection 只有一处**调用**（记忆整固）；import 是解构形式，不带括号
  const runRefl = (SRC.match(/runReflection\(/g) || []).length
  assert.equal(runRefl, 1, 'runReflection 应只被调用一次（记忆整固），实际 ' + runRefl)
})

test('⑤ 行为：包装对象确实会被 runStructured 吞成 null（不是猜的）', async () => {
  const { callTransport } = await import('../lib/reflect.js')
  const hits = []
  const llmTransport = {
    mode: 'llm',
    structured: async () => { hits.push('llm'); return { via: 'llm' } }
  }
  const args = { prompt: 'p', schema: {}, label: 'probe', parent: null, signal: null }
  const wrapped = await callTransport({ transport: llmTransport, note: '直调' }, args)
  assert.equal(wrapped, null, '★ 包装对象进去必须是 null —— 这就是那 13 天的表现')
  assert.deepEqual(hits, [], '★★ 而且 llm 通道一次都不该被调到（请求根本没发出去）')
  // 解包后则正常
  const ok = await callTransport(llmTransport, args)
  assert.deepEqual(ok, { via: 'llm' }, '解包后应当正常拿到结果')
  assert.deepEqual(hits, ['llm'], '解包后 llm 才真的被调到')
})
