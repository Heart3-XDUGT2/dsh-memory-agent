/**
 * v0.15.0 S15:JSON 修复阶梯(A `core/echo_utils.py:262-323` +
 * `echo_llm_client.py:205-247`)。三条性质各测一遍:
 *   ① **零回归** —— 本来合法的输入逐字不动;
 *   ② 各级修复各修各的(裸换行 / 全角定界符);
 *   ③ 修不动就老实返回 null(不许造出半个对象)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  repairJsonControlChars, normalizeJsonDelimiterQuotes, stripCodeFence, parseJsonLadder
} from '../lib/jsonfix.js'

test('S15 零回归:合法输入逐字不动(A 的承诺 —— 可安全盲用)', () => {
  const legal = '{"a": 1, "b": "两行\\n文本", "c": {"d": [1, 2]}}'
  assert.equal(repairJsonControlChars(legal), legal)
  assert.equal(normalizeJsonDelimiterQuotes(legal), legal)
  assert.equal(stripCodeFence('{"a":1}'), '{"a":1}')
  // 字符串外的换行是合法 JSON 空白,不许动(A 的状态机只管字符串内部)
  const pretty = '{\n  "a": 1,\n  "b": "x"\n}'
  assert.equal(repairJsonControlChars(pretty), pretty)
  assert.deepEqual(parseJsonLadder(pretty), { value: { a: 1, b: 'x' }, level: 0 })
  // 合法输入里的中文引号属于**内容**,一级就解析成功,走不到归一那一步
  const quoted = '{"draft": "他说“你好”"}' // eslint-disable-line
  assert.deepEqual(parseJsonLadder(quoted), { value: { draft: '他说“你好”' }, level: 0 })
})

test('S15 二级修复:字符串内部的裸控制字符', () => {
  const broken = '{"draft": "第一行\n第二行\t带制表符"}'
  assert.throws(() => JSON.parse(broken), '裸换行本来就该解析失败(先证明问题存在)')
  const fixed = repairJsonControlChars(broken)
  assert.equal(fixed, '{"draft": "第一行\\n第二行\\t带制表符"}')
  assert.deepEqual(JSON.parse(fixed), { draft: '第一行\n第二行\t带制表符' })
  assert.deepEqual(parseJsonLadder(broken),
    { value: { draft: '第一行\n第二行\t带制表符' }, level: 1 })
  // 已经转义好的不能被二次转义(反斜杠要认)
  assert.equal(repairJsonControlChars('{"a": "已经\\n转义"}'), '{"a": "已经\\n转义"}')
  // 其他控制字符走 \u 形态
  assert.equal(repairJsonControlChars('{"a": "\u0007"}'), '{"a": "\\u0007"}')
})

test('S15 三级修复:全角引号当定界符(A 实测的形态)', () => {
  const broken = '{“draft”: “杰作?阿岚这两个字砸过来的时候…”}'
  assert.throws(() => JSON.parse(broken))
  assert.equal(normalizeJsonDelimiterQuotes(broken), '{"draft": "杰作?阿岚这两个字砸过来的时候…"}')
  const out = parseJsonLadder(broken)
  assert.equal(out.level, 2)
  assert.deepEqual(out.value, { draft: '杰作?阿岚这两个字砸过来的时候…' })
  // 三级也能顺带修二级(A 的 ③ 只归一、不重扫控制字符,所以
  // 「全角定界符 + 字符串里真换行」A 修不动;本仓垫了第 4 级 —— 见
  // jsonfix.js 的注释,这是对 A 唯一一处行为增强)
  const both = '{“draft”: “第一行\n第二行”}'
  assert.deepEqual(parseJsonLadder(both),
    { value: { draft: '第一行\n第二行' }, level: 3 })
  // 逐级验证:第 3 级修的正是前三级都修不动的那个组合
  assert.throws(() => JSON.parse(normalizeJsonDelimiterQuotes(repairJsonControlChars(both))))
})

test('S15 围栏与截取:剥 ```json、取首尾大括号之间的部分', () => {
  assert.equal(stripCodeFence('```json\n{"a":1}\n```'), '{"a":1}')
  assert.equal(stripCodeFence('```\n{"a":1}\n```'), '{"a":1}')
  const chatty = '好的,结果如下:\n```json\n{"aligned": false, "issue": "拒绝回应"}\n```\n希望有帮助!'
  assert.deepEqual(parseJsonLadder(chatty),
    { value: { aligned: false, issue: '拒绝回应' }, level: 0 })
  // 前后还有别的花括号时,取**最外**一层(A 的 find/rfind)
  assert.deepEqual(parseJsonLadder('前言 {"a": {"b": 1}} 后记'),
    { value: { a: { b: 1 } }, level: 0 })
})

test('S15 修不动就回 null:不造半个对象、非对象一律当失败', () => {
  assert.equal(parseJsonLadder('这里根本没有 JSON'), null)
  assert.equal(parseJsonLadder(''), null)
  assert.equal(parseJsonLadder(null), null)
  assert.equal(parseJsonLadder(42), null)
  assert.equal(parseJsonLadder('{'), null)
  assert.equal(parseJsonLadder('{"a": }'), null)
  // 数组/标量不是我们的契约(A `:233` 只认 dict)
  assert.equal(parseJsonLadder('[1, 2, 3]'), null)
  assert.equal(parseJsonLadder('"just a string"'), null)
  // 截断的 JSON(模型被 max_tokens 切掉)也必须失败,不许猜
  assert.equal(parseJsonLadder('{"summary": "他今天有点累", "keywords": ["累"'), null)
})
