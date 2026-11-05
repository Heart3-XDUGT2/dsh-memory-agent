/**
 * lib/source-kind.js 的钉子。
 *
 * 背景(现场 2026-10-03 00:06):0.2.0-rc 的 v4 会话格式要求 `source.kind` 是
 * **产出者自有**形状 —— `kind:'plugin'` 会被直接拒绝,报
 * `format v4 message requires a producer-owned source kind`,整轮运行失败;
 * 桥注入的那条就是这么被拦下的(她在 QQ 上从此不回),而子代理会话不走这条路,
 * 一切正常。官方把 v3 旧日志搬进 v4 时提升出来的字面量正是 `plugin:dsh-echo`。
 *
 * 这个文件除了钉纯函数行为,还**扫源码**钉住两条:
 *   1. 四处注入点都必须用 `ECHO_SOURCE_KIND`,不许再手抄旧字面量(防回退);
 *   2. 红线 `lib/relay.js` 一字未动 —— 它仍按旧形状判,衔接靠调用侧的兼容视图。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ECHO_PLUGIN_ID, ECHO_SOURCE_KIND, isEchoSource, legacySourceView
} from '../lib/source-kind.js'

const lib = (name) => readFileSync(new URL(`../lib/${name}`, import.meta.url), 'utf8')

test('产出者 kind 就是官方提升出来的那个字面量,且过得了 v4 的准入', () => {
  assert.equal(ECHO_PLUGIN_ID, 'dsh-echo')
  assert.equal(ECHO_SOURCE_KIND, 'plugin:dsh-echo')
  // 宿主 v4 的准入规则(dsh-session-format-v3-to-v4/lib/index.js:126):
  // kind 必须是非空字符串,且**不等于** 'plugin'。
  const v4Accept = (kind) => typeof kind === 'string' && kind.length > 0 && kind !== 'plugin'
  assert.equal(v4Accept(ECHO_SOURCE_KIND), true, 'v4 必须收下')
  assert.equal(v4Accept('plugin'), false, '旧形状恰恰是它要拒的那个')
})

test('isEchoSource:新形状认、旧形状也认、别家的不认', () => {
  assert.equal(isEchoSource({ kind: ECHO_SOURCE_KIND, form: 'relay' }), true)
  assert.equal(isEchoSource({ kind: 'plugin', plugin: 'dsh-echo', form: 'relay' }), true)
  assert.equal(isEchoSource({ kind: 'plugin', plugin: '别人家的' }), false)
  assert.equal(isEchoSource({ kind: 'plugin:dsh-echo-x' }), false, '前缀像也不算 —— 逐字比')
  assert.equal(isEchoSource({ kind: 'user' }), false)
  assert.equal(isEchoSource({ kind: 'tool' }), false)
  assert.equal(isEchoSource(undefined), false)
  assert.equal(isEchoSource(null), false)
  assert.equal(isEchoSource('plugin:dsh-echo'), false, '字符串不是 source')
})

test('legacySourceView:只给冻结的红线判据折一层,原件不动', () => {
  const now = { kind: ECHO_SOURCE_KIND, form: 'care', rawText: 'x' }
  const view = legacySourceView(now)
  assert.deepEqual(view, { kind: 'plugin', plugin: 'dsh-echo', form: 'care', rawText: 'x' })
  assert.equal(now.kind, ECHO_SOURCE_KIND, '原 source 不能被改')
  assert.equal(now.plugin, undefined)
  const legacy = { kind: 'plugin', plugin: 'dsh-echo', form: 'care' }
  assert.equal(legacySourceView(legacy), legacy, '旧形状原样透传(同一个对象)')
  assert.equal(legacySourceView(undefined), undefined)
  assert.equal(legacySourceView({ kind: 'user' }).kind, 'user', '别人的不动')
})

test('红线 relay.js 没被动过:marksProactive 仍按旧形状判,衔接靠兼容视图', async () => {
  const { marksProactive } = await import('../lib/relay.js')
  assert.match(lib('relay.js'), /source\.kind !== 'plugin' \|\| source\.plugin !== 'dsh-echo'/,
    '红线判据原样(改它就等于动了红线)')
  assert.equal(marksProactive(legacySourceView({ kind: ECHO_SOURCE_KIND, form: 'care' })), true,
    '折了视图它才认 —— 这正是要在调用侧折的原因')
  assert.equal(marksProactive({ kind: ECHO_SOURCE_KIND, form: 'care' }), false,
    '不折视图它不认(所以调用侧不能省这一步)')
})

test('四处注入点都改用了 ECHO_SOURCE_KIND,没留旧字面量', () => {
  for (const [file, count] of [['index.js', 2], ['heartbeat.js', 1], ['turn-stopping.js', 1]]) {
    const src = lib(file)
    const hits = src.split('kind: ECHO_SOURCE_KIND').length - 1
    assert.equal(hits, count, `${file} 应有 ${count} 处注入用 ECHO_SOURCE_KIND`)
    assert.equal(/kind: 'plugin',\s*plugin: 'dsh-echo'/.test(src), false,
      `${file} 不许再手抄旧形状(防回退)`)
  }
})

test('两处可改消费点用容错判定认自己的注入', () => {
  assert.match(lib('turn-query.js'), /if \(isEchoSource\(source\) && isHumanForm\(source\.form\)\)/,
    '回合检索词的入口要容错(否则桥那句变成空查询词)')
  assert.match(lib('index.js'), /if \(isEchoSource\(msg\?\.source\)/,
    '捕获层的「是不是我们注入的」要容错')
  assert.match(lib('index.js'), /marksProactive\(legacySourceView\(msg\.source\)\)/,
    '喂红线判据前必须折兼容视图')
})
