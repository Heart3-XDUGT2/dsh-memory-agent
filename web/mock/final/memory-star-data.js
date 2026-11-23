const calendar = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
})

function text(value, fallback = '未提供') {
  if (typeof value !== 'string') return fallback
  const clean = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim()
  if (!clean || /^[{[]/u.test(clean)) return fallback
  return clean
    .replace(/(?:[a-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|var|tmp)\/)[^\s，。；]*/giu, '内部路径')
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu, '内部标识')
    .replace(/\b(?:session-[0-9a-f]{8,}|(?:memory|traffic|memory-link|traffic-link):[^\s，。；]+)/giu, '节点')
}

function date(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const instant = new Date(seconds * 1000)
  return Number.isFinite(instant.getTime()) ? calendar.format(instant) : ''
}

export function dateOf(row) {
  for (const [key, prefix] of [['occurredAt', '发生于'], ['learnedAt', '提及于'], ['recordedAt', '记录于']]) {
    const day = date(row[key])
    if (day) return { day, description: `${prefix} ${day}${key === 'occurredAt' ? '' : '，事情发生时间未确认'}` }
  }
  return { day: '', description: '日期未确认' }
}

export function toConstellation(payload) {
  if (!Array.isArray(payload?.nodes) || !Array.isArray(payload?.edges)) throw Error('graph_unavailable')
  const byId = new Map()
  const nodes = [], edges = [], hubs = new Map(), firstHub = new Map()
  const groups = []
  let omitted = 0
  for (const row of payload.nodes) {
    if (!row || !['memory', 'traffic'].includes(row.type) || typeof row.id !== 'string' || !row.id || byId.has(row.id)) {
      omitted++
      continue
    }
    const node = {
      id: row.id, type: row.type, label: text(row.label, row.type === 'memory' ? '记忆节点' : '交通节点'),
      summary: text(row.summary, ''), source: text(row.source), status: text(row.status),
      date: dateOf(row), neighbors: []
    }
    nodes.push(node)
    byId.set(node.id, node)
    if (node.type === 'traffic') {
      const group = { hub: node, members: [node] }
      hubs.set(node, group)
      groups.push(group)
    }
  }
  const edgeIds = new Set()
  for (const row of payload.edges) {
    const a = byId.get(row?.source), b = byId.get(row?.target)
    const valid = a && b && a !== b && (row.kind === 'memory-link' && a.type !== b.type ||
      row.kind === 'traffic-link' && a.type === 'traffic' && b.type === 'traffic')
    if (!valid || row.id && edgeIds.has(row.id)) { omitted++; continue }
    if (row.id) edgeIds.add(row.id)
    const edge = { a, b, kind: row.kind, label: text(row.relation, '关联'), verified: row.evidenceStatus === 'verified' }
    edges.push(edge)
    a.neighbors.push({ node: b, edge })
    b.neighbors.push({ node: a, edge })
    if (row.kind === 'memory-link') {
      const [memory, hub] = a.type === 'memory' ? [a, b] : [b, a]
      if (!firstHub.has(memory)) firstHub.set(memory, hub)
    }
  }
  // One star per Memory. Its first attachment determines placement only.
  const loose = { hub: null, members: [] }
  for (const node of nodes) {
    if (node.type === 'memory') (hubs.get(firstHub.get(node)) || loose).members.push(node)
  }
  if (loose.members.length) groups.push(loose)
  return {
    nodes, edges, groups, omitted,
    dates: [...new Set(nodes.map(n => n.date.day).filter(Boolean))].sort(),
    partial: !!payload.partial?.length || Object.values(payload.truncated || {}).some(Boolean)
  }
}
