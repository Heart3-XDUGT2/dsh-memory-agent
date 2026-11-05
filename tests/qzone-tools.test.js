/**
 * QQ 空间那三只手（echo_qzone_post / _read / _delete）—— 工具层电池（2026-10-15 第 2 步）。
 *
 * 盯的是**主包这一侧**该守的东西（服务侧的判据由 `dsh-echo-qq` 自己的
 * `test/qzone.test.mjs` 盯）：
 *
 *   · 拿不到服务 / 服务关着 → **诚实拒绝**（不静默、不假装）
 *   · 会话不在射程里 → 拒绝（工作会话不该往空间发东西）
 *   · **权限不许隐式** → 非法值当场拒；服务侧还有第二道（那边会真拒）
 *   · **删是不可逆的** → tid 形状不对就拒（挡住"随手编一个"）
 *   · 每个输出都必须是**无损 JSON**（宿主第二道校验，`relay-tools.test.js` 那条疤）
 *   · `output.schema` 声明了返回的每一个字段（`additionalProperties:false` 漏一个就整个被拒）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { qzoneToolDefinitions, explainQzoneFailure, QZONE_TID_RE, lossless } from '../lib/relay-tools.js'

/** 无损 JSON（与 relay-tools.test.js 同款判据）。 */
function assertLossless (label, value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value,
    label + ' 不是无损 JSON(键在、值 undefined 是常见原因)')
  const walk = (v, path) => {
    if (v === undefined) assert.fail(label + ' 里 ' + path + ' 是 undefined')
    if (typeof v === 'number' && !Number.isFinite(v)) assert.fail(label + ' 里 ' + path + ' 不是有限数')
    if (typeof v === 'function' || typeof v === 'bigint' || typeof v === 'symbol') {
      assert.fail(label + ' 里 ' + path + ' 不是 JSON 值(' + typeof v + ')')
    }
    if (v !== null && typeof v === 'object') {
      for (const [k, sub] of Object.entries(v)) walk(sub, path + '.' + k)
    }
  }
  walk(value, '$')
}

/** 假空间服务：只记下她被要求做了什么。 */
function make (opts = {}) {
  const calls = { post: [], list: [], del: [], audit: [], reply: [], comments: [], feeds: [] }
  const svc = opts.svc === undefined
    ? {
        status: () => ({ enabled: opts.enabled !== false }),
        postMood: async (o) => {
          calls.post.push(o)
          return opts.postResult ?? { ok: true, tid: 'aa2a7fe154c7cf6ae02d0600', whoCanSee: o.whoCanSee ?? 1 }
        },
        listMoods: async (o) => {
          calls.list.push(o)
          return opts.listResult ?? {
            ok: true,
            items: [{ tid: 'aa2a7fe154c7cf6ae02d0600', content: '你好', createdAtText: '2026-10-15 02:17', likes: 1, comments: 0, imageCount: 1 }],
            hasMore: false
          }
        },
        deleteMood: async (tid) => {
          calls.del.push(tid)
          return opts.delResult ?? { ok: true, tid }
        },
        // ★ 2026-10-19：回复评论（成功形状与删说说一致 ⇒ 复用同一套 schema）
        replyComment: async (o) => {
          calls.reply.push(o)
          return opts.replyResult ?? { ok: true, tid: o.tid }
        },
        // ★ 2026-10-20：读评论（补 reply 的眼）
        // ★ 2026-10-20：好友动态（按白名单过滤）
        listFeeds: async (o) => {
          calls.feeds.push(o)
          return opts.feedsResult ?? {
            ok: true, count: 1, scanned: 3, watchlistSize: 1,
            items: [{ tid: 'tid-f1', uin: '200222', name: '阿岚', content: '动态', at: 1792000000, comments: 1, likes: 2 }]
          }
        },
        listComments: async (o) => {
          calls.comments.push(o)
          return opts.commentsResult ?? {
            ok: true, tid: o.tid, total: 1,
            // ★ 2026-10-20：真实服务会带 postUin；**没给就留空**（不装成自己的号）
            postUin: o.postUin || '',
            items: [{ commentId: 'c1', uin: '200222', name: '阿岚', content: '不错', at: 1792000000, isReply: false }]
          }
        }
      }
    : opts.svc
  const defs = qzoneToolDefinitions({
    qzoneOf: () => (opts.off === true ? null : svc),
    sessionEnabledOf: (sid) => (opts.inScope === false ? false : sid === 'session-echo-companion'),
    audit: (label, tool) => calls.audit.push({ label, tool })
  })
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]))
  return { defs, byName, calls, exec: { agent: { session: { id: opts.sid ?? 'session-echo-companion' } } } }
}

// ============================================================================
// ① 三个工具在不在 / 名字对不对
// ============================================================================

test('三个工具:发 / 读 / 删分开 —— 她的自我认识靠名字', () => {
  const t = make()
  assert.deepEqual(t.defs.map((d) => d.name), ['echo_qzone_post', 'echo_qzone_read', 'echo_qzone_comments', 'echo_qzone_feed', 'echo_qzone_space', 'echo_qzone_delete', 'echo_qzone_reply'])
  for (const d of t.defs) {
    assert.ok(String(d.description || '') !== '', d.name + ' 没有描述')
    assert.ok(d.parameters && typeof d.parameters === 'object', d.name + ' 没有 parameters')
    assert.ok(d.output && d.output.schema, d.name + ' 没有 output.schema')
    assert.equal(typeof d.output.render, 'function', d.name + ' 没有 render')
    assert.equal(typeof d.execute, 'function', d.name + ' 没有 execute')
  }
})

test('描述里必须说清「那是你的空间,别人能看见」+ 权限取值', () => {
  const d = make().byName.echo_qzone_post
  assert.ok(d.description.includes('QQ 空间'), '要说清在哪发')
  assert.ok(d.description.includes('别人能看见'), '要说清可见性')
  for (const v of ['1=', '4=', '16=', '64=', '128=']) {
    assert.ok(d.description.includes(v), '描述里要列出权限取值,缺 ' + v)
  }
})

test('删那个工具的描述必须写明**不可逆** + 先读后删', () => {
  const d = make().byName.echo_qzone_delete
  assert.ok(d.description.includes('收不回来') || d.description.includes('不可逆'), '要写明不可逆')
  assert.ok(d.description.includes('echo_qzone_read'), '要教她先读后删')
})

// ============================================================================
// ② 服务闸 / 射程闸 —— 诚实拒绝
// ============================================================================

test('服务不在 ⇒ 三个工具都回 qzone-off(诚实拒绝,不假装)', async () => {
  const t = make({ off: true })
  for (const name of ['echo_qzone_post', 'echo_qzone_read', 'echo_qzone_delete']) {
    const r = await t.byName[name].execute({ content: 'x', tid: 'aa2a7fe154c7cf6ae02d0600', whoCanSee: 1 }, t.exec)
    assert.equal(r.ok, false, name + ' 该拒')
    assert.equal(r.reason, 'qzone-off')
    assert.ok(String(r.note).includes('空间'), '要给人话:' + r.note)
    assertLossless(name, r)
  }
})

test('服务关着 ⇒ qzone-disabled', async () => {
  const t = make({ enabled: false })
  const r = await t.byName.echo_qzone_read.execute({}, t.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'qzone-disabled')
  assertLossless('read', r)
})

test('服务对象是坏的 / status 抛错 ⇒ 也当关着(不冒泡)', async () => {
  const t = make({ svc: { status: () => { throw new Error('炸了') } } })
  const r = await t.byName.echo_qzone_read.execute({}, t.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'qzone-disabled')
})

test('会话不在射程里 ⇒ out-of-scope(工作会话不该往空间发东西)', async () => {
  const t = make({ inScope: false })
  const r = await t.byName.echo_qzone_post.execute({ content: 'x', whoCanSee: 1 }, t.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'out-of-scope')
  assert.equal(t.calls.post.length, 0, '★ 射程外不许真发')
})

test('拿不到会话 ⇒ no-session', async () => {
  const t = make()
  const r = await t.byName.echo_qzone_read.execute({}, { agent: { session: { id: '' } } })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no-session')
})

// ============================================================================
// ③ 发说说：权限不许隐式
// ============================================================================

test('★ 发说说:权限给非法值 ⇒ 当场拒,且**不调服务**', async () => {
  const t = make()
  for (const bad of [0, 2, 3, 99, -1, 7]) {
    const r = await t.byName.echo_qzone_post.execute({ content: 'x', whoCanSee: bad }, t.exec)
    assert.equal(r.ok, false, String(bad) + ' 该拒')
    assert.equal(r.reason, 'ugc-right-required')
  }
  assert.equal(t.calls.post.length, 0, '★ 校验必须在调服务之前')
})

test('发说说:不传权限 ⇒ 走服务侧默认(服务自己判),但要把 null 传下去而不是编一个', async () => {
  const t = make()
  const r = await t.byName.echo_qzone_post.execute({ content: 'x' }, t.exec)
  assert.equal(r.ok, true)
  assert.equal(t.calls.post.length, 1)
  assert.equal(t.calls.post[0].whoCanSee, null, '不传 = null(交给服务侧的面板默认值),不是我们替她决定')
})

test('发说说:正文空 ⇒ 拒,不调服务', async () => {
  const t = make()
  const r = await t.byName.echo_qzone_post.execute({ content: '   ', whoCanSee: 1 }, t.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'content-required')
  assert.equal(t.calls.post.length, 0)
})

test('发说说:成功 ⇒ 回 tid + 权限,且**留审计**', async () => {
  const t = make()
  const r = await t.byName.echo_qzone_post.execute({ content: '今天天气不错', whoCanSee: 64 }, t.exec)
  assert.equal(r.ok, true)
  assert.equal(r.tid, 'aa2a7fe154c7cf6ae02d0600')
  assert.equal(r.whoCanSee, 64)
  assert.equal(t.calls.post[0].whoCanSee, 64)
  assert.equal(t.calls.audit.length, 1)
  assert.equal(t.calls.audit[0].tool, 'echo_qzone_post')
  assertLossless('post', r)
})

test('发说说:服务说失败 ⇒ 翻成人话,且**不留成功审计**', async () => {
  const t = make({ postResult: { ok: false, reason: 'not-logged-in' } })
  const r = await t.byName.echo_qzone_post.execute({ content: 'x', whoCanSee: 1 }, t.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-logged-in')
  assert.ok(String(r.note).includes('过期'), '要说人话:' + r.note)
  assert.equal(t.calls.audit.length, 0, '失败了不该留成功审计')
  assertLossless('post-fail', r)
})

test('发说说:服务抛错 ⇒ 兜住,不冒泡', async () => {
  const t = make({ svc: { status: () => ({ enabled: true }), postMood: async () => { throw new Error('炸了') } } })
  const r = await t.byName.echo_qzone_post.execute({ content: 'x', whoCanSee: 1 }, t.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'bridge-failed')
  assertLossless('post-throw', r)
})

test('发说说:图片传下去了(数组),空数组也传', async () => {
  const t = make()
  await t.byName.echo_qzone_post.execute({ content: 'x', whoCanSee: 1, images: ['http://a/1.png'] }, t.exec)
  assert.deepEqual(t.calls.post[0].images, ['http://a/1.png'])
  await t.byName.echo_qzone_post.execute({ content: 'x', whoCanSee: 1 }, t.exec)
  assert.deepEqual(t.calls.post[1].images, [])
})

// ============================================================================
// ④ 读说说
// ============================================================================

test('读说说:成功 ⇒ items 字段齐 + 无损', async () => {
  const t = make()
  const r = await t.byName.echo_qzone_read.execute({ num: 3, pos: 0 }, t.exec)
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.deepEqual(Object.keys(r.items[0]).sort(), ['at', 'comments', 'content', 'images', 'likes', 'tid'])
  assert.equal(t.calls.list[0].num, 3)
  assert.equal(t.calls.list[0].withImages, false, '默认不要图片 base64(省流量)')
  assertLossless('read', r)
})

test('读说说:num 越界被钳住(1~20)', async () => {
  const t = make()
  await t.byName.echo_qzone_read.execute({ num: 999 }, t.exec)
  assert.equal(t.calls.list[0].num, 20)
  await t.byName.echo_qzone_read.execute({ num: 0 }, t.exec)
  assert.equal(t.calls.list[1].num, 5, '0 当没给 ⇒ 默认 5')
})

test('读说说:空列表 ⇒ 仍 ok,count=0', async () => {
  const t = make({ listResult: { ok: true, items: [], hasMore: false } })
  const r = await t.byName.echo_qzone_read.execute({}, t.exec)
  assert.equal(r.ok, true)
  assert.equal(r.count, 0)
  assert.deepEqual(r.items, [])
  assertLossless('read-empty', r)
})

test('读说说:服务说失败 ⇒ 翻人话', async () => {
  const t = make({ listResult: { ok: false, reason: 'network' } })
  const r = await t.byName.echo_qzone_read.execute({}, t.exec)
  assert.equal(r.ok, false)
  assert.ok(String(r.note).includes('桥'), '要说人话:' + r.note)
  assertLossless('read-fail', r)
})

// ============================================================================
// ⑤ 删说说：tid 形状 + 不可逆
// ============================================================================

test('★ 删说说:tid 形状不对 ⇒ 拒,且**不调服务**', async () => {
  const t = make()
  for (const bad of ['', '  ', '123', 'not-a-tid', 'ZZZZZZZZZZZZZZZZ', '<script>']) {
    const r = await t.byName.echo_qzone_delete.execute({ tid: bad }, t.exec)
    assert.equal(r.ok, false, JSON.stringify(bad) + ' 该拒')
    assert.ok(r.reason === 'tid-required' || r.reason === 'bad-tid', '理由要分清:' + r.reason)
  }
  assert.equal(t.calls.del.length, 0, '★ 形状不对一个都不许发出去')
})

test('删说说:tid 形状对 ⇒ 发出 + 留审计', async () => {
  const t = make()
  const tid = 'aa2a7fe154c7cf6ae02d0600'
  const r = await t.byName.echo_qzone_delete.execute({ tid }, t.exec)
  assert.equal(r.ok, true)
  assert.equal(r.tid, tid)
  assert.deepEqual(t.calls.del, [tid])
  assert.equal(t.calls.audit.length, 1)
  assert.equal(t.calls.audit[0].tool, 'echo_qzone_delete')
  assertLossless('delete', r)
})

test('tid 正则:认得实测那个 24 位 hex,不认短/非 hex', () => {
  assert.ok(QZONE_TID_RE.test('aa2a7fe154c7cf6ae02d0600'))
  assert.ok(QZONE_TID_RE.test('AA2A7FE154C7CF6AE02D0600'), '大写也认')
  assert.ok(!QZONE_TID_RE.test('aa2a7fe1'))
  assert.ok(!QZONE_TID_RE.test('zz2a7fe154c7cf6ae02d0600'))
  assert.ok(!QZONE_TID_RE.test(''))
})

// ============================================================================
// ⑥ 通用：schema 与实现同步 + 无损
// ============================================================================

test('★ 每个工具的输出字段都在 schema 里声明了(漏一个就整个被宿主拒)', async () => {
  const t = make()
  const cases = [
    ['echo_qzone_post', { content: 'x', whoCanSee: 1 }],
    ['echo_qzone_read', {}],
    ['echo_qzone_delete', { tid: 'aa2a7fe154c7cf6ae02d0600' }]
  ]
  for (const [name, args] of cases) {
    const d = t.byName[name]
    const declared = new Set(Object.keys(d.output.schema.properties ?? {}))
    const r = await d.execute(args, t.exec)
    for (const k of Object.keys(r)) {
      assert.ok(declared.has(k), name + ' 返回了没声明的字段:' + k)
    }
  }
})

test('每个工具在失败路径上也是无损的', async () => {
  const t = make({ off: true })
  for (const [name, args] of [
    ['echo_qzone_post', { content: 'x', whoCanSee: 1 }],
    ['echo_qzone_read', {}],
    ['echo_qzone_delete', { tid: 'aa2a7fe154c7cf6ae02d0600' }]
  ]) {
    const r = await t.byName[name].execute(args, t.exec)
    assertLossless(name + '-fail', r)
  }
})

test('render:成功与失败都给得出一句话(她会读到)', async () => {
  const t = make()
  const okPost = await t.byName.echo_qzone_post.execute({ content: '你好', whoCanSee: 64 }, t.exec)
  const r1 = t.byName.echo_qzone_post.output.render({ content: '你好' }, okPost)
  assert.equal(Array.isArray(r1), true)
  assert.ok(String(r1[0].text).includes('只有你自己'), '要告诉她这条谁能看见:' + r1[0].text)

  const badPost = { ok: false, reason: 'network', note: explainQzoneFailure('network') }
  const r2 = t.byName.echo_qzone_post.output.render({ content: '你好' }, badPost)
  assert.ok(String(r2[0].text).includes('没发出去'), '失败要说清:' + r2[0].text)

  const okRead = await t.byName.echo_qzone_read.execute({}, t.exec)
  const r3 = t.byName.echo_qzone_read.output.render({}, okRead)
  assert.ok(String(r3[0].text).includes('tid='), '要给出 tid(她删的时候要用)')

  const okDel = await t.byName.echo_qzone_delete.execute({ tid: 'aa2a7fe154c7cf6ae02d0600' }, t.exec)
  const r4 = t.byName.echo_qzone_delete.output.render({}, okDel)
  assert.ok(String(r4[0].text).includes('删掉了'))
})

test('explainQzoneFailure:认识的翻人话,不认识的兜底不吞', () => {
  assert.ok(explainQzoneFailure('qzone-off').includes('空间'))
  assert.ok(explainQzoneFailure('not-logged-in').includes('过期'))
  assert.equal(explainQzoneFailure('什么鬼'), '什么鬼', '不认识的 reason 原样透出,不编')
  assert.equal(explainQzoneFailure(undefined), '没成功')
})

test('lossless:值为 undefined 的键根本不出现', () => {
  const o = lossless({ ok: true, reason: undefined, tid: 'x', n: undefined })
  assert.deepEqual(Object.keys(o).sort(), ['ok', 'tid'])
})

test('★ 回复评论：缺 targetUin 当场拒（白名单闸要用它）', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_reply.execute({ tid: 'abcdef0123456789abcdef01', content: '谢谢' }, t2.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'target-required')
})

test('★ 回复评论：tid 形状不对就拒（挡住随手编一个）', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_reply.execute({ tid: '乱写', content: '谢谢', targetUin: '200222' }, t2.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'bad-tid')
})

test('★ 回复评论：白名单拒的时候把原因说人话', async () => {
  const t2 = make({
    replyResult: { ok: false, reason: 'not-in-watchlist', note: '这个人不在空间白名单(qzoneWatchList)里,不回复。' }
  })
  const r = await t2.byName.echo_qzone_reply.execute(
    { tid: 'abcdef0123456789abcdef01', content: '谢谢', targetUin: '400444' }, t2.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-in-watchlist')
  assert.ok(String(r.note || '').includes('白名单'), '要说明是白名单挡的:' + String(r.note))
})

test('★ 回复评论：正常路径把参数原样交给服务', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_reply.execute(
    { tid: 'abcdef0123456789abcdef01', content: '谢谢', targetUin: '200222', commentId: 'c-9' }, t2.exec)
  assert.equal(r.ok, true, JSON.stringify(r))
  const seen = t2.calls.reply[0]
  assert.equal(seen.tid, 'abcdef0123456789abcdef01')
  assert.equal(seen.content, '谢谢')
  assert.equal(seen.targetUin, '200222')
  assert.equal(seen.replyCommentId, 'c-9')
})


test('★ 读评论：缺 tid 当场拒', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_comments.execute({}, t2.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'tid-required')
})

test('★ 读评论：tid 形状不对就拒（同删说说那道闸）', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_comments.execute({ tid: '乱写' }, t2.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'bad-tid')
})

test('★ 读评论：正常路径把 tid/num/pos 交给服务，且返回无损 JSON', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_comments.execute(
    { tid: 'abcdef0123456789abcdef01', num: 5, pos: 0 }, t2.exec)
  assert.equal(r.ok, true, JSON.stringify(r))
  const seen = t2.calls.comments[0]
  assert.equal(seen.tid, 'abcdef0123456789abcdef01')
  assert.equal(seen.num, 5)
  assert.equal(r.count, 1)
  assert.equal(r.items[0].uin, '200222')
  assertLossless('echo_qzone_comments 的返回', r)
})


test('★ 好友动态：白名单空 ⇒ 说人话（不退化成全看）', async () => {
  const t2 = make({ feedsResult: { ok: false, reason: 'watchlist-empty', note: '空间评论白名单是空的' } })
  const r = await t2.byName.echo_qzone_feed.execute({}, t2.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'watchlist-empty')
})

test('★ 好友动态：正常路径把 count 交给服务，返回无损 JSON', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_feed.execute({ count: 7 }, t2.exec)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(t2.calls.feeds[0].count, 7)
  assert.equal(r.count, 1)
  assert.equal(r.watchlistSize, 1)
  assert.equal(r.items[0].uin, '200222')
  assertLossless('echo_qzone_feed 的返回', r)
})


test('★ 看某人空间：缺 qq 当场拒', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_space.execute({}, t2.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'qq-required')
})

test('★ 看某人空间：qq 不像号就拒', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_space.execute({ qq: '乱写' }, t2.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'bad-qq')
})

test('★ 看某人空间：名单外 ⇒ not-in-watchlist（白名单闸在服务侧）', async () => {
  const t2 = make({ listResult: { ok: false, reason: 'not-in-watchlist', note: '这个人不在空间白名单里' } })
  const r = await t2.byName.echo_qzone_space.execute({ qq: '999999' }, t2.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-in-watchlist')
})

test('★ 看某人空间：正常路径把 uin 交给服务，返回无损 JSON', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_space.execute({ qq: '200222', count: 3 }, t2.exec)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(t2.calls.list[0].uin, '200222', '★ uin 要透给服务（不是写死自己）')
  assert.equal(t2.calls.list[0].num, 3)
  assert.equal(r.qq, '200222')
  assertLossless('echo_qzone_space 的返回', r)
})


// ---- ★ 2026-10-20：relay 透传 note / reply 独立 render / postUin ---------------

test('★ relay 不吞 note：桥的原话要能透出来（回归钉）', async () => {
  // 桥的真实拒绝：reason=bridge-failed，note 是 QZone 的原话
  const t2 = make({ replyResult: { ok: false, reason: 'bridge-failed', note: '系统繁忙(-10000)' } })
  const r = await t2.byName.echo_qzone_reply.execute(
    { tid: 'abcdef0123456789abcdef01', content: 'x', targetUin: '200222' }, t2.exec)
  assert.equal(r.ok, false)
  // ★ 改前这里会是 '空间服务说这次不行'（泛化文案），真因被 relay() 丢了
  assert.equal(r.note, '系统繁忙(-10000)', '★ 桥的原话必须透出来')
})

test('★ relay 没给 note 时才退回泛化文案', async () => {
  const t2 = make({ replyResult: { ok: false, reason: 'bridge-failed' } })
  const r = await t2.byName.echo_qzone_reply.execute(
    { tid: 'abcdef0123456789abcdef01', content: 'x', targetUin: '200222' }, t2.exec)
  assert.equal(r.ok, false)
  assert.equal(r.note, explainQzoneFailure('bridge-failed'))
})

test('★ reply 成功时 render 说「回复了」，**不是**「删掉了」', async () => {
  const t2 = make({ replyResult: { ok: true, tid: 'abcdef0123456789abcdef01', postUin: '300333' } })
  const r = await t2.byName.echo_qzone_reply.execute(
    { tid: 'abcdef0123456789abcdef01', content: 'x', targetUin: '200222', postUin: '300333' }, t2.exec)
  assert.equal(r.ok, true)
  const [block] = t2.byName.echo_qzone_reply.output.render({}, r)
  assert.match(block.text, /^回复了/, '★ 不能再说"删掉了"')
  assert.ok(!block.text.includes('删'), '★ 不能出现"删"字')
  assert.ok(block.text.includes('300333'), '要带上帖主')
})

test('★ reply 失败时 render 说「回复失败」，**不是**「没删成」', async () => {
  const t2 = make({ replyResult: { ok: false, reason: 'bridge-failed', note: '风控' } })
  const r = await t2.byName.echo_qzone_reply.execute(
    { tid: 'abcdef0123456789abcdef01', content: 'x', targetUin: '200222' }, t2.exec)
  const [block] = t2.byName.echo_qzone_reply.output.render({}, r)
  assert.match(block.text, /^回复失败/, '★ 不能再说"没删成"')
  assert.ok(!block.text.includes('删'), '★ 不能出现"删"字')
  assert.ok(block.text.includes('风控'), '要带上桥的原话')
})

test('★ postUin 透传给服务（别人的说说）', async () => {
  const t2 = make()
  await t2.byName.echo_qzone_reply.execute(
    { tid: 'abcdef0123456789abcdef01', content: 'x', targetUin: '200222', postUin: '300333' }, t2.exec)
  assert.equal(t2.calls.reply[0].postUin, '300333', '★ 要透传下去')
})

test('★ postUin 不像 QQ 号 ⇒ 当场拒（不调服务）', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_reply.execute(
    { tid: 'abcdef0123456789abcdef01', content: 'x', targetUin: '200222', postUin: '乱写' }, t2.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'bad-post-uin')
  assert.equal(t2.calls.reply.length, 0)
})

test('★ postUin 不在白名单 ⇒ post-not-in-watchlist 说人话', async () => {
  const t2 = make({ replyResult: { ok: false, reason: 'post-not-in-watchlist', note: '这条说说属于 400444，他不在空间白名单里' } })
  const r = await t2.byName.echo_qzone_reply.execute(
    { tid: 'abcdef0123456789abcdef01', content: 'x', targetUin: '200222', postUin: '400444' }, t2.exec)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'post-not-in-watchlist')
  assert.ok(String(r.note).includes('400444'), '要把是谁说出来')
})

test('★ 读评论的返回里带 postUin（她才知道拿去 reply 用哪个帖主）', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_comments.execute({ tid: 'abcdef0123456789abcdef01' }, t2.exec)
  assert.equal(r.ok, true, JSON.stringify(r))
  // ★ 没传 postUin ⇒ 服务留空（不编）。**关键是它不是 undefined** ——
  //   commentsSchema 是 additionalProperties:false，声明了就必须是 string。
  assert.equal(r.postUin, '', '★ 不知道就留空，别装成自己的号')
  assertLossless('echo_qzone_comments 的返回', r)
})


test('★ 读评论：显式 postUin 要透传给服务，并原样回包', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_comments.execute(
    { tid: 'abcdef0123456789abcdef01', postUin: '300333' }, t2.exec)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(t2.calls.comments[0].postUin, '300333', '★ 要透传下去')
  assert.equal(r.postUin, '300333', '★ 回包要带回来，她才拿得到 reply 要的帖主')
})

test('★ render 显示**完整 QQ**（她要拿它当 targetUin / postUin）', async () => {
  const t2 = make()
  const r = await t2.byName.echo_qzone_comments.execute(
    { tid: 'abcdef0123456789abcdef01', postUin: '300333' }, t2.exec)
  const [block] = t2.byName.echo_qzone_comments.output.render({}, r)
  assert.ok(block.text.includes('200222'), '评论人完整 QQ 要出现（原来是 #0222）')
  assert.ok(!block.text.includes('#0222'), '不该再是后 4 位')
})
