/**
 * 写入侧去噪闸门(阶段 1a 规则本体 + 阶段 1b 接线)的结构守卫。
 *
 * 规则本身是 Python 纯函数,行为断言在 `python/tests/test_graph_gate.py`
 * (走 `npm run test:py`);这里守的是**硬边界**,漂了必须红灯:
 *
 *   ① 开关默认关(`DEFAULT_ENABLED = False` + `ECHO_GRAPH_GATE` 环境变量);
 *   ② 接线**只有一处**(`python/worker.py` 的 graph_learn 写边路径),事实边写路径
 *      (`python/engine/graph.py`)与壳(`lib/index.js`)都不许碰闸门;
 *   ③ 六条规则(R1–R6)都在规则表里,且每条各带一条单测(无单测 = 未落地);
 *   ④ reason 枚举**单一出处**(`REASON_ENUM`);`belief` 在 `node_type` 取值域里;
 *   ⑤ 回执表只 `CREATE TABLE IF NOT EXISTS`,迁移里不许出现 DROP / 重建。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8')

test('闸门默认关:DEFAULT_ENABLED 必须是 False,开关走 ECHO_GRAPH_GATE', () => {
  const src = read('python/engine/graph_gate.py')
  assert.match(src, /^DEFAULT_ENABLED = False$/m, '闸门被默认打开了?')
  assert.match(src, /^SWITCH_ENV = "ECHO_GRAPH_GATE"$/m, '开关环境变量名改了吗?')
  assert.match(src, /^def gate_enabled\(/m, '没有开关函数')
})

test('接线只有一处:worker.py 一处调用;graph.py / 壳不许碰闸门', () => {
  const worker = read('python/worker.py')
  const calls = worker.split('maybe_gate_shadow_edges(').length - 1
  assert.equal(calls, 1, 'worker.py 的接线口必须恰好一处,现有 ' + calls + ' 处')
  assert.equal(worker.split('graph_gate').length - 1, 6,
    'worker.py 里的 graph_gate 应恰好六处(import + 开关读取 + 一处调用 + 影子归属键 '
    + '+ P1c 的 names_from_frame + P3-a 的 data_from_frame)')
  assert.ok(worker.includes('ECHO_GRAPH_GATE'), '调用点上要写明开关名字(可追溯)')
  assert.ok(!read('python/engine/graph.py').includes('graph_gate'),
    'graph.py 是事实边写路径,不许提闸门')
  assert.ok(!read('lib/index.js').includes('graph_gate'), '壳侧不许提闸门')
})

test('闸门只吃影子边 kinds(事实边绝不被拦)', () => {
  const src = read('python/engine/graph_gate.py')
  assert.match(src, /^def is_shadow_candidate\(/m, '没有影子边判定函数')
  assert.ok(src.includes('SHADOW_KINDS'), '影子边取值域不见了')
  const wiring = read('python/worker.py')
  assert.ok(
    /maybe_gate_shadow_edges\(conn, graph_gate\.SHADOW_OWNER,\s*\n?\s*candidates=candidates,/
      .test(wiring),
    '接线口应传影子归属键 SHADOW_OWNER + 挖出来的候选(传 owner 会让影子边进检索)')
  // P1c:名字集合随帧下发 —— 接线口必须把帧里的 names 一并传进去(否则引擎只能退化到空集合)
  assert.ok(/maybe_gate_shadow_edges\(conn, graph_gate\.SHADOW_OWNER,[\s\S]*?speakers=_speakers,[\s\S]*?person_names=_person_names\)/
    .test(wiring),
    '接线口要把 frame["names"] 解析出来的 speakers / person_names 传下去')
  assert.ok(wiring.includes('graph_gate.names_from_frame(frame)'),
    '名字只能从帧里取(引擎不自己读文件)')
  assert.ok(!/maybe_gate_shadow_edges\(conn, owner,/.test(wiring),
    '不许再用事实边的 owner 传影子边')
})

test('卡口 1(方案 A):影子边独立归属键 + DMAE 只看事实边', () => {
  const gateSrc = read('python/engine/graph_gate.py')
  assert.match(gateSrc, /^SHADOW_OWNER = "__shadow__"$/m,
    '影子归属键必须是单一出处常量')
  const graphSrc = read('python/engine/graph.py')
  assert.ok(/AND COALESCE\(kind, ''\) = ''/.test(graphSrc),
    'DMAE 的 all_edges 口必须按 kind 排掉影子边')
  assert.ok(/def _has_column\(conn, table: str, column: str\)/.test(graphSrc),
    '老库没有 kind 列时要退回不过滤(走 _has_column 单一出处)')
  assert.ok(/_has_column\(conn, "graph_edges", "kind"\)/.test(graphSrc),
    'kind 列的存在性检查要写成 _has_column(conn, "graph_edges", "kind")')
  const tests = read('python/tests/test_graph_gate.py')
  for (const cls of ['ShadowOwnerIsolation', 'DmaeExcludesShadowEdges']) {
    assert.ok(tests.includes('class ' + cls), cls + ' 的单测不在')
  }
  for (const name of ['test_shadow_write_keeps_master_load_bit_identical',
    'test_other_owner_scoped_readers_see_nothing',
    'test_prune_never_deletes_shadow_edges',
    'test_materialize_does_not_write_shadow_activation',
    'test_fact_edge_dmae_behaviour_unchanged', 'test_kind_less_db_is_tolerated']) {
    assert.ok(tests.includes(name), '缺单测:' + name)
  }
})

test('路线 2(2026-10-01 人类裁决):影子边另立一张表 —— 老表一行不许有影子', () => {
  const dbSrc = read('python/engine/db.py')
  assert.match(dbSrc, /CREATE TABLE IF NOT EXISTS graph_shadow_edges/,
    '新表没在建表迁移里')
  assert.ok(/def _migrate_graph_shadow_edges\(conn\)/.test(dbSrc),
    '新表要走独立的迁移函数')
  assert.ok(/_migrate_graph_shadow_edges\(conn\)/.test(dbSrc), '迁移没被 connect 调用')
  for (const col of ['source_id', 'target_id', 'relation', 'weight', 'kind',
    'owner_key', 'evidence', 'evidence_scope', 'occurred_at', 'occurred_at_source',
    'is_active', 'created_at']) {
    assert.ok(new RegExp('^\\s+' + col + '\\s', 'm').test(dbSrc),
      '影子表缺列:' + col)
  }
  for (const banned of ['activation', 'half_life', 'recall_count', 'last_accessed']) {
    const block = dbSrc.slice(dbSrc.indexOf('CREATE TABLE IF NOT EXISTS graph_shadow_edges'),
      dbSrc.indexOf('CREATE INDEX IF NOT EXISTS idx_shadow_edge_src'))
    assert.ok(!new RegExp('^\\s+' + banned + '\\s', 'm').test(block),
      '影子表不许有 DMAE 状态列:' + banned)
  }
  // 写入侧:只写新表(允许读 graph_edges,不许 INSERT/UPDATE/DELETE 它)
  const gateSrc = read('python/engine/graph_gate.py')
  assert.match(gateSrc, /^SHADOW_TABLE = "graph_shadow_edges"$/m,
    '表名必须是单一出处常量')
  assert.match(gateSrc, /^WRITE_ROUTE = "cooc-evidence"$/m,
    'route 标记要单一出处(v2-A4 起新写落证据层)')
  assert.match(gateSrc, /^WRITE_ROUTE_HISTORICAL = "shadow-table"$/m,
    '历史回执的 route 值要留档(否则旧行的审计无从对账)')
  assert.ok(!/INSERT INTO graph_edges/.test(gateSrc), '影子边又往老表写了')
  assert.ok(!/UPDATE graph_edges/.test(gateSrc), '影子边又改老表了')
  assert.ok(!/DELETE FROM graph_edges/.test(gateSrc), '闸门不许删事实边')
  // 回执带 route 列(纯 ADD COLUMN)
  assert.ok(/ADD COLUMN route TEXT/.test(dbSrc), '回执表没加 route 列')
  const tests = read('python/tests/test_graph_gate.py')
  for (const name of ['test_shadow_table_created_pure_add',
    'test_write_path_only_touches_shadow_table', 'test_receipts_route_column_added',
    'test_47_shadow_edges_change_no_existing_reading',
    'test_orphan_node_is_not_exempted_by_a_shadow_edge']) {
    assert.ok(tests.includes(name), '缺单测:' + name)
  }
  assert.ok(tests.includes('class ShadowTableZeroLeak'), '零泄漏单测类不在')
})

test('卡口 2:top_nodes 只看事实边 —— 且过滤必须写在 ON 子句,不许写 WHERE', () => {
  // 现场(2026-10-01):这段 LEFT JOIN 只过滤节点 owner、不过滤边 owner ⇒ 影子边
  // 把「音理」从第 7 名顶到第 2 名,而这张名单喂的是 extract_prompt 的 knownEntities。
  const graphSrc = read('python/engine/graph.py')
  const onIdx = graphSrc.indexOf('def top_nodes')
  assert.ok(onIdx > 0, 'top_nodes 不在了?')
  const body = graphSrc.slice(onIdx, graphSrc.indexOf('def _merge_evidence'))
  const factsIdx = body.indexOf('+ facts_only')
  const whereIdx = body.indexOf('WHERE (n.owner_key')
  assert.ok(/AND COALESCE\(e\.kind, ''\) = ''/.test(body), 'top_nodes 里没有 kind 过滤')
  assert.ok(factsIdx > 0 && whereIdx > 0, '拼 SQL 的形状变了(找不到 facts_only / WHERE)')
  assert.ok(factsIdx < whereIdx,
    'facts_only 必须接在 ON 子句后、WHERE 之前 —— 写进 WHERE 会让"只挂影子边的节点"'
    + '整条从榜单消失(实测 12 → 3)')
  assert.ok(/ON \(e\.source_id = n\.node_id OR e\.target_id = n\.node_id\)"/.test(body),
    'ON 子句形状变了')
  const tests = read('python/tests/test_graph_gate.py')
  assert.ok(tests.includes('class TopNodesFactOnly'), 'TopNodesFactOnly 的单测不在')
  for (const name of ['test_shadow_edges_do_not_enter_top_nodes',
    'test_all_three_owner_branches_are_guarded',
    'test_fact_edge_still_moves_the_ranking',
    'test_fact_edges_only_bit_identical', 'test_kind_less_db_still_returns_names']) {
    assert.ok(tests.includes(name), '缺单测:' + name)
  }
})

test('阶段 3a 接线:挖边与闸门都只在开关开时才跑(默认关)', () => {
  const worker = read('python/worker.py')
  // 挖边必须被开关挡住 —— 关掉时连"挖"都不做(不只是不写)
  assert.match(worker, /if graph_gate\.gate_enabled\(\):/,
    '挖边没有被开关挡住')
  assert.ok(/graph_mine\.candidates_for_latest_memory\(/.test(worker),
    '没有"刚写入的那条记忆 ⇒ 候选"的挖边调用')
  assert.ok(/candidates = None/.test(worker),
    '开关关时应当把 candidates 显式设为 None(连库都不读)')
  assert.ok(!read('python/engine/graph.py').includes('graph_mine'), 'graph.py 不许碰挖边')

  const mine = read('python/engine/graph_mine.py')
  assert.match(mine, /^MINE_VERSION = "/m, '挖矿没有版本号(对账要用)')
  assert.ok(mine.includes('source_memory_ids') && mine.includes('target_memory_ids'),
    '两端 memory ids 没给(R2 会退化成"证据非空即过")')
  assert.ok(mine.includes('CONCEPT_NODE_TYPES'), '没有"两端必须是既有概念节点"的筛子')
  // 挖掘模块只读:不许出现写库 SQL(落库是 graph_gate.write_accepted_edges 的职权)
  for (const sql of ['INSERT INTO', 'UPDATE graph', 'DELETE FROM', 'CREATE TABLE']) {
    assert.ok(!mine.includes(sql), '挖掘模块里出现写库语句:' + sql)
  }
  // CLI 只允许 dry-run:显式拒绝写模式
  assert.ok(mine.includes('"--write"') && mine.includes('"--apply"'),
    'CLI 没有拒绝写模式的闸')
  assert.ok(mine.includes('--dry-run'), 'CLI 没有 dry-run 入口')
  const tests = read('python/tests/test_graph_mine.py')
  for (const cls of ['MatcherScope', 'HitScope', 'PairMining', 'TwoSidedEvidence',
    'TimeSource', 'DryRunAndCli', 'SameDayMining', 'SameDayR2KindAware',
    'MergedView', 'CliKinds']) {
    assert.ok(tests.includes('class ' + cls), cls + ' 的单测不在')
  }
  // Public synthetic contracts and explicit historical controls are separate.
  assert.doesNotMatch(tests, /^class ContractReconcile\b/m,
    '私有快照控制不应重新进入公共发现')
  const publicContracts = read('python/tests/test_graph_public_contracts.py')
  assert.match(publicContracts, /^class PublicGraphReconciliation\(unittest\.TestCase\):$/m,
    '公共合成对账测试类不在')
  const publicMethods = [
    'test_same_day_fixture_counts_and_kind_aware_r2',
    'test_same_memory_fixture_exclusion_and_strict_r2',
    'test_speaker_names_are_explicit_and_absent_names_are_neutral',
    'test_bad_name_shapes_and_list_comma_equivalence',
    'test_nonempty_snapshot_bytes_and_rows_are_preserved'
  ]
  const methodNames = source => [...source.matchAll(/^    def (test_[A-Za-z0-9_]+)\(self\):$/gm)]
    .map(match => match[1]).sort()
  assert.deepEqual(methodNames(publicContracts), [...publicMethods].sort(),
    '公共合成图谱契约必须恰好保留五项')
  assert.match(publicContracts, /mine\.dry_run\(/, '公共契约没有调用真实 dry_run')
  assert.match(publicContracts, /gate\.gate_edge\(/, '公共契约没有调用真实 R2 闸门')

  const historicalMethods = [
    'test_pinned_snapshot_reproduces_same_day_numbers',
    'test_pinned_snapshot_reproduces_contract_numbers',
    'test_contract_numbers_need_the_names_fed_in',
    'test_dry_run_names_shapes_never_throw',
    'test_dry_run_on_snapshot_is_read_only'
  ]
  const historical = read('python/manual/verify_snapshot.py')
  assert.match(historical, /^class ContractReconcile\(unittest\.TestCase\):$/m,
    '原有私有快照测试类必须保留在手工入口')
  assert.deepEqual(methodNames(historical), [...historicalMethods].sort(),
    '原有五项私有快照控制不应被删除或替换')
  const inventory = JSON.parse(read('python/manual/INVENTORY.json'))
  assert.ok(Array.isArray(inventory.tests), '手工清单 tests 必须是数组')
  const prefix = 'test_graph_mine.ContractReconcile.'
  const manual = inventory.tests.filter(item => typeof item?.id === 'string' && item.id.startsWith(prefix))
  assert.deepEqual(manual.map(item => item.id).sort(),
    historicalMethods.map(name => prefix + name).sort(), '手工清单必须登记原有五项')
  for (const item of manual) {
    assert.equal(item.module, 'python/manual/verify_snapshot.py')
    assert.equal(item.status, 'NOT_RUN_MANUAL')
    assert.ok(typeof item.reason === 'string' && item.reason.includes('private historical snapshot'),
      '私有快照控制必须保留显式前置条件')
  }

})

test('阶段 3a 第二步:同天共现口径 + 合并视图 + 禁窗口口径', () => {
  const mine = read('python/engine/graph_mine.py')
  assert.match(mine, /^def mine_same_day_candidates\(/m, '没有同天共现挖掘器')
  assert.match(mine, /^def local_day\(/m, '没有本地日期函数')
  assert.match(mine, /^def day_midnight_epoch\(/m, '没有「当天本地 00:00」函数')
  assert.ok(mine.includes('EVIDENCE_CAP'), '没有证据数组上限(契约默认 16)')
  assert.ok(mine.includes('TIME_SOURCE_SAME_DAY'), '同天边的时间来源没接闸门那套常量')
  assert.ok(mine.includes('evidence_truncated'), '没有证据裁剪标记')
  assert.ok(/\"day\": day/.test(mine), '候选里没有 day 字段')
  assert.ok(/"weight": float\(len\(entry\["days"\]\)\), "count": len\(entry\["days"\]\)/
    .test(mine), 'weight/count 必须是「覆盖天数」')
  assert.ok(mine.includes('_same_day_evidence'), '没有「每天取两端最晚一条」的证据构造')
  assert.ok(mine.includes('_edge_readings') && mine.includes('active_edges_after'),
    '没有合并视图读数')
  assert.ok(mine.includes('active_edges_without_speaker_after'), '没有「不含说话人」那一档')
  assert.ok(mine.includes('candidates_for_latest_memory'), '没有单条记忆入口')
  // 窗口口径**只能**出现在"我们没有它"的说明里,不许真的实现参数解析
  assert.ok(!/val\("--last"\)/.test(mine) && !/argv\.includes\('--last'\)/.test(mine),
    '不许真的实现窗口口径 --last N(同一对会被反复重计)')
  assert.ok(/没有\*\*窗口口径/.test(mine), '「禁窗口口径」的纪律应当写在 CLI 帮助里')
  assert.ok(read('python/engine/graph_gate.py').includes('同日共现'),
    '同天边的保留谓词名不在闸门里')
  assert.ok(mine.includes('evidence_scope'), '候选里没有 evidence_scope(裁决①要它在候选里)')
})

test('阶段 3a 第二步裁决①②:R2 按谓词取判据 + 同对累加 + 影子边保留名告警', () => {
  const src = read('python/engine/graph_gate.py')
  // 裁决①:R2 必须**活着**,但换对的谓词判 —— 不许靠"拔掉两端 ids"退化成非空即过
  assert.match(src, /^EVIDENCE_SCOPE_SAME_MEMORY = /m, '没有 same_memory 口径常量')
  assert.match(src, /^EVIDENCE_SCOPE_SAME_DAY = /m, '没有 same_day 口径常量')
  assert.match(src, /^EVIDENCE_SCOPES = /m, '口径枚举没有单一出处')
  assert.match(src, /^def _default_evidence_scope\(/m, '没有按 kind 推口径的兜底')
  assert.ok(/scope == EVIDENCE_SCOPE_SAME_DAY/.test(src), 'R2 里没有同天分支')
  assert.ok(/"evidence_scope": _text\(edge\.get\("evidence_scope"\)\)/.test(src),
    '回执里没有 evidence_scope')
  assert.ok(src.includes('evidence_scope') && read('python/engine/db.py').includes(
    'evidence_scope      TEXT DEFAULT'), '回执表没有 evidence_scope 列(要可 SQL 查)')
  // 裁决②:S1 累加 / "没变化就不写" —— v2-A4 起累加发生在**证据行**里(桶内并集),
  // 且**影子表冻结**(写口一行都不许再往它加)
  assert.match(src, /INSERT INTO " \+ cooc_mod\.EVIDENCE_TABLE/m, '写口没落进证据层')
  assert.match(src, /old_pairs \| bucket\["pairs"\]/, '没有"桶内并集"的累加写法')
  assert.match(src, /merged != old_pairs/, '没有「没变化就不写」的判据(第二跑改动数要 0)')
  assert.match(src, /^def _shadow_row_count\(/m, '没有影子表冻结的现场计数(跑前跑后要对得上)')
  assert.ok(!/INSERT INTO " \+ SHADOW_TABLE/.test(src), '写口又往影子表加了行(冻结破了)')
  assert.ok(/"updated": updated, "skipped": skipped,/.test(src), '返回值没有 updated')
  assert.ok(/last_accessed \/ half_life \/ recall_count/.test(src) ||
    src.includes('影子边不是"被想起"'), 'S1 的"DMAE 字段一律不动"纪律没写下来')
  // 影子边谓词保留名告警 + 事实边不是这个写口的活儿
  // (路线 2 起:告警看的是"`graph_edges` 占没占保留谓词槽位",写口只写新表)
  assert.ok(src.includes('保留谓词槽位'), '没有"保留谓词槽位被占了"的告警')
  assert.ok(/_is_shadow_kind\(kind\)/.test(src) && /kind = _kind_of\(edge\)/.test(src),
    '写口没有"只吃共现类"的筛子')
  const tests = read('python/tests/test_graph_gate.py')
  for (const cls of ['RuleR2KindAwareScope', 'ShadowAccumulation']) {
    assert.ok(tests.includes('class ' + cls), cls + ' 的单测不在')
  }
  const mineTests = read('python/tests/test_graph_mine.py')
  for (const name of ['test_cross_memory_same_day_edge_now_passes',
    'test_same_memory_edge_keeps_intersection_rule']) {
    assert.ok(mineTests.includes(name), '缺单测:' + name)
  }
  for (const name of [
    'test_restatement_accumulates_evidence_and_count', 'test_repeat_is_idempotent_zero_changes',
    'test_dmae_state_is_never_touched', 'test_slot_deactivation_hazard_is_gone_by_construction',
    'test_fact_edge_on_shadow_slot_warns_and_is_left_alone']) {
    assert.ok(tests.includes(name), '缺单测:' + name)
  }
})

test('六条规则都在规则表里,且每条各带一条单测', () => {
  const src = read('python/engine/graph_gate.py')
  for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) {
    assert.ok(src.includes(`"rule_id": "${id}"`), '规则表里没有 ' + id)
  }
  const tests = read('python/tests/test_graph_gate.py')
  for (const cls of ['RuleR1SpeakerEndpoint', 'RuleR2ZeroOverlap', 'RuleR3Alias',
    'RuleR4TypeDirection', 'RuleR5SlotIsolation', 'RuleR6NoOccurredAt',
    'RuleTableMiss', 'WiringSwitchOn', 'DefaultOffInvariance']) {
    assert.ok(tests.includes('class ' + cls), cls + ' 的单测不在')
  }
  // 阶段 1 的核心验收:0 条泄漏(构造输入含说话人节点)
  assert.ok(tests.includes('test_no_speaker_leakage_on_constructed_batch'))
})

test('reason 唯一出处:REASON_ENUM,两个扩展码已登记', () => {
  const src = read('python/engine/graph_gate.py')
  assert.match(src, /^REASON_ENUM = \(/m, 'reason 枚举没有单一出处 REASON_ENUM')
  assert.match(src, /^REASONS = REASON_ENUM$/m, 'REASONS 必须是 REASON_ENUM 的别名')
  for (const reason of ['speaker-node', 'zero-overlap', 'alias-missing-canonical',
    'bad-endpoint-type', 'bad-direction', 'no-occurred-at',
    'slot-conflict', 'internal-error', 'restore', 'multivalue-slot-collision']) {
    assert.ok(src.includes(`= "${reason}"`), 'reason 枚举缺 ' + reason)
  }
})

test('node_type 取值域含 belief(soul-snapshot 早在查它)', () => {
  const src = read('python/engine/graph_gate.py')
  assert.match(src, /^NODE_TYPE_BELIEF = "belief"$/m)
  assert.ok(src.includes('NODE_TYPE_BELIEF'), 'belief 没进取值域')
  for (const t of ['NODE_TYPE_CONCEPT', 'NODE_TYPE_PERSON', 'NODE_TYPE_EPISODE']) {
    assert.ok(src.includes(t), '取值域缺 ' + t)
  }
})

test('回执表:CREATE TABLE IF NOT EXISTS,迁移里不许 DROP / 重建', () => {
  const src = read('python/engine/db.py')
  assert.ok(src.includes('CREATE TABLE IF NOT EXISTS graph_edge_receipts'),
    '回执表不在迁移里')
  assert.ok(src.includes('_migrate_graph_edge_receipts'), '迁移函数没被接上')
  assert.ok(!src.includes('DROP COLUMN') && !src.includes('DROP TABLE') &&
    !src.includes('RENAME TO'), '迁移里出现 DROP / 重建(只许纯增)')
  assert.ok(src.includes("\"kind\", \"TEXT DEFAULT ''\""), 'kind 列不在迁移数组里')
})

test('闸门自身出错要留痕:internal-error 回执优先,stderr 全量兜底(裁决④)', () => {
  const src = read('python/engine/graph_gate.py')
  assert.match(src, /^def report_internal_error\(/m, '没有 internal-error 留痕入口')
  assert.match(src, /^def internal_error_receipt\(/m, '没有 internal-error 回执构造')
  assert.ok(src.includes('REASON_INTERNAL_ERROR'), '回执没有用登记的 internal-error 码')
  assert.ok(src.includes('traceback.format_exc()'), 'stderr 兜底没带完整回溯')
  assert.ok(!/^\s*diag\(/m.test(src), '闸门不许走 diag()(它有预算,会截掉回溯)')
  assert.ok(src.includes('不截断'), '兜底打印要写明"不截断"')
  const tests = read('python/tests/test_graph_gate.py')
  for (const t of ['test_receipt_written_when_edge_write_fails',
    'test_degrades_to_untruncated_stderr_when_table_unusable',
    'test_safe_receipt_degrades_on_unreadable_candidate']) {
    assert.ok(tests.includes(t), 'internal-error 路径缺单测:' + t)
  }
})

test('回执行数报表:只读、不清理、不占 npm scripts(裁决②)', () => {
  const src = read('scripts/graph-receipts-report.mjs')
  assert.ok(src.includes('?mode=ro') && src.includes('readOnly: true'),
    '回执报表不是只读打开的')
  assert.ok(src.includes('mtimeUnchanged'), '报表没作证 mtime 未变')
  assert.ok(src.includes('本报表只读,未修改任何数据'), '报表没有只读声明')
  // 只查**真被执行**的 SQL(注释里出现 "ALTER TABLE" 是解释为什么不用 openStore,不算)
  assert.ok(!/db\.(?:prepare|exec)\(\s*[`'"][\s\S]{0,120}?(?:DELETE|DROP|ALTER|INSERT|UPDATE)\b/i.test(src),
    '报表里出现写库 SQL(裁决②明确本轮不做清理)')
  assert.ok(!read('package.json').includes('graph-receipts-report'),
    '报表不该占 package.json 的 scripts 入口(同 graph-baseline 的纪律)')
  for (const word of ['默认不清理', '--runs']) {
    assert.ok(src.includes(word), '报表缺口径:' + word)
  }
})
