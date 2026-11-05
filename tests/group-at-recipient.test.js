/**
 * 032：群聊接收对象必须在原话之前明确，未知身份不能写成确定否定。
 * 配合 tests/_isolate.mjs；只用虚构信封，不访问 QQ、模型或用户数据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseEnvelope, renderInboundText } from '../lib/relay.js'

const BODY = '你看这个，刚才是在问你'
const rawEnvelope = (patch = {}) => ({
  v: 1, platform: 'qq',
  chat: { id: '33', type: 'group' },
  sender: { id: '11', name: '甲', isMaster: false },
  text: BODY, msgId: 'recipient-case',
  ...patch
})

function render (patch = {}) {
  const raw = rawEnvelope(patch)
  const original = structuredClone(raw)
  const parsed = parseEnvelope(raw)
  assert.equal(parsed.ok, true)
  const text = renderInboundText(parsed.value)
  assert.deepEqual(raw, original, '不得改原始信封')
  assert.equal(parsed.value.text, raw.text, '提示不得进入记忆查询与无文字判据')
  return { env: parsed.value, text }
}

function prefixOf (text, body = BODY) {
  const at = text.indexOf('说:' + body)
  assert.ok(at > 0, '原话仍完整存在')
  return text.slice(0, at)
}

test('032：确定只@他人，正文前明确未@Echo并保留自然参与空间', () => {
  const { text } = render({
    atMe: false, atMeKnown: true, atOthers: [{ qq: '22', name: '乙' }]
  })
  const prefix = prefixOf(text)
  assert.match(prefix, /本条没有@Echo/)
  assert.match(prefix, /正文中的[“「]你[”」]/)
  assert.match(prefix, /旁听.*自然参与/)
  assert.doesNotMatch(prefix, /禁止回复|不许回复/)
  assert.match(text, /甲@了 乙/)
})

for (const name of ['Echo', '你', '甲', '']) {
  test('032：他人昵称为' + (name || '空') + '仍按结构化目标区分', () => {
    const { text } = render({
      atMe: false, atMeKnown: true, atOthers: [{ qq: '22', name }]
    })
    assert.match(prefixOf(text), /本条没有@Echo/)
    assert.doesNotMatch(prefixOf(text), /本条明确@了Echo/)
    assert.match(text, name === '' ? /QQ22/ : new RegExp(name))
  })
}

for (const atOthers of [[], [{ qq: '22', name: '乙' }], [{ qq: 'all', name: '' }]]) {
  test('032：真正@Echo及混合目标保留被点名事实 ' + atOthers.length + ':' + (atOthers[0]?.qq ?? 'self'), () => {
    const { text } = render({ atMe: true, atMeKnown: true, atOthers })
    assert.match(prefixOf(text), /本条明确@了Echo/)
    assert.doesNotMatch(prefixOf(text), /本条没有@Echo|没有单独@Echo/)
    assert.match(text, /@了你/)
    if (atOthers[0]?.qq === '22') assert.match(text, /还@了 乙/)
  })
}

for (const atOthers of [
  [{ qq: 'all', name: '' }],
  [{ qq: '0', name: '' }],
  [{ qq: 'all', name: 'Echo' }, { qq: '22', name: '乙' }]
]) {
  test('032：@全体成员是群体通知，不写成只@其他人 ' + atOthers.length, () => {
    const { text } = render({ atMe: false, atMeKnown: true, atOthers })
    const prefix = prefixOf(text)
    assert.match(prefix, /群体通知/)
    assert.match(prefix, /没有单独@Echo/)
    assert.doesNotMatch(prefix, /只@了其他|本条没有@Echo/)
    assert.match(text, /全体成员/)
    assert.doesNotMatch(text, /甲@了 Echo/)
  })
}

for (const patch of [
  { atMe: false },
  {},
  { atMe: 'false', atMeKnown: true },
  { atMe: null, atMeKnown: true },
  { atMeKnown: true },
  { atMe: false, atMeKnown: false },
  { atMe: true, atMeKnown: false }
]) {
  test('032：缺失或矛盾自身元数据保持未知 ' + JSON.stringify(patch), () => {
    const { text } = render({ ...patch, atOthers: [{ qq: '22', name: '乙' }] })
    const prefix = prefixOf(text)
    assert.match(prefix, /未确认/)
    assert.doesNotMatch(prefix, /本条没有@Echo|本条明确@了Echo/)
    if (patch.atMeKnown === false) assert.doesNotMatch(text, /@了你/)
  })
}

for (const target of [
  { name: '你' }, { qq: 'NaN', name: 'Echo' },
  { qq: 'x', name: '乙' }
]) {
  test('032：未知目标不推断为其他人或全体 ' + (target.qq ?? 'missing'), () => {
    const { text } = render({
      atMe: false, atMeKnown: true, atOthers: [target]
    })
    assert.match(prefixOf(text), /未确认/)
    assert.doesNotMatch(text, /本条没有@Echo|群体通知|甲@了/)
  })
}

test('032：普通无@消息形状保持，正文和补档里的@不生成真实点名', () => {
  const plain = render().text
  assert.equal(render({ atMe: false, atMeKnown: true, atOthers: [] }).text, plain)
  const { text } = render({
    text: '@Echo 你看这个，这是引用的原话',
    historyDigest: '乙曾说：@Echo 你看这个'
  })
  assert.doesNotMatch(text, /本条明确@了Echo|本条没有@Echo|未确认/)
})

test('032：私聊渲染不受群接收对象提示影响', () => {
  for (const atMeKnown of [undefined, false, true]) {
    const { text } = render({
      chat: { id: '11', type: 'private' },
      atMe: true, atMeKnown, atOthers: []
    })
    assert.equal(text, '【QQ·私聊】甲说:' + BODY + '\n（甲@了你）')
  }
})

test('032：只有图片时text仍为空，不把提示写成用户原话', () => {
  const { env, text } = render({
    text: '', images: [{ url: 'https://example.invalid/image.png' }],
    atMe: false, atMeKnown: true, atOthers: [{ qq: '22', name: '乙' }]
  })
  assert.equal(env.text, '')
  assert.ok(text.indexOf('本条没有@Echo') < text.indexOf('发来1张图(没写字)'))
})

for (const qq of ['all', '0']) {
  test('032：原始信封8人后出现广播目标，裁剪仍保留全体 ' + qq, () => {
    const atOthers = [
      ...Array.from({ length: 8 }, (_, i) => ({ qq: String(20 + i), name: '乙' })),
      { qq, name: '' }
    ]
    const { env, text } = render({ atMe: false, atMeKnown: true, atOthers })
    assert.equal(env.atOthers.length, 8)
    assert.ok(env.atOthers.some(a => a.qq === qq))
    assert.match(prefixOf(text), /群体通知/)
    assert.doesNotMatch(prefixOf(text), /本条没有@Echo|只@了其他/)
  })
}

test('032：广播槽位仅用于群聊，私聊仍保留原来的前8个目标', () => {
  const first = Array.from({ length: 8 }, (_, i) => ({ qq: String(20 + i), name: '乙' }))
  const { env, text } = render({
    chat: { id: '11', type: 'private' },
    atMe: false, atOthers: [...first, { qq: 'all', name: '' }]
  })
  assert.deepEqual(env.atOthers, first)
  assert.doesNotMatch(text, /全体成员|系统：本条/)
})

test('032：原始信封尾部未知目标也不能被8人上限隐藏', () => {
  const { env, text } = render({
    atMe: false, atMeKnown: true,
    atOthers: [...Array.from({ length: 8 }, (_, i) => ({ qq: String(20 + i), name: '乙' })), { qq: 'NaN' }]
  })
  assert.equal(env.atOthers.length, 8)
  assert.equal(env.atMeKnown, false)
  assert.match(prefixOf(text), /未确认/)
  assert.doesNotMatch(prefixOf(text), /本条没有@Echo/)
})
