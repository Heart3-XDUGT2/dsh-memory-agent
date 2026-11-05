/**
 * v0.30.1「中午没消息」缺陷①的接线钉:陪伴会话随桥常驻。
 *
 * 2026-09-27 现场:02:50 电脑睡眠 → 09:47 想念越线(没人跑)→
 * 11:54 dsh web 起来,想念 7.52 仍过线 → 陪伴会话懒创建,agent 不
 * 存在,心跳挂在 agent 上 → 没人替她开口 → 13:07 他的「在吗」才把
 * 会话造出来,那条消息本身又把想念削到线下。
 *
 * index.js 是插件入口(挂满宿主服务),没有单件台架 —— 照
 * session-toggle.test.js 的先例钉源码形状:块在、闸在、退避在、
 * 清理在、懒路径兜底还在。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const indexSrc = readFileSync(join(here, '../lib/index.js'), 'utf8')
const relaySrc = readFileSync(join(here, '../lib/relay.js'), 'utf8')

test('常驻块:有嘴(mouthOpen)就 ensureCompanion,带退避重试与卸载清理', () => {
  const start = indexSrc.indexOf('v0.30.1 修「中午没消息」缺陷①')
  // 切片到下一个可读标签为止:常驻块 + 它后面那句 onRegistered 补判都要在窗口里
  const end = indexSrc.indexOf('// ---- 1. 人格注入 ----', start)
  assert.ok(start !== -1, '常驻块必须存在(2026-09-27 中午现场)')
  assert.ok(end > start, '常驻 effect 要有可读标签')
  const block = indexSrc.slice(start, end)
  assert.ok(block.includes("'echo.companionResident()'"), '常驻 effect 要有可读标签')
  // S3-b:门从 `relayEnabled()` 扩成 `mouthOpen()`(旧桥总闸 **或** 有渠道插件自报家门)。
  // 没插件注册时两者逐字等价 ⇒ 行为不变;退役旧桥之后,只要插件在,心跳就还有人跑
  // (否则"她够得到他的手机"这句承诺又会在没人跑心跳的夜里落空 —— v0.30.1 那个坑)。
  //
  // ⚠️ 2026-09-28 早上又栽一次:块本身写在 `if (mouthOpen()) {` 里 ⇒ 启动那一瞬
  // 门是关的 ⇒ **常驻一次都没跑过** ⇒ 她的 agent 不存在 ⇒ 60s tick 没地方挂
  // ⇒ 她再也没能先开口(引擎侧 shouldCare=true,careCount 停在 09-26)。
  // 所以门进函数体、启动判一次、`speaker.onRegistered` 再补判一次(与③⑥同一修法)。
  assert.ok(block.includes('const startResident = () => {'), '常驻要能"再判一次",不能只判启动那一刻')
  assert.ok(block.includes('if (residentStarted || !mouthOpen()) return'), '没有嘴时不建 —— 谈不上承诺')
  assert.ok(block.includes('speaker.onRegistered(startResident)'), '嘴一出现就补判常驻(启动窗口的救命绳)')
  assert.equal(block.includes('if (relayEnabled())'), false, '别偷偷退回旧门')
  assert.ok(block.includes('ensureCompanion()'), '启动即建陪伴会话(agent 在,心跳才在)')
  assert.ok(block.includes('setTimeout(settle'), '宿主未就绪要退避重试,不是一次失败就放弃')
  assert.ok(block.includes('clearTimeout(timer)'), '插件卸载要清掉挂着的重试')
})

test('懒路径保留:入站仍然 ensureCompanion(常驻是心跳的充分条件,不是传话的必要条件)', () => {
  assert.ok(relaySrc.includes('ensureCompanion()'),
    'relay.js 的入站懒创建不许被这次修删掉 —— 常驻失败时它仍是兜底')
})
