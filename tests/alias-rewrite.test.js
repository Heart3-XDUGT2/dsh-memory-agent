/**
 * G2 的电池:改了称呼之后,记忆里的旧名该按现在的称呼写 —— 而且**只动记忆**。
 *
 * 两条纪律各有一个测试守着:
 *   ① 不许改历史(共享轮次/他的原话里出现的旧名一个字不动);
 *   ② 换不动的时候要说得出理由(太短 / 互为子串 / 同一个人),而不是悄悄不换。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rewriteRetiredAliases, splitAliases, shouldRewrite, ALIAS_MAX_HITS } from '../lib/alias-rewrite.js'

test('G2:记忆里的旧称呼换成现在的称呼', () => {
  const r = rewriteRetiredAliases('[记忆] 阿柴说他今天面试炸了;阿柴的猫叫团子', {
    current: '阿澈', retired: ['阿柴']
  })
  assert.equal(r.changed, true)
  assert.equal(r.text, '[记忆] 阿澈说他今天面试炸了;阿澈的猫叫团子')
  assert.deepEqual(r.hits, [{ from: '阿柴', count: 2 }], '改了几处要数得出来')
})

test('G2:多个旧名一起换;跳过的必须留下理由(不许无声)', () => {
  // 2 字的旧名照换(阈值就是 2 字)
  const r = rewriteRetiredAliases('阿柴和小柴都走了', { current: '阿澈', retired: ['阿柴', '小柴'] })
  assert.equal(r.text, '阿澈和阿澈都走了')
  assert.deepEqual(r.hits.map((h) => h.from).sort(), ['小柴', '阿柴'])
  // 1 字的旧名不换 —— 会把「柴犬」这种词切坏,而且理由要写在 skipped 里
  const r2 = rewriteRetiredAliases('柴和柴犬', { current: '阿澈', retired: ['柴'] })
  assert.equal(r2.text, '柴和柴犬', '单字旧名不许换')
  assert.deepEqual(r2.skipped, [{ from: '柴', why: '太短(会切坏别的词)' }])
  assert.equal(r2.changed, false)
})

test('G2:互为子串的一对不许换(「阿柴」/「柴」这种替换会伤到别的词)', () => {
  assert.equal(shouldRewrite('阿柴', '柴').ok, false)
  assert.equal(shouldRewrite('柴', '阿柴').ok, false)
  assert.equal(shouldRewrite('阿柴', '阿柴').ok, false)
  assert.equal(shouldRewrite('阿澈', '阿柴').ok, true)
  const r = rewriteRetiredAliases('阿柴说', { current: '阿柴', retired: ['阿柴'] })
  assert.equal(r.changed, false)
})

test('G2:命中数有封顶(宁可少改几处,不许把一整块重写一遍)', () => {
  const text = Array.from({ length: ALIAS_MAX_HITS + 7 }, () => '阿柴').join(' ')
  const r = rewriteRetiredAliases(text, { current: '阿澈', retired: ['阿柴'] })
  assert.equal(r.hits[0].count, ALIAS_MAX_HITS, '改了封顶那么多处')
  assert.equal(r.text.split('阿澈').length - 1, ALIAS_MAX_HITS)
  assert.equal(r.text.split('阿柴').length - 1, 7, '剩下的原样留着')
})

test('G2:缺名字 / 空文本 ⇒ 一个字不动,也不抛', () => {
  assert.equal(rewriteRetiredAliases('阿柴在', { current: '', retired: ['阿柴'] }).changed, false)
  assert.equal(rewriteRetiredAliases('', { current: '阿澈', retired: ['阿柴'] }).changed, false)
  assert.equal(rewriteRetiredAliases(null, { current: '阿澈', retired: ['阿柴'] }).text, '')
  assert.equal(rewriteRetiredAliases('阿柴在', { current: '阿澈', retired: [] }).changed, false)
})

test('G2:旧名清单的拆法(逗号/顿号/空白都认,去重)', () => {
  assert.deepEqual(splitAliases('阿柴, 小柴、阿柴\n 铁蛋'), ['阿柴', '小柴', '铁蛋'])
  assert.deepEqual(splitAliases(''), [])
  assert.deepEqual(splitAliases(['阿柴', '阿柴']), ['阿柴'])
  assert.deepEqual(splitAliases(undefined), [])
})
