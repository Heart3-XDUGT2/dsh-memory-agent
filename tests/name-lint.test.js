/**
 * 真昵称 lint 的电池(P 批,2026-10-06)。
 *
 * 三段:
 *   ① 判据(纯函数):针怎么来、通用词怎么豁免、词边界怎么防误伤;
 *   ② 白名单:只豁免写清理由的那一条,别的一律拦;
 *   ③ **仓内实扫 = 闸本身**:本仓此刻必须 0 命中(这条就是"防复发"的那颗钉子)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildNeedles, scanText, scanFiles, whitelistedFor, isAsciiWord, GENERIC_NAMES, WHITELIST
} from '../lib/name-lint.js'
import { scanRepo } from '../scripts/check-names.mjs'

// 夹具一律用**中性假值**:真值只活在数据目录的 profile.json 里,仓里不许出现。
const FAKE = {
  userName: '用户',
  userAliases: ['阿岚', '阿乙'],
  agentName: '助手',
  agentSelfRef: '助手',
  agentAliases: ['Echo']
}

test('① 针表:userAliases/agentAliases 全进;通用词与项目公开名被豁免', () => {
  const needles = buildNeedles(FAKE)
  const names = needles.map((n) => n.needle)
  assert.deepEqual(names.sort(), ['阿乙', '阿岚'], '两条真别名都当针(Echo 是项目公开名 ⇒ 不当针;角色槽也不当针)')
  assert.equal(names.includes('用户'), false, '「用户」是角色槽 ⇒ 不拦')
  assert.equal(names.includes('助手'), false, '「助手」是角色槽 ⇒ 不拦')
  assert.equal(names.includes('Echo'), false, 'Echo 是项目自己的公开名 ⇒ 不拦')
  assert.equal(needles.find((n) => n.needle === '阿乙').ascii, false, 'CJK 针不走词边界')
  assert.equal(buildNeedles({ userAliases: ['a', '', '  ', '甲'] }).length, 0, '单字/空白不当针(太容易误伤)')
  assert.deepEqual(buildNeedles(null), [], 'profile 坏 ⇒ 空针表(不崩)')
  assert.deepEqual(buildNeedles({ userAliases: ['甲甲', '甲甲', ' 甲甲 '] }).map((n) => n.needle), ['甲甲'], '去重 + trim')
})

test('① 词边界:ascii 针不误伤"名字是别人词头"的情形', () => {
  const needles = buildNeedles({ userAliases: ['kuro'] }) // 中性 ascii 假针(真值只在 profile.json)
  const n = needles[0]
  assert.equal(n.ascii, true)
  assert.equal(scanText('kuroCount = 1', needles).length, 0, 'kuroCount 不该算命中(词边界)')
  assert.equal(scanText('kuros', needles).length, 0, '带后缀的形态也不算')
  assert.equal(scanText('const x = "kuro"', needles)[0].count, 1)
  assert.equal(scanText('kuro说:在吗', needles)[0].count, 1, 'CJK 挨着 ⇒ 仍是边界')
  assert.equal(scanText('【QQ·私聊】kuro说:在吗', needles)[0].line, 1)
})

test('① 扫描:行号/次数/摘录,大小写不敏感', () => {
  const needles = buildNeedles({ userAliases: ['kuro'], agentAliases: ['阿乙'] })
  const text = '第一行\n第二行 KURO 两次:kuro\n第三行 阿乙'
  const hits = scanText(text, needles)
  const byName = Object.fromEntries(hits.map((h) => [h.needle, h]))
  assert.equal(byName.kuro.count, 2, '大小写不敏感,两次都算')
  assert.equal(byName.kuro.line, 2)
  assert.equal(byName['阿乙'].count, 1)
  assert.equal(byName['阿乙'].line, 3)
  assert.ok(byName.kuro.excerpt.includes('kuro'), '摘录要带上那一行原文(人好去看)')
})

test('② 白名单:只豁免写清理由的那一条,同文件别的针照样拦', () => {
  assert.equal(WHITELIST.length, 1, '白名单只剩"提交身份"那一条(集中在一处)')
  assert.ok(WHITELIST[0].why.length > 10, '白名单必须写清为什么')
  const w = WHITELIST[0]
  assert.equal(whitelistedFor(w.file, w.needle), true)
  assert.equal(whitelistedFor('lib/随便.js', w.needle), false, '白名单是"文件+针"配对,不是整文件豁免')
  const needles = buildNeedles({ userAliases: [w.needle, '阿岚'] })
  const hits = scanFiles([
    { path: w.file, text: '作者 ' + w.needle },
    { path: 'lib/x.js', text: '这里 ' + w.needle + ' 与 阿岚' }
  ], needles)
  assert.equal(hits.length, 2, '白名单文件不报,别的文件照样报(两条针)')
  assert.deepEqual([...new Set(hits.map((h) => h.file))], ['lib/x.js'])
})

test('③ 仓内实扫:本仓此刻 0 命中(防复发的那颗钉子)', (t) => {
  const r = scanRepo()
  if (r.skipped) {
    t.diagnostic('读不到本机 profile.json(换机/清过数据目录)⇒ 只验了降级形状')
    assert.equal(r.hits.length, 0)
    return
  }
  assert.ok(r.needles.length > 0, '针表不能是空的(否则这条闸等于没开)')
  const lines = r.hits.map((h) => h.file + ':' + h.line + ' ' + h.needle + '×' + h.count).slice(0, 12)
  assert.equal(r.hits.length, 0,
    '仓里出现真昵称 ' + r.hits.length + ' 处(测试夹具 阿岚/阿乙、文档 <称呼>):\n    ' + lines.join('\n    '))
})

test('③ 仓内实扫:同一份内容喂给 scanFiles 会报(证明扫描器真的在工作)', () => {
  const needles = buildNeedles(FAKE)
  const hits = scanFiles([{ path: 'lib/假装.js', text: '注释里写了 阿岚 这个人' }], needles)
  assert.equal(hits.length, 1, '有针在文本里就必须报出来')
  assert.equal(hits[0].file, 'lib/假装.js')
})

test('③ 跳过目录:archive/node_modules/.git/.scratch 不扫', async () => {
  const { SKIP_DIRS } = await import('../lib/name-lint.js')
  for (const d of ['archive', 'node_modules', '.git', '.scratch']) {
    assert.ok(SKIP_DIRS.includes(d), d + ' 必须在跳过名单里(存档/依赖不进包)')
  }
  assert.equal(GENERIC_NAMES.includes('Echo'), true, 'Echo 在通用/公开名单里')
  assert.equal(isAsciiWord('kuro'), true)
  assert.equal(isAsciiWord('阿岚'), false)
})
