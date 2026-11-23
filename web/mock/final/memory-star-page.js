import { createConstellation } from './vendor/jiulin/scene.js'
import { toConstellation } from './memory-star-data.js'
import { graphFixture } from './memory-star-fixture.js'

const $ = id => document.getElementById(id)
const fixture = graphFixture(new URLSearchParams(location.search).get('fixture'))
const kindOf = node => node.type === 'memory' ? '记忆' : '交通节点'
const flags = { memories: true, hubs: true, lines: true, motion: !matchMedia('(prefers-reduced-motion: reduce)').matches }
const statuses = { active: '有效', inactive: '停用', archived: '已归档', superseded: '已取代' }
let graph, selected, cutoff = '', mode = '', lastTrigger, reading = 0
let scene = window.THREE?.OrbitControls ? createConstellation(window.THREE, { canvas: $('webgl'), labels: $('labels'), tooltip: $('tooltip') }, select) : null
const empty = $('message'), panel = $('readout'), body = $('panel-body')
const visible = n => (n.type === 'memory' ? flags.memories : flags.hubs) && (!cutoff || !n.date.day || n.date.day <= cutoff)

function element(tag, value, css) {
  const result = document.createElement(tag)
  if (value) result.textContent = value
  if (css) result.className = css
  return result
}
function button(label, css, action) {
  const el = element('button', label, css)
  el.type = 'button'
  el.addEventListener('click', action)
  return el
}
function showPanel(next, kind) {
  if (!mode) lastTrigger = document.activeElement
  mode = next
  panel.hidden = false
  panel.classList.add('show')
  $('browse').setAttribute('aria-expanded', String(next === 'directory'))
  $('kind').textContent = kind
  body.replaceChildren()
}
function closePanel() {
  selected = null
  mode = ''
  scene?.select(null)
  panel.hidden = true
  panel.classList.remove('show')
  $('browse').setAttribute('aria-expanded', 'false')
  if (lastTrigger?.isConnected) lastTrigger.focus({ preventScroll: true })
}
function select(node, focus = true) {
  if (!node) { closePanel(); return }
  selected = node
  scene?.select(node, focus)
  showPanel('detail', kindOf(node))
  body.append(element('h2', node.label))
  if (node.type === 'memory') body.append(element('p', node.summary || '摘要未提供', 'note'))
  body.append(element('p', `${node.date.description} · ${statuses[node.status] || node.status}`, 'source'))
  body.append(element('p', `来源　${node.source}`, 'source'))
  const rels = element('div', '', 'relations')
  const list = element('div', '', 'rel-list')
  rels.append(element('span', `直接连接 · ${node.neighbors.length}`), list)
  for (const { node: neighbor, edge } of node.neighbors) {
    const chip = button(neighbor.label, 'rel-chip', () => {
      if (!visible(neighbor)) {
        flags[neighbor.type === 'memory' ? 'memories' : 'hubs'] = true
        if (cutoff && neighbor.date.day > cutoff) $('age').value = String(graph.dates.length)
        applyFilters()
      }
      select(neighbor)
    })
    chip.append(element('small', `${edge.label} · ${edge.verified ? '回执已验证' : '回执未确认'}`))
    list.append(chip)
  }
  body.append(rels, button('星图目录', 'filter', directory))
  panel.scrollTop = 0
}
function directory() {
  selected = null
  scene?.select(null)
  showPanel('directory', '星图目录')
  const input = element('input', '', 'search')
  input.type = 'search'
  input.placeholder = '搜索节点或摘要'
  input.setAttribute('aria-label', input.placeholder)
  const list = element('div')
  const search = () => {
    list.replaceChildren()
    const query = input.value.trim().toLocaleLowerCase()
    for (const node of graph?.nodes || []) {
      if (!visible(node) || ![node.label, node.summary].some(s => s.toLocaleLowerCase().includes(query))) continue
      const entry = button(node.label, 'recall-item', () => select(node))
      entry.append(element('small', `${kindOf(node)} · ${node.neighbors.length} 条连接`))
      list.append(entry)
    }
    if (!list.childElementCount) list.append(element('p', '没有符合条件的节点', 'note'))
  }
  input.addEventListener('input', search)
  body.append(input, list)
  search()
  panel.scrollTop = 0
}
function applyFilters() {
  if (!graph) return
  cutoff = graph.dates[Number($('age').value)] || ''
  $('ageOut').textContent = cutoff || '全部日期'
  for (const [id, value] of Object.entries(flags)) $(id).setAttribute('aria-pressed', String(value))
  $('motion').textContent = flags.motion ? '暂停自转' : '开启自转'
  scene?.setVisibility(visible, flags.lines)
  if (selected && !visible(selected)) closePanel()
  if (mode === 'directory') directory()
  $('explore').disabled = !graph.nodes.some(visible)
}
function note(message) {
  empty.textContent = message
  empty.hidden = !message
}
async function refresh() {
  const request = ++reading
  $('status').textContent = '正在读取图谱'
  try {
    let data = fixture
    if (!data) {
      const response = await fetch('/api/echo/consolidation-graph?kind=all&depth=2&limit=240', { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw Error('graph_read_failed')
      data = await response.json()
    }
    if (request !== reading) return
    const next = toConstellation(data)
    if (mode) closePanel()
    graph = next
    scene?.setData(graph)
    const hubCount = graph.nodes.filter(n => n.type === 'traffic').length
    $('counts').textContent = `${graph.nodes.length - hubCount} 条记忆 · ${hubCount} 个交通节点 · ${graph.edges.length} 条连接`
    $('age').max = String(graph.dates.length)
    $('age').value = String(graph.dates.length)
    $('age').disabled = !graph.dates.length
    $('earliest').textContent = graph.dates[0] || ''
    $('latest').textContent = graph.dates.at(-1) || ''
    $('status').textContent = [fixture ? '合成预览' : '只读图谱', graph.partial ? '部分数据' : '', graph.omitted ? `略过 ${graph.omitted} 项无效数据` : ''].filter(Boolean).join(' · ')
    note(!graph.nodes.length ? '本次图谱为空' : !scene ? '当前浏览器无法显示 3D，可从星图目录查看节点。' : '')
    applyFilters()
    if (!scene && graph.nodes.length) directory()
  } catch {
    if (request !== reading) return
    $('status').textContent = graph ? '刷新失败 · 保留上次图谱' : '图谱读取失败'
    if (!graph) note('图谱暂时不可用')
  } finally {
    document.body.classList.add('ready')
  }
}
for (const key of ['memories', 'hubs', 'lines', 'motion']) {
  $(key).addEventListener('click', () => {
    flags[key] = !flags[key]
    if (key === 'motion') scene?.setMotion(flags.motion)
    applyFilters()
  })
}
$('browse').addEventListener('click', () => mode === 'directory' ? closePanel() : directory())
$('explore').addEventListener('click', () => {
  const pool = graph?.nodes.filter(visible) || []
  if (pool.length) select(pool[Math.floor(Math.random() * pool.length)])
})
$('close-panel').addEventListener('click', closePanel)
$('home').addEventListener('click', () => { closePanel(); scene?.reset() })
$('age').addEventListener('input', applyFilters)
$('refresh').addEventListener('click', refresh)
document.addEventListener('keydown', event => { if (event.key === 'Escape' && mode) closePanel() })
$('webgl').addEventListener('webglcontextlost', () => {
  scene = null
  note('3D 显示已中断，可从星图目录继续查看节点。')
  if (graph?.nodes.length) directory()
})
refresh()
