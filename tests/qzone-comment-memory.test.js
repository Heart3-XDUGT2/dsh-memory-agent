/**
 * 空间评论进记忆 —— 2026-10-19（第三件）
 * ==================================================================
 * 他拍的：**评论进记忆，记成「空间事件」，不进用户画像**。
 *
 * 三个关键点：
 *   ① `capture.qzoneComment` 是**独立一格**，不塞进 `userText`
 *      —— 那条通道专属于他本人（`speakerIsMaster`：群里别人的话也不进）。
 *      硬塞会把「别人在她的说说下评论」记成「他跟我说过」。
 *   ② 落库 `source='qzone'`、`layer=''` ⇒ **不进 L0/L1**
 *      （L0 = 每轮强制注入的核心层，见 `lib/cleanup-guard.js:52-54`）。
 *   ③ 白名单的**过滤**在 `dsh-echo-qq` 的 `classifyComment`（那边已有 11 条测试）；
 *      这边只负责"收到 space 事件之后怎么记"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { snapshotCapture, commitExtract } from '../lib/reflect.js'

const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')

/**
 * 造一个"什么都记下来"的假 store。
 * 用 Proxy 兜住 commitExtract 会摸到的所有方法 —— 只关心 insertMemory 的入参。
 */
function fakeStore () {
  const calls = { insert: [], audit: [], state: [] }
  const base = {
    getState: () => ({ moodIntensity: 3, prevMoodIntensity: 3, emotionVector: {}, userId: '' }),
    insertMemory: (args) => { calls.insert.push(args); return 123 },
    setName: () => true,
    saveState: (s) => { calls.state.push(s); return true },
    writeAudit: (a) => { calls.audit.push(a); return true },
    getProfile: () => ({}),
    topEntityNames: () => []
  }
  const store = new Proxy(base, {
    get (target, key) {
      if (key in target) return target[key]
      if (typeof key === 'symbol') return undefined
      // 没实现的都当空操作，别让 commitExtract 半路炸
      return () => null
    }
  })
  return { store, calls }
}

/** 一份最小的 extract 结果（commitExtract 只要求 summary 非空）。 */
const extractOf = () => ({
  keywords: ['空间评论'],
  summary: '阿岚在她的说说下评论了「不错啊」',
  emotionScore: 3,
  askKeys: [],
  name: '',
  moodIntensity: 3,
  emotionState: '',
  moodReason: '',
  emotionVector: {}
})

test('① ★ commitExtract 把 source / layer 原样落到 insertMemory', () => {
  const { store, calls } = fakeStore()
  commitExtract(store, extractOf(), {
    userText: '【空间评论】阿岚 在你的说说下评论了：「不错啊」',
    assistantText: '嗯，看到啦',
    source: 'qzone',
    layer: ''
  })
  assert.equal(calls.insert.length, 1, '应当写了一条记忆')
  assert.equal(calls.insert[0].source, 'qzone', '★ 来源必须标成 qzone（不是用户画像）')
  assert.equal(calls.insert[0].layer, '', '★ layer 为空 ⇒ 不进 L0/L1')
})

test('② 默认仍是 dsh + 空层（他本人说话那条路一个字不变）', () => {
  const { store, calls } = fakeStore()
  commitExtract(store, extractOf(), { userText: '在吗', assistantText: '在' })
  assert.equal(calls.insert[0].source, 'dsh', '不传 source 时保持老默认')
  assert.equal(calls.insert[0].layer, '')
})

test('③ ★ snapshotCapture 带上 qzoneComment（否则轮末看不见它）', () => {
  const snap = snapshotCapture({
    userText: '',
    assistantText: '嗯，看到啦',
    qzoneComment: '【空间评论】阿岚 在你的说说下评论了：「不错啊」',
    sessionId: 's1'
  })
  assert.equal(snap.userText, '', '★ 空间事件不写 userText（那条通道专属于他）')
  assert.equal(snap.qzoneComment, '【空间评论】阿岚 在你的说说下评论了：「不错啊」')
  // 没有这个字段时是空串（向后兼容）
  assert.equal(snapshotCapture({}).qzoneComment, '')
})

test('④ ★ 静态闸：轮末的空捕获闸要放行"只有空间事件"的轮', () => {
  const src = read('../lib/index.js')
  assert.match(src, /if \(\(!snap\.userText && !snap\.qzoneComment\) \|\| !snap\.assistantText\) return/,
    '★ 只写 userText 的闸会把这轮吞掉 —— 空间评论轮 userText 本来就是空的')
})

test('⑤ ★ 静态闸：反思调用要按来源分岔（他说话 = dsh / 只有空间事件 = qzone）', () => {
  const src = read('../lib/index.js')
  assert.match(src, /source: snap\.userText !== '' \? 'dsh' : 'qzone'/,
    '★ 来源要按"有没有 userText"分岔')
  assert.match(src, /layer: ''/, '★ layer 必须留空（不进 L0/L1）')
  assert.match(src, /userText: snap\.userText !== '' \? snap\.userText : snap\.qzoneComment/,
    '空间评论轮要拿 qzoneComment 当这一轮的用户侧内容')
})

test('⑥ ★ 静态闸：capture 要有 qzoneComment，且轮末要清', () => {
  const src = read('../lib/index.js')
  assert.match(src, /qzoneComment: '',/, 'captureOf 初始化必须有这一格')
  assert.match(src, /capture\.qzoneComment = ''/, '★ 轮末必须清 —— 否则一条评论会污染之后每一轮')
})

test('⑦ ★ 静态闸：订阅只处理 space（主人那条走用户通道）', () => {
  const src = read('../lib/index.js')
  assert.match(src, /if \(String\(ev\.kind \|\| ''\) !== 'space'\) return/,
    '★ master 不在这里处理 —— 他说话仍走 injectInbound 的 isMaster 通道')
  assert.match(src, /captureOf\(agent\.session\)\.qzoneComment = text/,
    '注入前要先记进 capture，否则轮末反思看不见')
  assert.match(src, /typeof qz\.onComment !== 'function'/, '空间服务没暴露 onComment 时要静默跳过')
})

test('⑧ 端到端形状：一条 space 事件走完 commitExtract 后，记忆是 qzone + 空层', () => {
  const { store, calls } = fakeStore()
  const qzoneText = '【空间评论】阿岚 在你的说说下评论了：「不错啊」'
  const snap = snapshotCapture({ userText: '', assistantText: '嗯，看到啦', qzoneComment: qzoneText, sessionId: 's1' })
  // 模拟 index.js 里那份分岔
  const userText = snap.userText !== '' ? snap.userText : snap.qzoneComment
  const source = snap.userText !== '' ? 'dsh' : 'qzone'
  commitExtract(store, extractOf(), { userText, assistantText: snap.assistantText, source, layer: '' })
  assert.equal(calls.insert[0].source, 'qzone')
  assert.equal(calls.insert[0].layer, '')
  assert.equal(userText, qzoneText, 'extract 看到的是空间事件那一段')
})
