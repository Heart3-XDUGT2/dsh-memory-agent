/**
 * 审查台面板 ↔ 服务端路由的契约(v0.22.0 O5)。
 *
 * 起因:悬置话题**有 API 没有 UI**,而 README 早就写了它 —— 文档与实现
 * 不一致,是答辩会场最容易挨问、也最没面子的一类。所以这里把三件事
 * 钉成可测的性质:
 *
 *   ① 前端 `api('...')` 打过的每个 `/api/echo/*` 路径,服务端必须真的注册;
 *   ② `index.html` 里每个 `<section id="X">` 必须真有人渲染(里面有元素被
 *      app.js 引用),而且那个渲染函数进了轮询清单或单独调用 —— 不许画个空壳;
 *   ③ README 里承诺的面板,必须真的在 `index.html` 里有对应 section。
 *
 * 纯文本扫描 —— 不需要浏览器,也不需要起服务。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (p) => readFileSync(fileURLToPath(new URL('../' + p, import.meta.url)), 'utf8')
const html = read('web/index.html')
const app = read('web/app.js')
const server = read('lib/index.js')
const readme = read('README.md')

/** 前端调过的 JSON 端点(api/apiPost 的第一个参数)。 */
function clientPaths () {
  const out = new Set()
  for (const m of app.matchAll(/\bapi(?:Post)?\(\s*'([^']+)'/g)) out.add(m[1])
  for (const m of app.matchAll(/\bapi(?:Post)?\(\s*"([^"]+)"/g)) out.add(m[1])
  return [...out]
}

/** 服务端注册的路径。 */
function serverPaths () {
  const out = new Set()
  for (const m of server.matchAll(/path:\s*'(\/api\/echo\/[^']+)'/g)) out.add(m[1])
  return out
}

/** index.html 的 section 与其内部元素 id。
 *  2026-09-26 审查台 2.0 起 section 带 class(`<section id="ov" class="panel">`),
 *  所以属性段要容忍 —— 原来那句 `id="([^"]+)">` 只认"id 紧贴 >"的写法。 */
function sections () {
  const out = []
  const re = /<section id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g
  for (const m of html.matchAll(re)) {
    const ids = [...m[2].matchAll(/id="([^"]+)"/g)].map((x) => x[1])
    out.push({ id: m[1], ids })
  }
  return out
}

test('前端打过的每个 /api/echo 路径,服务端都真的注册了(没有幽灵端点)', () => {
  const routes = serverPaths()
  const ghosts = clientPaths().filter((p) => !routes.has(p.split('?')[0]))
  assert.deepEqual(ghosts, [], '前端在调不存在的端点: ' + ghosts.join(', '))
  assert.ok(routes.size >= 15, '只扫到 ' + routes.size + ' 条路由,扫描规则可能失效了')
})

test('O5:悬置话题这一区真的在页面上,而且真的在轮询(不是空壳)', () => {
  const sec = sections().find((s) => s.id === 'th')
  assert.ok(sec !== undefined, 'index.html 里没有 #th 这一区')
  assert.ok(sec.ids.includes('th-list'), '#th 里没有 th-list 容器')
  assert.ok(app.includes("'/api/echo/threads'"), 'app.js 没在调 /api/echo/threads')
  assert.match(app, /async function renderThreads\s*\(/, '没有 renderThreads')
  // 进轮询清单才算"活着"(只定义不调用 = 页面永远「加载中…」)
  assert.match(app, /const jobs = \[[^\]]*renderThreads[^\]]*\]/s, 'renderThreads 没进 refreshAll 的轮询清单')
})

test('每个 section 都有人渲染(不许画空壳)', () => {
  const empties = []
  for (const s of sections()) {
    if (s.ids.length === 0) continue // 纯说明性的区不算
    if (!s.ids.some((id) => app.includes("'" + id + "'"))) empties.push(s.id)
  }
  assert.deepEqual(empties, [], '这些区里没有任何元素被 app.js 引用: ' + empties.join(', '))
})

test('README current features link to real routes in the current panel', () => {
  const current = readFileSync(new URL('../web/mock/final/index.html', import.meta.url), 'utf8')
  const promised = [
    ['记忆', 'memory'], ['图谱', 'graph'], ['对话', 'talk'],
    ['审计', 'audit'], ['情绪', 'emotion'], ['维护', 'maintenance'], ['设置', 'config']
  ]
  const missing = []
  for (const [name, route] of promised) {
    if (!readme.includes(name)) { missing.push('README 没写 ' + name); continue }
    if (!current.includes('href="#/' + route + '"')) missing.push('当前页面缺路由 ' + route)
    if (!current.includes('./views/' + route + '.js')) missing.push('当前页面缺视图 ' + route)
  }
  assert.ok(readme.includes('/echo/mock/final/index.html'), 'README must name the exact current entry')
  assert.deepEqual(missing, [], missing.join(' / '))
})
