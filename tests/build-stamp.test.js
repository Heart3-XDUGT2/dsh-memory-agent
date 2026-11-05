/**
 * 构建指纹的电池(2026-09-26 审计第一条)。
 *
 * 这条审计说的是:**改完 lib、没重启 dsh web,跑的还是旧代码,而没有任何地方
 * 会告诉你** —— 今天已经因此误判过一次(把「修复没生效」和「一次合规的关怀」
 * 混在一起)。指纹要能用,必须满足四件事,逐条钉在这里:
 *   1. 确定性:同一份代码,两次算出来一模一样(否则没法对比);
 *   2. 敏感:任何一个字节的内容改动都要变(**顺带钉死「装机位与仓库只差
 *      CRLF/LF 时不算改动」** —— 不然这枚指纹每天假报警一次);
 *   3. 只认 .js(README、map 之类不该抖);
 *   4. 活得下去:目录不在也不许抛(插件加载路径上不能因为指纹炸掉)。
 * 另加一条真机断言(`statusPayload()` 里真有它、schema 也声明了它 —— 今天那台
 * 「payload 有、schema 没声明 ⇒ 工具每次调用都被输出校验拒掉」的坑不许重演)
 * 放在 `scripts/check_tools.mjs` 里:那个脚本会临时挂上宿主依赖,**能** import
 * `lib/index.js`(本仓不装 node_modules,`tests/` 里 import 它会直接 ERR_MODULE_NOT_FOUND)。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildStampOf } from '../lib/build-stamp.js'

const fakeFs = (files) => ({
  readdir: () => Object.keys(files),
  readFile: (p) => {
    const name = String(p).split(/[\\/]/).pop()
    if (!(name in files)) throw new Error('ENOENT ' + name)
    return files[name]
  },
  stat: () => ({ mtimeMs: 1000 })
})

test('同一份代码两次算出同一个指纹(不然没法对比版本)', () => {
  const fs = fakeFs({ 'a.js': 'let a = 1\n', 'b.js': 'let b = 2\n' })
  const one = buildStampOf('lib', fs)
  const two = buildStampOf('lib', fs)
  assert.equal(one.short, two.short)
  assert.equal(one.short.length, 12)
  assert.equal(one.files, 2)
})

test('改一个字节就变(这是它存在的全部意义)', () => {
  const before = buildStampOf('lib', fakeFs({ 'a.js': 'let a = 1\n' }))
  const after = buildStampOf('lib', fakeFs({ 'a.js': 'let a = 2\n' }))
  assert.notEqual(before.short, after.short)
})

test('改名也算改(文件名进哈希)', () => {
  const one = buildStampOf('lib', fakeFs({ 'a.js': 'x\n' }))
  const two = buildStampOf('lib', fakeFs({ 'b.js': 'x\n' }))
  assert.notEqual(one.short, two.short)
})

test('装机位与仓库只差 CRLF/LF ⇒ 指纹必须相同(否则每天假报警)', () => {
  const lf = buildStampOf('lib', fakeFs({ 'a.js': 'let a = 1\nlet b = 2\n' }))
  const crlf = buildStampOf('lib', fakeFs({ 'a.js': 'let a = 1\r\nlet b = 2\r\n' }))
  assert.equal(lf.short, crlf.short)
})

test('只认 .js:README/日志之类的抖动不许改指纹', () => {
  const one = buildStampOf('lib', fakeFs({ 'a.js': 'x\n', 'README.md': '一' }))
  const two = buildStampOf('lib', fakeFs({ 'a.js': 'x\n', 'README.md': '二' }))
  assert.equal(one.short, two.short)
  assert.equal(one.files, 1, 'files 只数 .js')
})

test('目录不在 ⇒ 给 unknown,不许抛(插件加载路径不能被它炸)', () => {
  const s = buildStampOf('lib', {
    readdir: () => { throw new Error('ENOENT') },
    readFile: () => '',
    stat: () => ({ mtimeMs: 0 })
  })
  assert.equal(s.short, 'unknown')
  assert.equal(s.files, 0)
})
