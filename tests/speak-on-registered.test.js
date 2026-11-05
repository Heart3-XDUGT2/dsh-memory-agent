/**
 * 「嘴一出现就叫我这句」—— 2026-09-28 现场事故的电池。
 *
 * 事故形状:退役旧桥后,"她有嘴吗"从**配置**(总闸,启动那一刻就 true)变成
 * **注册**(渠道插件晚几秒才自报家门)。而 `echo_qq_say`/`echo_qq_call` 这两只工具
 * **只能注册、没法注销** ⇒ 主包启动那一瞬判一次是不够的:判早了(宿主先起、渠道
 * 插件后到)手就永远不登记,她的提示词却是动态读 `hasChannel()` 的 ⇒ 她会一直去试
 * 一只不存在的手(`unknown tool`),话全卡在手里,他一个字收不到。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSpeaker } from '../lib/speak.js'

test('onRegistered:嘴后到 ⇒ 第一个渠道一进来就叫醒(启动顺序不许决定她有没有手)', () => {
  const speaker = createSpeaker({})
  const calls = []
  speaker.onRegistered(() => calls.push('hand'))
  assert.deepEqual(calls, [], '还没渠道 ⇒ 先排队等着')
  assert.equal(speaker.hasChannel(), false)

  speaker.registerChannel({ name: 'qq', status: () => ({ enabled: true }) })
  assert.deepEqual(calls, ['hand'], '渠道注册的那一瞬就叫醒')
  assert.equal(speaker.hasRegisteredChannels(), true)

  speaker.registerChannel({ name: 'qq2' })
  assert.deepEqual(calls, ['hand'], '第二个渠道不再重复叫(手只能注册一次 ⇒ 钩子只叫一次)')
})

test('onRegistered:已经有渠道 ⇒ 立刻回调(快路,不用等)', () => {
  const speaker = createSpeaker({})
  speaker.registerChannel({ name: 'qq' })
  const calls = []
  speaker.onRegistered(() => calls.push('hand'))
  assert.deepEqual(calls, ['hand'])
})

test('onRegistered:排队中的钩子能被撤销(渠道一直不来时不留垃圾)', () => {
  const speaker = createSpeaker({})
  const calls = []
  const off = speaker.onRegistered(() => calls.push('a'))
  const off2 = speaker.onRegistered(() => calls.push('b'))
  off()
  assert.equal(typeof off2, 'function')
  speaker.registerChannel({ name: 'qq' })
  assert.deepEqual(calls, ['b'], '撤掉的那个不许被叫;留下的照叫')
})

test('onRegistered:钩子抛错不许把渠道注册带崩,也不许挡住后面的钩子', () => {
  const speaker = createSpeaker({})
  const calls = []
  speaker.onRegistered(() => { throw new Error('我炸了') })
  speaker.onRegistered(() => calls.push('b'))
  assert.doesNotThrow(() => speaker.registerChannel({ name: 'qq' }))
  assert.deepEqual(calls, ['b'], '坏钩子只吞掉自己')
  assert.equal(speaker.hasRegisteredChannels(), true, '渠道照样注册上了')
})

test('onRegistered:只认函数(乱传东西不给它留位置)', () => {
  const speaker = createSpeaker({})
  const off = speaker.onRegistered(null)
  assert.equal(typeof off, 'function')
  assert.doesNotThrow(() => speaker.registerChannel({ name: 'qq' }))
})
