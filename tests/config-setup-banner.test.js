/**
 * ① 上手引导条(web/views/setup-banner.js,B4 收尾)
 * ================================================
 * 它**不是一页**:没有导航项、没有 hash 路由、不进 `PANELS`(那张表管"能导航到的
 * 分区")。所以这里除了纯逻辑与 DOM 桩,还专门钉一条:**别把它塞进 PANELS**,
 * 也别给它编导航 id —— 免得后来的人"顺手加一条",把左栏搞出个点不开的条目。
 *
 * 加载方式照 tests/config-persona.test.js:页面文件是 classic script,喂给
 * `new Function('globalThis', 'EchoViews', src)` 沙箱(浏览器里全局对象就是作用域,
 * 裸名可解析;`new Function` 里不行,所以同一个对象既当 globalThis 又当 EchoViews)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = readFileSync(fileURLToPath(new URL('../web/views/setup-banner.js', import.meta.url)), 'utf8')
const box = {}
const views = {}
box.EchoViews = views
new Function('globalThis', 'EchoViews', src)(box, views) // eslint-disable-line no-new-func
const V = views['setup-banner']
const html = readFileSync(fileURLToPath(new URL('../web/index.html', import.meta.url)), 'utf8')
const app = readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8')

/** 最小 DOM 桩:够 draw 用(createElement / appendChild / textContent / className / hidden)。 */
function fakeEl () {
  const doc = {
    createElement: (tag) => {
      const n = { tag, children: [], className: '', textContent: '', href: '', hidden: false }
      n.appendChild = (c) => { n.children.push(c); return c }
      n.removeChild = (c) => { n.children = n.children.filter((x) => x !== c) }
      return n
    }
  }
  const el = {
    hidden: true, textContent: '', children: [], firstChild: null, ownerDocument: doc
  }
  el.appendChild = (c) => { el.children.push(c); el.firstChild = el.children[0] ?? null; return c }
  el.removeChild = (c) => {
    el.children = el.children.filter((x) => x !== c)
    el.firstChild = el.children[0] ?? null
  }
  return el
}
const textOf = (n) => (n.children ?? []).map((c) => String(c.textContent) + ' ' + textOf(c)).join(' ')

const file = (over = {}) => Object.assign({
  file: 'persona.json', exists: true, empty: false, broken: false, bytes: 10,
  schemaRev: 1, deepLink: '#/persona', hint: ''
}, over)

test('契约扫描:只读 /api/echo/setup;挂 globalThis.EchoViews;无 fetch / 模块语法 / 文件系统路径', () => {
  assert.equal(typeof V, 'object', 'EchoViews["setup-banner"] 必须挂上')
  assert.equal(typeof V.draw, 'function')
  assert.equal(typeof V.pure, 'object', '纯逻辑要挂在 .pure 上(单测用)')
  assert.ok(src.includes("'/api/echo/setup'"), '必须只读 setup 端点')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n]*$/gm, '')
  assert.ok(!/fetch\s*\(/.test(code), '不许 fetch')
  assert.ok(!/\b(import|export)\b/.test(code), '必须是 classic script')
  assert.ok(!/node:fs|resolveDataFilePath|\.dsh[\\/]echo/.test(code), '不许出现文件系统路径')
  assert.ok(!/alert\s*\(/.test(code), '不许 alert')
  // 深链只能来自服务端(不许自己编):源码里不许出现别的写死深链字面量
  const hard = code.match(/'#\/[a-z-]+'/g) ?? []
  assert.deepEqual(hard, [], '深链字面量不该写死在视图里(要走 setup 回包的 deepLink)')
})

test('状态口径与 ⑧ 页同一套:missing > broken > empty > ok;脏值不抛', () => {
  const p = V.pure
  assert.equal(p.statusRow(file()).state, 'ok')
  assert.equal(p.statusRow(file({ exists: false })).state, 'missing')
  assert.equal(p.statusRow(file({ broken: true })).state, 'broken')
  assert.equal(p.statusRow(file({ empty: true })).state, 'empty')
  // 优先级:又坏又空 ⇒ broken;不在且脏 ⇒ missing
  assert.equal(p.statusRow(file({ broken: true, empty: true })).state, 'broken')
  assert.equal(p.statusRow(file({ exists: false, empty: true, broken: true })).state, 'missing')
  assert.equal(p.statusRow(null).state, 'ok', '脏值 ⇒ 当正常(不撒红字)')
  assert.equal(p.statusRow(undefined).state, 'ok')
})

test('深链解析:只认 #/<id> 形态;脏值回空(不编深链)', () => {
  const p = V.pure
  assert.equal(p.deepLinkId('#/persona'), 'persona')
  assert.equal(p.deepLinkId('#/state-lexicon'), 'state-lexicon')
  assert.equal(p.deepLinkId('#/data-health/'), 'data-health')
  assert.equal(p.deepLinkId('persona'), '', '没有 #/ 前缀不算深链')
  assert.equal(p.deepLinkId('#/Persona'), '')
  assert.equal(p.deepLinkId('#/a b'), '')
  assert.equal(p.deepLinkId(''), '')
  assert.equal(p.deepLinkId(null), '')
})

test('要提醒的:只列缺/坏/空,按 missing→broken→empty 排;全好 ⇒ 空', () => {
  const p = V.pure
  const setup = {
    configured: false,
    files: [
      file({ file: 'lexicon.json', deepLink: '#/state-lexicon' }),
      file({ file: 'graph.json', empty: true, deepLink: '#/tuning' }),
      file({ file: 'names.json', exists: false, deepLink: '#/aliases' }),
      file({ file: 'persona.json', broken: true })
    ]
  }
  const rows = p.troubleRows(setup)
  assert.deepEqual(rows.map((r) => r.file), ['names.json', 'persona.json', 'graph.json'])
  assert.deepEqual(rows.map((r) => r.state), ['missing', 'broken', 'empty'])
  assert.equal(rows[0].pageId, 'aliases')
  assert.equal(rows[1].pageId, 'persona')
  assert.equal(p.troubleRows({ files: [file()] }).length, 0, '全好 ⇒ 一条都不列')
  assert.deepEqual(p.troubleRows(null), [], '脏回包不抛')
  assert.deepEqual(p.troubleRows({}), [])
  const sum = p.summaryText(rows)
  assert.ok(sum.includes('文件不在') && sum.includes('读不出来') && sum.includes('还没填'), '结论要分状态说人话:' + sum)
  assert.ok(p.summaryText([]).includes('还没配好'), '一项都列不出来时也要说人话(不是"配置齐了")')
})

/** 递归收出所有节点(深链藏 li > a 里,不递归就找不到)。 */
function allNodes (n) {
  const out = [n]
  for (const c of n.children ?? []) out.push(...allNodes(c))
  return out
}

test('draw:未配置 ⇒ 红着列出来(深链是可点的 <a href="#/<id>">);配好 ⇒ 自己藏起来', async () => {
  const el = fakeEl()
  const api = { get: async () => ({ configured: false, files: [file({ file: 'names.json', exists: false, deepLink: '#/aliases' }), file()] }) }
  await V.draw(el, api)
  assert.equal(el.hidden, false, '有要补的 ⇒ 显示')
  const anchors = allNodes(el).filter((c) => c.tag === 'a')
  assert.equal(anchors.length, 1)
  assert.equal(anchors[0].href, '#/aliases', '深链来自服务端字段')
  assert.ok(textOf(el).includes('还没配好'), '要有人话结论')

  // 幂等:再画一次,节点不叠加
  const before = el.children.length
  await V.draw(el, api)
  assert.equal(el.children.length, before, '重画不许叠加')

  // 配好 ⇒ 藏
  const okEl = fakeEl()
  await V.draw(okEl, { get: async () => ({ configured: true, files: [file()] }) })
  assert.equal(okEl.hidden, true)

  // ★ 真机逮到的那条:configured=true 但**还有空文件** ⇒ 照样藏
  //   (空是合法状态;那种账归 ⑧ 体检页 —— 他的库里 graph.json/state-defaults.json 就是空的)
  const mixedEl = fakeEl()
  await V.draw(mixedEl, {
    get: async () => ({ configured: true, files: [file(), file({ file: 'graph.json', empty: true, deepLink: '#/tuning' })] })
  })
  assert.equal(mixedEl.hidden, true, '已配置就不红 —— 哪怕有条目是空的')

  // configured=false 但一项都列不出来 ⇒ 也要说人话(不白屏)
  const allGoneEl = fakeEl()
  await V.draw(allGoneEl, { get: async () => ({ configured: false, files: [] }) })
  assert.equal(allGoneEl.hidden, false)
  assert.ok(textOf(allGoneEl).includes('还没配好'), '一项都列不出来时也要有话说')

  // 体检读不到 ⇒ 静默降级(不撒红字)
  const errEl = fakeEl()
  await V.draw(errEl, { get: async () => { throw new Error('HTTP 404') } })
  assert.equal(errEl.hidden, true)
  // 没有 api / 没有 el 也不炸
  await V.draw(fakeEl(), null)
  await V.draw(null, { get: async () => ({}) })
})

test('接线:index.html 有容器与脚本、app.js 有 drawSetupBanner 并进轮询;**不是一页**', () => {
  assert.ok(html.includes('id="setup-banner"'), 'index.html 缺横幅容器')
  assert.ok(html.includes('<script src="/echo/views/setup-banner.js"></script>'), 'index.html 没加载引导条')
  assert.ok(html.indexOf('/echo/views/setup-banner.js') < html.indexOf('/echo/app.js'), '引导条脚本要在 app.js 之前')
  assert.ok(/function drawSetupBanner \(/.test(app), 'app.js 要有 drawSetupBanner')
  assert.ok(/drawSetupBanner\b/.test(app.slice(app.indexOf('async function refreshAll'))), '轮询里要带上它')
  // 关键:它不是一页 —— 不许有导航项、不许进 PANELS
  assert.ok(!html.includes('id="nav-setup-banner"'), '引导条不该有导航项')
  assert.ok(!/id: 'setup-banner'/.test(app), '引导条不该进 PANELS(左栏会多点不开的一条)')
  assert.ok(!html.includes('<section id="setup-banner"'), '它不该是个 panel section')
})
