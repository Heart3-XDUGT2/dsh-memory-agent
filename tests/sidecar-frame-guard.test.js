/**
 * sidecar-client 的帧长防线(**一个进程都不 spawn**)。
 * ============================================================
 * 为什么单独一个文件:`tests/sidecar.test.js` 打的是真子进程,而沙箱里
 * spawn + 管道会 EPERM(那 7 个用例在本机跑不起来)。这道防线纯字符串可测 ——
 * 没必要跟着一起瞎。
 *
 * v0.42.0 审计修复(P1:防线形同虚设):长度检查原来在 `while` 循环**里面** ——
 * 它只看「切走一行之后剩下的残留」。而这里真正要防的病态输入是**一个没有换行的
 * 巨大 chunk**(worker 崩坏、或别的程序往标准输出灌二进制):`indexOf('\n') < 0`
 * ⇒ 循环一次都不进 ⇒ 一次都不检查,`_lineBuf` 一直涨到把内存吃光。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SidecarClient } from '../lib/sidecar-client.js'

const clientOf = () => new SidecarClient({ pythonPath: 'python', workerPath: 'w.py', dbPath: ':memory:' })

test('没有换行的巨大 chunk 也要被杀(防线不许待在循环里)', () => {
  const c = clientOf()
  c._onStdout('x'.repeat(1024 * 1024 + 1))
  assert.match(String(c._lastError), /exceeds 1MiB/)
})

test('残留超限(最后一段没换行)也要被杀', () => {
  const c = clientOf()
  c._onStdout('{"type":"pong"}\n' + 'y'.repeat(1024 * 1024 + 1))
  assert.match(String(c._lastError), /exceeds 1MiB/)
})

test('正常帧照旧:切行、解析、不让缓冲区留下垃圾,也不误杀', () => {
  const c = clientOf()
  const seen = []
  c._onLine = (line) => seen.push(line) // 换掉下游:本用例只验切行
  c._onStdout('{"a":1}\n{"b":2}\n')
  assert.deepEqual(seen, ['{"a":1}', '{"b":2}'])
  assert.equal(c._lineBuf, '', '切完不许留残渣')
  assert.equal(c._lastError, '', '正常帧不许被杀')

  // 分片到达(一个 JSON 被两次 chunk 切开)也要能拼回来
  const seen2 = []
  c._onLine = (line) => seen2.push(line)
  c._onStdout('{"partial":')
  c._onStdout('true}\n')
  assert.deepEqual(seen2, ['{"partial":true}'])
  assert.equal(c._lastError, '')
})
