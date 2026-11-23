const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function validateTypedGraphLinks ({ memoryIds, trafficNodeIds, memoryNodeLinks, trafficLinks } = {}) {
  const memories = new Set(memoryIds ?? [])
  const trafficNodes = new Set(trafficNodeIds ?? [])
  const errors = []
  const memoryLinkIds = new Set()
  const trafficLinkIds = new Set()

  for (const link of memoryNodeLinks ?? []) {
    if (!object(link) || typeof link.linkId !== 'string' || !link.linkId || memoryLinkIds.has(link.linkId)) {
      errors.push('invalid_memory_link')
      continue
    }
    memoryLinkIds.add(link.linkId)
    if (!memories.has(link.memoryId) || !trafficNodes.has(link.nodeId)) errors.push('memory_link_endpoint_type_mismatch')
  }

  for (const link of trafficLinks ?? []) {
    if (!object(link) || typeof link.linkId !== 'string' || !link.linkId || trafficLinkIds.has(link.linkId)) {
      errors.push('invalid_traffic_link')
      continue
    }
    trafficLinkIds.add(link.linkId)
    if (!trafficNodes.has(link.from) || !trafficNodes.has(link.to) || link.from === link.to) {
      errors.push('traffic_link_endpoint_type_mismatch')
    }
  }
  return [...new Set(errors)]
}

export function graphEdgeTypesValid (nodes, edge) {
  if (!object(edge) || !nodes.has(edge.source) || !nodes.has(edge.target)) return false
  const source = nodes.get(edge.source)?.type
  const target = nodes.get(edge.target)?.type
  if (edge.kind === 'memory-link') return source === 'memory' && target === 'traffic'
    || source === 'traffic' && target === 'memory'
  if (edge.kind === 'traffic-link') return source === 'traffic' && target === 'traffic' && edge.source !== edge.target
  return false
}
