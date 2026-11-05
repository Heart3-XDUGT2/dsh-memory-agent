/**
 * dsh-echo — 图谱上的两个「幽灵层」(2026-10-02)
 * ============================================================
 * 他问了两件事:「影子边为什么不在图谱里显示」+「加权重过滤工具」,并选了 **A+B 两层都做、分开关**:
 *
 *   · A 联想层 = 共现**证据层**(中间层,活的):权重 = 被几条证据支持
 *   · B 史  层 = **影子边**(3a 历史,已冻结):权重 = 当初挖出来的 1–4 分
 *
 * 这层东西的性质:**只给人看**。所以这份测试钉的不是"画得好不好看",而是三条硬约束:
 *   ① 默认**关** ⇒ 默认视图与以前一模一样(不开就不该有任何变化);
 *   ② **不进检索、不进力导向、不算进"关系/连线"两个计数** —— 它们不是他亲口说的事实;
 *   ③ 端点不在当前可见节点里的,不画(要计数说清,不许悬空线)。
 *
 * 抽码法照 `_graph-tuning.mjs` 那套:把页面里那段纯函数原样抠出来跑,不重抄逻辑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore, MASTER_ID } from '../lib/store.js'
import { graphHtml, stripComments } from './_graph-tuning.mjs'

const code = stripComments(graphHtml)

/** 抠出页面里 `function ghostSelect (...) {...}` 那一段原样跑。 */
function ghostSelectOf () {
  const a = graphHtml.indexOf('function ghostSelect (')
  if (a < 0) throw new Error('找不到 ghostSelect(改名了就把测试也改掉)')
  const b = graphHtml.indexOf('// ---- 幽灵层结束 ----', a)
  if (b < 0) throw new Error('找不到幽灵层的结束标记')
  return new Function(graphHtml.slice(a, b) + '\nreturn ghostSelect')()
}

// ─────────────────────────────────────────────────────────────
// ① 数据侧:graphData() 把两层带出来(纯增,事实图一个字不动)
// ─────────────────────────────────────────────────────────────
test('幽灵层:新库里两层都在(表还没建也不炸,给 note)', () => {
  const store = openStore(':memory:')
  try {
    const L = store.graphData().layers
    assert.ok(L, 'graphData 必须带 layers')
    assert.deepEqual(L.shadow.rows, [])
    assert.deepEqual(L.evidence.rows, [])
    assert.equal(L.shadow.inRetrieval, false, '影子层绝不许进检索')
    assert.equal(L.evidence.inRetrieval, false, '证据层绝不许进检索')
    assert.match(L.shadow.nature, /冻结/)
    assert.match(L.evidence.nature, /中间层/)
    assert.ok(L.shadow.note.length > 0 || L.evidence.note.length > 0, '缺表要说清,不能假装是空的')
  } finally { store.close() }
})

test('幽灵层:影子边带权重出来,按权重降序;联想对按「被几条证据支持」聚合', () => {
  const store = openStore(':memory:')
  try {
    store.db.exec('CREATE TABLE IF NOT EXISTS graph_shadow_edges (edge_id INTEGER PRIMARY KEY, source_id TEXT,'
      + ' target_id TEXT, relation TEXT, weight REAL, kind TEXT, evidence_scope TEXT, owner_key TEXT, is_active INTEGER)')
    const sh = store.db.prepare('INSERT INTO graph_shadow_edges (source_id, target_id, relation, weight, kind,'
      + ' evidence_scope, owner_key, is_active) VALUES (?,?,?,?,?,?,?,1)')
    sh.run('a', 'b', '共现', 1, 'cooccur_same_memory', 'same_memory', MASTER_ID)
    sh.run('a', 'c', '共现', 4, 'cooccur_same_memory', 'same_memory', MASTER_ID)
    sh.run('b', 'c', '同日共现', 2, 'cooccur_same_day', 'same_day', MASTER_ID)
    // 证据层:用**引擎那份真视图**(照活库的 DDL),两张同一天一起出现 = 同一个对被 2 条支持
    store.db.exec('CREATE TABLE IF NOT EXISTS graph_cooc_evidence (evidence_id INTEGER PRIMARY KEY,'
      + ' owner_key TEXT, scope_kind TEXT, memory_id INTEGER, day_key TEXT, node_ids TEXT, pairs TEXT,'
      + ' node_count INTEGER, pair_count INTEGER, weight REAL, source_kind TEXT, created_at REAL)')
    store.db.exec("INSERT INTO graph_cooc_evidence (owner_key, scope_kind, memory_id, day_key, node_ids, pairs,"
      + " node_count, pair_count, weight, source_kind, created_at) VALUES"
      + " ('__cooc__','same_memory',3,'0','a、b','a|b',2,1,4.0,'test',1.0),"
      + " ('__cooc__','same_day',0,'1789660800','a、b、c','a|b,b|c',3,2,1.0,'test',2.0)")
    store.db.exec(`CREATE VIEW IF NOT EXISTS v_cooc_pairs AS
      WITH RECURSIVE exp(evidence_id, rest, item) AS (
        SELECT evidence_id, pairs || ',', '' FROM graph_cooc_evidence
        UNION ALL
        SELECT evidence_id, substr(rest, instr(rest, ',') + 1), substr(rest, 1, instr(rest, ',') - 1)
        FROM exp WHERE rest <> ''
      )
      SELECT e.evidence_id, e.owner_key, e.scope_kind, e.memory_id, e.day_key, x.item AS pair_key,
             substr(x.item, 1, instr(x.item, '|') - 1) AS source_id,
             substr(x.item, instr(x.item, '|') + 1) AS target_id, e.weight AS weight, e.created_at AS created_at
      FROM exp x JOIN graph_cooc_evidence e ON e.evidence_id = x.evidence_id WHERE x.item <> ''`)
    const L = store.graphData().layers
    assert.deepEqual(L.shadow.rows.map((r) => r.weight), [4, 2, 1], '影子边该按权重降序(重的先画)')
    const evi = Object.fromEntries(L.evidence.rows.map((r) => [r.id, r.support]))
    assert.equal(evi['a|b'], 2, 'a|b 被两条证据支持')
    assert.equal(evi['b|c'], 1)
    assert.deepEqual(L.evidence.rows[0].id, 'a|b', '支持数高的排前面')
  } finally { store.close() }
})

// ─────────────────────────────────────────────────────────────
// ② 页面侧:过滤是纯函数(默认关 / 阈值 / 端点不在图上要计数)
// ─────────────────────────────────────────────────────────────
const LAYERS = {
  shadow: { nature: '3a 历史(已冻结)', inRetrieval: false, rows: [
    { id: 1, source: 'a', target: 'b', weight: 1, relation: '共现', scope: 'same_memory' },
    { id: 2, source: 'a', target: 'c', weight: 4, relation: '共现', scope: 'same_memory' },
    { id: 3, source: 'x', target: 'y', weight: 9, relation: '共现', scope: 'same_day' }
  ] },
  evidence: { nature: '中间层(只读派生)', inRetrieval: false, rows: [
    { id: 'a|b', source: 'a', target: 'b', support: 5, relation: '同域', scope: 'same_day' },
    { id: 'b|c', source: 'b', target: 'c', support: 1, relation: '同域', scope: 'same_day' }
  ] }
}
const VISIBLE = new Set(['a', 'b', 'c'])

test('幽灵层:默认关 ⇒ 一条都不返回(默认视图与以前一模一样)', () => {
  const sel = ghostSelectOf()
  const off = sel(LAYERS, VISIBLE, { shadow: { on: false, min: 1 }, evidence: { on: false, min: 1 } })
  assert.deepEqual(off.shadow.rows, [])
  assert.deepEqual(off.evidence.rows, [])
  // 连 opts 都没有(老页面/老调用)也不许炸
  const none = sel(LAYERS, VISIBLE, undefined)
  assert.deepEqual(none.shadow.rows, [])
})

test('幽灵层:阈值只管自己那一层(史看权重 / 联想看被几条支持)', () => {
  const sel = ghostSelectOf()
  const s1 = sel(LAYERS, VISIBLE, { shadow: { on: true, min: 1 }, evidence: { on: false, min: 1 } })
  assert.deepEqual(s1.shadow.rows.map((r) => r.id), [1, 2], 'x→y 端点不在图上,不该画')
  assert.equal(s1.shadow.dropped, 1, '端点不在图上的要计数(不许静默少画)')
  assert.equal(s1.shadow.hidden, 0)
  const s4 = sel(LAYERS, VISIBLE, { shadow: { on: true, min: 4 }, evidence: { on: false, min: 1 } })
  assert.deepEqual(s4.shadow.rows.map((r) => r.id), [2], '权重下限 4 只留最重的那条')
  assert.equal(s4.shadow.hidden, 1, '被阈值藏起来的也要计数')
  const e2 = sel(LAYERS, VISIBLE, { shadow: { on: false, min: 1 }, evidence: { on: true, min: 2 } })
  assert.deepEqual(e2.evidence.rows.map((r) => r.id), ['a|b'], '只留被 ≥2 条证据支持的')
  assert.equal(e2.evidence.hidden, 1)
  // 两层互不影响:开史不该把联想也带出来
  assert.deepEqual(s4.evidence.rows, [])
})

test('幽灵层:老引擎没有 layers 字段时安静地空(不炸、不编)', () => {
  const sel = ghostSelectOf()
  const out = sel(undefined, VISIBLE, { shadow: { on: true, min: 1 }, evidence: { on: true, min: 1 } })
  assert.deepEqual(out.shadow.rows, [])
  assert.deepEqual(out.evidence.rows, [])
})

// ─────────────────────────────────────────────────────────────
// ③ 页面契约:控件 / 图层顺序 / 不被污染 / 跟随布局
// ─────────────────────────────────────────────────────────────
test('幽灵层:工具条上两套控件(开关 + 阈值),默认都是关 / 阈值 1', () => {
  assert.match(graphHtml, /id="ghost-shadow-btn"[^>]*onclick="cycleGhost\('shadow'\)"/, '缺史层开关')
  assert.match(graphHtml, /id="ghost-evi-btn"[^>]*onclick="cycleGhost\('evidence'\)"/, '缺联想层开关')
  assert.match(graphHtml, /id="ghost-shadow-min"[^>]*min="1" max="4"[^>]*oninput="onGhostMin\('shadow',\+this\.value\)"/, '史层阈值滑杆')
  assert.match(graphHtml, /id="ghost-evi-min"[^>]*min="1" max="5"[^>]*oninput="onGhostMin\('evidence',\+this\.value\)"/, '联想层阈值滑杆')
  assert.match(code, /let ghost = \{ shadow: \{ on: false, min: 1 \}, evidence: \{ on: false, min: 1 \} \}/, '两层默认必须是关')
  // 阈值范围要跟着真实分布:影子边只 1–4 分、联想对最多被 5 条支持
  assert.match(graphHtml, /影子边权重下限\(1–4/, '滑杆 title 该写清分档')
  assert.match(graphHtml, /联想对要「被几条证据支持」才画/, '滑杆 title 该写清分档')
})

test('幽灵层:两个读数单开(不许挤进"关系/连线")', () => {
  assert.match(graphHtml, /id="ss">0<\/span>/, '统计栏缺"史"这一项')
  assert.match(graphHtml, /id="sg">0<\/span>/, '统计栏缺"联想"这一项')
  assert.match(code, /ghostStat\('ss', 'shadow'/, '史那一项没接上')
  assert.match(code, /ghostStat\('sg', 'evidence'/, '联想那一项没接上')
  // 既有契约:连线数 = 束数 —— 幽灵层绝不能掺进去
  assert.match(code, /\$\('sl'\)\.textContent = bundles\.length/, '连线数被动了')
  assert.match(code, /currentLinks = d3Links/, '力导向的边表被动了')
  assert.doesNotMatch(code, /d3Links = .*ghost/i, '幽灵线混进了力导向(d3Links)')
  assert.doesNotMatch(code, /for \(const e of ghostLinks\)[^]{0,200}bundleOf/, '幽灵线混进了束合并')
})

test('幽灵层:画在事实线**下面**,而且跟着布局走', () => {
  const gi = code.indexOf("const ghostG = g.append('g').attr('class', 'ghost-layer')")
  const bi = code.indexOf('const bundles = []')
  assert.ok(gi > 0 && bi > 0, '缺幽灵组或束合并那一段')
  assert.ok(gi < bi, '幽灵组必须建在束/连线之前 —— 否则它会盖在事实线上')
  assert.match(code, /ghostG\.selectAll\('\.ghost-link'\)\.attr\('d', \(d\) => T\.arcPath\(/, '幽灵线没跟着布局走(会停在原地)')
  assert.match(code, /\.attr\('class', \(d\) => 'ghost-link ' \+ d\.kind\)/, '幽灵线没有各自的 class(样式分不开)')
  assert.match(code, /\.append\('title'\)\.text\(\(d\) => ghostTitle\(d\)\)/, '幽灵线没有提示(鼠标停上去不知道它是什么)')
  assert.match(code, /return '史 · 影子边 w=' \+ d\.weight/, '影子边的提示该说清它是史')
  assert.match(code, /共现证据层\(中间层\):同一轮\/同一天一起出现过;不进检索/, '联想边的提示该说清它是中间层、不进检索')
})

test('幽灵层:CSS 齐(房子规矩:发出的类名都得有样式)+ 一眼可辨', () => {
  assert.match(graphHtml, /\.ghost-layer\{pointer-events:none\}/, '缺 .ghost-layer 的 pointer-events(会挡住点线展依据)')
  assert.match(graphHtml, /\.ghost-link\{fill:none;pointer-events:stroke\}/, '幽灵线要么点不到(提示弹不出来),要么连成一片')
  assert.match(graphHtml, /\.ghost-link\.shadow\{[^}]*stroke-dasharray:3 5/, '影子边该是虚线(和事实线一眼分得开)')
  assert.match(graphHtml, /\.ghost-link\.evidence\{[^}]*opacity:\.28/, '联想边该更淡')
  assert.match(graphHtml, /\.ghost-val\{/, '缺阈值读数样式')
})

test('幽灵层:引擎没给这两层时,控件**当场说实话**(不许点了没反应)', () => {
  // 2026-10-02 他:「我并没有在记忆图谱上面看出什么变化」—— 病根是插件还没重挂载
  // (store.js 在进程里),接口里没有 layers:两个按钮看着能点,点下去什么都不画。
  assert.match(code, /function ghostLayersReady \(\)/, '缺"引擎给没给这两层"的判据')
  assert.match(code, /if \(!ghostLayersReady\(\)\) \{ render\(\); return \}/, '没数据时开关不该装成"打开了"')
  assert.match(code, /node\.textContent = '—'/, '没数据时读数该写 "—" 而不是 0')
  assert.match(code, /引擎\*\*还没给这一层\*\* —— 要重挂载插件/, '没数据时要在提示里说清"要重挂载"')
  assert.match(code, /b\.textContent = ready/, '按钮文字该跟着"有没有数据"变')
  assert.match(graphHtml, /\.ghost-missing\{opacity:\.45;cursor:not-allowed\}/, '缺 .ghost-missing 样式')
})

test('幽灵层:重置会复位、轮询会认它变化', () => {
  assert.match(code, /ghost = \{ shadow: \{ on: false, min: 1 \}, evidence: \{ on: false, min: 1 \} \}/, '重置没复位幽灵层')
  assert.match(code, /const ghostKey = \(l\) =>/, '轮询没认幽灵层的变化(证据层是活的,会长)')
  assert.match(code, /ghostKey\(graphData\.layers\) !== ghostKey\(nd\.layers\)/, '幽灵层的变化没接进 dataChanged')
})
