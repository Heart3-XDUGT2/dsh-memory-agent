// 跨语言等价核对 —— JS 侧执行器(**不要单独跑**,由 scripts/parity-check.py 调用)。
//
// 读夹具 JSON → 走生产 `lib/retrieve.js` 的 rankMemories → 打印规范化 JSON。
// Python 侧执行器在 parity-check.py 里(同一份夹具、同一组字段),两边逐字段比。

import { readFileSync } from 'node:fs'
import { rankMemories } from '../lib/retrieve.js'

const fx = JSON.parse(readFileSync(process.argv[2], 'utf8'))

/** 逗号串 / JSON 串关键词 → 词表。与 Python `retrieve.parse_keywords` 同规则。 */
function parseKeywords (raw) {
  if (Array.isArray(raw)) return raw.filter((k) => typeof k === 'string' && k)
  const s = String(raw ?? '').trim()
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.filter((k) => typeof k === 'string' && k) : []
  } catch {
    return s.split(/[,，、]/).map((k) => k.trim()).filter(Boolean)
  }
}

/** snake_case 夹具行 → JS 侧 camelCase 行(仓库里 JS 一律 camelCase)。 */
function toCamel (r) {
  return {
    memoryId: r.memory_id,
    keywords: parseKeywords(r.keywords),
    summary: r.summary,
    emotionScore: r.emotion_score,
    timestamp: r.timestamp,
    intrinsicValue: r.intrinsic_value,
    halfLife: r.half_life,
    recallCount: r.recall_count,
    lastRecalled: r.last_recalled,
    layer: r.layer,
    occurredAt: r.occurred_at,
    learnedAt: r.learned_at,
    temporalStatus: r.temporal_status,
    source: r.source,
    sourceLabel: r.source_label,
    actor: r.actor
  }
}

const ROWS = fx.rows.map(toCamel)
const out = {}
for (const q of fx.queries) {
  const top = rankMemories(ROWS, q, fx.topK, Number(fx.now))
  out[q] = top.map((it) => ({
    id: it.memoryId,
    hits: it.hits,
    matched: !!it.matched,
    r_now: it.rNow,
    total: it.total,
    forced: !!it.forced
  }))
}
console.log(JSON.stringify(out, null, 1))
