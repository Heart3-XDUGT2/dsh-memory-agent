/**
 * ④ 称呼与显示页的单测(web/views/naming.js,2026-10-05)。
 *
 * 钉两件事:
 *   ① **契约**(§3 / §3.1 / §4):classic script、无 fetch、只认 profile.json 那条 API、
 *      生效文案是那句、`EchoViews['naming']` 挂上了、不出现别的数据文件名;
 *   ② **纯逻辑真有行为**:名字转义、空名过滤、userName 也进规则、生成的规则
 *      **真的能匹配**旧信封前缀(【QQ·私聊】某别名说:…),merge 保留未管字段 + 去重。
 *
 * 加载方式照 tests/audit-view.test.js:页面文件是 classic script(无 import/export),
 * 把源码喂给 `new Function('globalThis', src)`,它只往 globalThis 上挂东西,沙箱隔离。
 * DOM 部分(draw)不在这里测 —— 没有 DOM 桩(`paint` 要 document),这里**只测纯逻辑**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../web/views/naming.js', import.meta.url)), 'utf8')
const sandbox = {}
new Function('globalThis', src)(sandbox) // eslint-disable-line no-new-func
const V = sandbox.EchoViews && sandbox.EchoViews['naming']
const P = V && V.pure

// ---------------------------------------------------------------------------
// 一、契约扫描
// ---------------------------------------------------------------------------

test('契约:classic script + 只走 api + 唯一 API 路径 + 生效文案 + 挂载点', () => {
  assert.ok(V, 'EchoViews[\'naming\'] 必须挂上')
  assert.equal(typeof V.draw, 'function', 'draw(el, api) 必须是函数')
  assert.equal(V.draw.length, 2, 'draw 收 (el, api)')
  assert.ok(P && typeof P === 'object', '.pure 必须挂上(给单测)')

  assert.ok(!src.includes('fetch('), '不许出现 fetch( —— 取数只走 api')
  assert.ok(src.includes('/api/echo/data/profile.json'), '必须出现 profile.json 的 API 路径')
  assert.ok(src.includes('已生效,刷新页面看界面'), '生效文案必须是 §4 那一句')
  assert.ok(!/\bimport\b/.test(src), '不许出现 import')
  assert.ok(!/\bexport\b/.test(src), '不许出现 export')
})

test('契约:不许出现别的数据文件名(白名单只剩 profile.json)', () => {
  const others = ['config.json', 'persona.json', 'aliases.json', 'names.json',
    'graph.json', 'state-defaults.json', 'lexicon.json', 'echo.db']
  for (const f of others) {
    assert.ok(!src.includes(f), '本页不许碰 ' + f)
  }
})

// ---------------------------------------------------------------------------
// 二、generatePatterns:名字 → 规则
// ---------------------------------------------------------------------------

test('generatePatterns:别名 → 规则,空名被过滤、userName 也进规则', () => {
  const pats = P.generatePatterns({
    userName: '阿乙',
    userAliases: ['阿岚', 'a+b', '(x)', '  ', '', null, 42]
  })
  // userName + 三个非空别名(空串 / 纯空白 / null / 数字 42 都进不来)
  assert.equal(pats.length, 4, '规则条数 = userName + 非空别名')
  for (const p of pats) {
    assert.equal(typeof p, 'string')
    assert.ok(p.length > 0)
    assert.doesNotThrow(() => new RegExp(p), '每条规则都必须能编译:' + p)
  }
  // userName 也在里面(它与别名互不相同,正好验"两路都进")
  assert.ok(pats.some((p) => new RegExp(p).test('阿乙说:在吗')), 'userName 也要进规则')
})

test('generatePatterns:空画像 / 脏画像不炸,也不造空规则', () => {
  assert.deepEqual(P.generatePatterns(null), [])
  assert.deepEqual(P.generatePatterns(undefined), [])
  assert.deepEqual(P.generatePatterns({}), [])
  assert.deepEqual(P.generatePatterns({ userAliases: '不是数组' }), [], '脏类型当空')
  assert.deepEqual(P.generatePatterns({ userName: '  ', userAliases: ['', '  '] }), [])
})

// ---------------------------------------------------------------------------
// 三、转义:含正则元字符的别名不许拼出会崩的正则(真跑一次)
// ---------------------------------------------------------------------------

test('转义:含中文别名与元字符的别名都能匹配,且不误伤', () => {
  const pats = P.generatePatterns({ userName: '甲', userAliases: ['a+b', '(x)', '阿岚'] })

  // ① 中文别名:【QQ·私聊】前缀里照样认得出
  const cn = pats.filter((p) => new RegExp(p).test('【QQ·私聊】阿岚说:在吗'))[0]
  assert.ok(cn, '中文别名必须能匹配信封前缀')
  assert.equal(new RegExp(cn).exec('【QQ·私聊】阿岚说:在吗')[1], '阿岚', '捕获组要抓出名字')

  // ② 元字符别名 a+b:拼出来的正则必须是转义过的,而且真的匹配
  const plus = pats.filter((p) => p.includes('a\\+b'))[0]
  assert.ok(plus, 'a+b 必须被转义成 a\\+b(否则 + 会变量词)')
  const rePlus = new RegExp(plus)
  assert.equal(rePlus.exec('【QQ·私聊】a+b说:在吗')[1], 'a+b')
  assert.equal(rePlus.test('【QQ·私聊】axb说:在吗'), false, '转义过 ⇒ 不许把 axb 当成 a+b')

  // ③ 括号别名 (x):转义后仍可匹配
  const par = pats.filter((p) => p.includes('\\(x\\)'))[0]
  assert.ok(par, '(x) 必须被转义成 \\(x\\)')
  assert.equal(new RegExp(par).exec('(x)说:hi')[1], '(x)', '无信封前缀也认')

  // ④ 不带【…】的裸信封前缀也认
  assert.ok(new RegExp(cn).test('阿岚说:在吗'))
})

test('sanitizePattern:能编译的原样返回,坏的 / 空的回 null(不抛)', () => {
  assert.equal(P.sanitizePattern('  ^(?:甲|乙)说[:：]  '), '^(?:甲|乙)说[:：]')
  assert.equal(P.sanitizePattern(''), null)
  assert.equal(P.sanitizePattern('   '), null)
  assert.equal(P.sanitizePattern(null), null)
  assert.equal(P.sanitizePattern(12), null)
  assert.equal(P.sanitizePattern('^(a$'), null, '编译不过 ⇒ null,不许抛')
})

test('normalizePatterns:去空 / 修边 / 去重 / 揪出坏行', () => {
  const r = P.normalizePatterns([' a ', 'a', '', '  ', '^(a$', 'b'])
  assert.deepEqual(r.ok, ['a', 'b'])
  assert.deepEqual(r.bad, ['^(a$'])
  assert.deepEqual(P.normalizePatterns(null), { ok: [], bad: [] })
})

// ---------------------------------------------------------------------------
// 四、mergeNamingPayload:保留未管字段、只覆盖三处、去重
// ---------------------------------------------------------------------------

test('mergeNamingPayload:未管字段一个不丢,三处被覆盖,列表去重', () => {
  const raw = {
    schemaRev: 1, userName: '阿岚', userAliases: ['阿岚'],
    agentName: 'Echo', nicknameStrict: true, updatedAt: '2026-10-05T00:00:00Z',
    someFutureKey: { keep: 1 }
  }
  const before = JSON.stringify(raw)
  const out = P.mergeNamingPayload(raw, {
    nicknamePatterns: ['^(?:甲)说[:：]', '^(?:甲)说[:：]', '^(?:乙)说[:：]', ''],
    uiIndexPrefix: ' 跟 ', fallbackAddress: ' 小可爱 '
  })
  // 未管字段全在(含未知键 —— 写盘纪律:不丢他的字段)
  for (const k of Object.keys(raw)) assert.deepEqual(out[k], raw[k], '不许丢字段:' + k)
  assert.deepEqual(out.someFutureKey, { keep: 1 })
  assert.equal(out.nicknameStrict, true, '本页不管 nicknameStrict,必须原样留着')
  // 三处被覆盖
  assert.deepEqual(out.nicknamePatterns, ['^(?:甲)说[:：]', '^(?:乙)说[:：]'], '去重 + 去空')
  assert.equal(out.uiIndexPrefix, '跟', '修边')
  assert.equal(out.fallbackAddress, '小可爱')
  // 不许改原对象
  assert.equal(JSON.stringify(raw), before, 'raw 不许被就地改')
  assert.notEqual(out, raw)
})

test('mergeNamingPayload:脏 raw / 空编辑也不炸,空字符串照写(空 = 用默认)', () => {
  const out = P.mergeNamingPayload(null, { uiIndexPrefix: '对', fallbackAddress: '' })
  assert.deepEqual(out, { nicknamePatterns: [], uiIndexPrefix: '对', fallbackAddress: '' })
  const out2 = P.mergeNamingPayload({ schemaRev: 1 }, { nicknamePatterns: '不是数组' })
  assert.deepEqual(out2.nicknamePatterns, [], '脏类型当空')
  assert.equal(out2.schemaRev, 1)
  assert.deepEqual(P.mergeNamingPayload([1, 2], {}).nicknamePatterns, [], '数组当空对象')
})

test('mergeNamingPayload:坏正则不许进 payload(校验在页内拦,落盘前就断)', () => {
  const out = P.mergeNamingPayload({}, { nicknamePatterns: ['^(a$', 'ok'] })
  assert.deepEqual(out.nicknamePatterns, ['ok'])
})

// ---------------------------------------------------------------------------
// 五、端到端:生成的规则 + 旧信封前缀实测
// ---------------------------------------------------------------------------

test('实测:从画像生成的规则真能剥【QQ·私聊】这类旧信封前缀', () => {
  const profile = { userName: '阿岚', userAliases: ['阿岚', '小E的家'] }
  const pats = P.generatePatterns(profile)
  const samples = [
    ['【QQ·私聊】阿岚说:在吗', '阿岚'],
    ['【QQ·私聊】阿岚说：我回来啦', '阿岚'],
    ['【QQ·群】小E的家说: 早', '小E的家']
  ]
  for (const [line, who] of samples) {
    const hit = pats.map((p) => new RegExp(p).exec(line)).filter(Boolean)[0]
    assert.ok(hit, line + ' 必须被某条规则认出来')
    assert.equal(hit[1], who, line + ' 要抓出「' + who + '」')
  }
})
