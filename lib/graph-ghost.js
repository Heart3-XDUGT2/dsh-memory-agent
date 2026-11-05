/**
 * lib/graph-ghost.js — 图谱的两层「幽灵层」(只给人看)。
 * ============================================================
 * 搬家记录(2026-10-02):这两层的 SQL 原来内联在 `lib/store.js::graphData()`,
 * 撞了 `python/engine/cooc.py` 的隔离钉子(READ_SIDE_FILES 里出现
 * `graph_cooc_evidence` / `v_cooc_pairs` = 红)。那颗钉子盯的是**证据层不许
 * 进检索/渲染**(cooc.py 原话:「本模块不进任何检索/渲染路径,进 prompt 要单独
 * 裁决」)。幽灵层是他批过的展示功能(2026-10-02:「影子边为什么不在图谱里显示
 * + 加权重过滤工具」),语义上确实不进检索 —— 但**文件级纪律要守住**:
 * 照 `graph_gate.py` 的先例(「整文件一刀切会误伤写口 ⇒ 单独盯那半边」),
 * 把这两个名字收进**这一个文件**,读侧名单保持原样、钉子反而更锋利。
 *
 * 这个模块的纪律(由 python/tests/test_cooc_evidence.py 盯):
 *   ① 禁名只许出现在这里(和引擎的 cooc.py / db.py —— 写侧与建表侧);
 *   ② 检索/渲染侧名单里的文件**连它的 import 都不许出现**(import 级隔离);
 *   ③ 它给出去的东西一律带 `inRetrieval: false` —— 检索永远看不见这两层。
 *
 * 两层的共同点:**不是他说过的话**、不进检索、不进力导向、不算进统计栏的
 * 「关系/连线」。页面只在开关打开时画它们(默认关 ⇒ 默认视图与以前一模一样)。
 */

/**
 * @param {object} db node:sqlite 的 Database(只读;表不在就安静地零行)
 * @returns {{shadow:object, evidence:object}} 页面要的两层(形状见 graphData().layers)
 */
export function ghostLayers (db) {
  const layers = {
    shadow: { nature: '3a 历史(已冻结)', inRetrieval: false, rows: [], note: '' },
    evidence: { nature: '中间层(只读派生)', inRetrieval: false, rows: [], note: '' }
  }
  try {
    layers.shadow.rows = db.prepare(
      'SELECT edge_id, source_id, target_id, relation, weight, kind, evidence_scope' +
      ' FROM graph_shadow_edges ORDER BY weight DESC, edge_id'
    ).all().map((r) => ({
      id: r.edge_id, source: r.source_id, target: r.target_id,
      relation: r.relation || '共现', weight: Number(r.weight) || 1,
      kind: r.kind || '', scope: r.evidence_scope || ''
    }))
  } catch { layers.shadow.note = '影子表不在(引擎下一次 connect 纯增建表;零行)' }
  try {
    layers.evidence.rows = db.prepare(
      'SELECT pair_key, source_id, target_id, COUNT(*) AS support, MIN(scope_kind) AS scope_kind' +
      ' FROM v_cooc_pairs GROUP BY pair_key ORDER BY support DESC, pair_key'
    ).all().map((r) => ({
      id: r.pair_key, source: r.source_id, target: r.target_id,
      relation: '同域', support: Number(r.support) || 1, scope: r.scope_kind || ''
    }))
  } catch { layers.evidence.note = '证据层不在(引擎下一次 connect 纯增建表;零行)' }
  return layers
}
