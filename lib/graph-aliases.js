/**
 * 图谱实体归一规则(M2):纯函数 + 一个数据文件读点
 * ============================================================
 * 为什么单开一个文件:体检脚本(memory-doctor)、合并脚本(graph-merge)、
 * 单元测试三处必须**用同一份真值**。规则各写一份 = 三处慢慢长歪。
 *
 * 分野(Tier)来自 2026-09-25 活库实测:
 *   Tier1 = 高置信同实体,可以自动合并(同一个实体的简称与全称)。
 *   Tier2 = **可能是两件事**,合并会丢信息,必须人工过目
 *   (两个项目/两件事共用一个词面时最容易出错)。
 *
 * 名字匹配三级:
 *   ① 规则表精确命中(去空白后完全相等)
 *   ② 规则表归一命中(NFKC + 去标点/空白 + 小写 后相等)
 *   ③ 归一后包含关系(短名 ⊂ 长名)—— 只报候选,不自动并
 *
 * ★ P1b(2026-10-05,数据与程序分离):规则表**不再住在代码里**。
 *   真名规则(6 条 Tier1 + 7 条 Tier2)搬进了数据目录的 `aliases.json`
 *   (`{ alias, canonical, tier, why }`,形状见 lib/data-schema.js 的 SPECS),
 *   并一次性种子导进了 echo.db 的 `graph_aliases` 表(Q5,幂等)。
 *   本模块只剩两件事:
 *     ① 通用**空**默认(`ALIAS_TIER1/2` = 空表:程序里零真名);
 *     ② 数据文件读点(`loadAliasRules`):`canonicalOf` / `planMerges`
 *        不显式给规则时,就从 aliases.json 现读。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolveDataFilePath } from './data-dir.js'

/** Tier1 空默认(P1b:程序里不再含真名;规则来自 aliases.json)。 */
export const ALIAS_TIER1 = Object.freeze([])

/** Tier2 空默认(同上;P1b 之前它是 `const`,不导出 —— 种子迁移需要它,顺手导出)。 */
export const ALIAS_TIER2 = Object.freeze([])

/**
 * 读 aliases.json 里的规则(只读、缺文件/坏文件 ⇒ 空表,**永不抛**),按 tier 分开。
 * 每次现读不缓存:文件小,而"改完配置立刻生效"比省这点 IO 重要。
 * `tier` 不是 1/2 的(不该出现,SPECS 会报错)一律**按 Tier2 处理** ——
 * 宁可少并,不可错并。
 * @param {string|null} [path]
 * @returns {{ tier1: Array, tier2: Array }}
 */
export function loadAliasRules (path = resolveDataFilePath('aliases.json')) {
  const out = { tier1: [], tier2: [] }
  try {
    if (path === null || path === undefined || !existsSync(path)) return out
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const rules = Array.isArray(raw?.rules) ? raw.rules : []
    for (const r of rules) {
      if (r === null || typeof r !== 'object') continue
      const alias = typeof r.alias === 'string' ? r.alias.trim() : ''
      const canonical = typeof r.canonical === 'string' ? r.canonical.trim() : ''
      if (alias === '' || canonical === '') continue
      const rule = { alias, canonical, why: typeof r.why === 'string' ? r.why : '' }
      if (Number(r.tier) === 1) out.tier1.push(rule)
      else out.tier2.push(rule)
    }
  } catch { /* 坏文件 = 没有规则(降级到启发式,不抛) */ }
  return out
}

/** 解析"这次用哪份规则":显式数组 > 显式两级对象 > 从 aliases.json 现读。 */
function resolveRules (tiers) {
  if (tiers === null || tiers === undefined) return loadAliasRules()
  if (Array.isArray(tiers)) return { tier1: tiers, tier2: [] }
  return {
    tier1: Array.isArray(tiers.tier1) ? tiers.tier1 : [],
    tier2: Array.isArray(tiers.tier2) ? tiers.tier2 : []
  }
}

/** 归一化:NFKC(全角→半角)+ 去空白/标点 + 小写。用于碰撞检测,不用于落库。 */
export function normalizeName (name) {
  return String(name ?? '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・.,,、。:：;；!！?？'"'"“”‘’()（）[\]【】{}｛｝<>《》\-_/\\|+*&#@~^$%]/g, '')
    .toLowerCase()
}

/**
 * 规则表查名:返回 canonical 名或 null(不是别名就当它是自己)。
 * @param {string} name
 * @param {Array|null} [rules] 默认两边都查(Tier1 在前,先命中先赢)
 */
export function canonicalOf (name, rules = null) {
  const raw = String(name ?? '').trim()
  if (raw === '') return null
  const list = Array.isArray(rules)
    ? rules
    : (() => { const l = loadAliasRules(); return [...l.tier1, ...l.tier2] })()
  for (const rule of list) if (rule.alias === raw) return rule.canonical
  const norm = normalizeName(raw)
  for (const rule of list) if (normalizeName(rule.alias) === norm) return rule.canonical
  return null
}

/**
 * 给一组节点算合并计划。
 * @param {Array<{id: string, name: string}>} nodes
 * @param {Array|{tier1?: Array, tier2?: Array}|null} [tiers] 不给就从 aliases.json 现读
 * @returns {{tier1: Array, tier2: Array, heuristic: Array}}
 */
export function planMerges (nodes, tiers = null) {
  const list = (Array.isArray(nodes) ? nodes : [])
    .map((n) => ({ id: String(n.id ?? ''), name: String(n.name ?? '').trim() }))
    .filter((n) => n.id !== '' && n.name !== '')
  const byName = new Map()
  for (const n of list) if (!byName.has(n.name)) byName.set(n.name, n)

  const rules = resolveRules(tiers)

  const build = (rs) => {
    const out = []
    for (const rule of rs) {
      const cannon = byName.get(rule.canonical)
      const loser = byName.get(rule.alias)
      if (cannon === undefined || loser === undefined) continue
      if (cannon.id === loser.id) continue
      out.push({
        canonical: cannon.name, canonicalId: cannon.id,
        loser: loser.name, loserId: loser.id, why: rule.why
      })
    }
    return out
  }

  // 启发式候选:归一后相等,但规则表没覆盖 → 报出来让人定规则
  const buckets = new Map()
  for (const n of list) {
    const k = normalizeName(n.name)
    if (k === '') continue
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(n.name)
  }
  const known = new Set([...rules.tier1, ...rules.tier2].map((r) => normalizeName(r.alias)))
  const heuristic = []
  for (const [k, names] of buckets) {
    if (names.length < 2 || known.has(k)) continue
    heuristic.push({ names, note: '归一后同名 —— 像是同一实体的不同写法' })
  }
  // 包含关系候选:短名 ⊂ 长名(短名 ≥2 字,长名不超过短名 +4 字,避免把一句话吞掉)
  const names = list.map((n) => n.name)
  for (const short of names) {
    if (short.length < 2) continue
    for (const long of names) {
      if (long === short || long.length <= short.length || long.length > short.length + 4) continue
      if (!long.includes(short)) continue
      if (known.has(normalizeName(short))) continue
      heuristic.push({ names: [short, long], note: '一个名字包含另一个 —— 可能是同一实体(未定规则)' })
    }
  }
  return { tier1: build(rules.tier1), tier2: build(rules.tier2), heuristic }
}
