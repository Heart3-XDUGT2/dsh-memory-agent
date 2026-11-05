import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const sandbox = {};
new Function('globalThis', readFileSync(new URL('../web/mock/final/audit-ownership.js', import.meta.url), 'utf8'))(sandbox);
const { create } = sandbox.EchoAuditOwnership;
const row = sessionId => ({ sessionId });
const known = session => ({ state: 'known', session });

test('精确自定义陪伴独立于QQ来源和默认ID，不推断opaque/UUID代理关系', () => {
  const rows = ['custom-secret', 'session-echo-companion', 'opaque-qq-secret', '12345678-1234-1234-1234-123456789abc', 'global'].map(row);
  rows[2].toolCall = 'relay_in';
  const c = create(rows, known('custom-secret'));
  assert.deepEqual(rows.map(r => c.row(r)), [
    { category: 'companion', number: 2, label: '陪伴会话' },
    { category: 'other', number: 4, label: '其他会话 4' },
    { category: 'other', number: 3, label: '其他会话 3' },
    { category: 'other', number: 1, label: '其他会话 1' },
    { category: 'global', number: null, label: '全局记录' }
  ]);
});
test('只用trim判无效，合法原键精确比较；global只认精确字面', () => {
  const rows = [' target ', 'target', 'global', ' global ', null, '', ' \t ', 7, {}, undefined].map(row);
  const c = create(rows, known('target'));
  assert.deepEqual(rows.map(r => c.row(r).category), ['other', 'companion', 'global', 'other', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown']);
  assert.equal(c.turn(rows).count, 10);
});
test('多个其他会话仍是混合，不能由首行或来源分类替代', () => {
  const rows = ['z-secret', 'a-secret', 'z-secret'].map(row), c = create(rows, known('absent-secret'));
  const result = c.turn(rows);
  assert.equal(result.mixed, true);
  assert.deepEqual(result.groups.map(g => [g.label, g.count]), [['其他会话 1', 1], ['其他会话 2', 2]]);
  assert.match(result.label, /多个记账归属，不代表同一会话执行/);
});
test('陪伴/其他/global/未知整轮逐行聚合、计数守恒', () => {
  const rows = ['b-secret', 'a-secret', 'global', null, 'b-secret'].map(row), c = create(rows, known('b-secret'));
  const result = c.turn({ rows });
  assert.equal(result.count, 5);
  assert.deepEqual(result.groups.map(g => [g.category, g.count]), [['global', 1], ['unknown', 1], ['other', 1], ['companion', 2]]);
  assert.equal(result.groups.reduce((n, g) => n + g.count, 0), 5);
});
test('R1 单一已知会话加未知保留计数，不声称多个归属', () => {
  const rows = [row('a-secret'), row(null)], c = create(rows, known('a-secret'));
  assert.deepEqual(c.turn(rows), { count: 2, mixed: false, unknownCount: 1,
    groups: [ { category: 'unknown', number: null, label: '归属未知', count: 1 }, { category: 'companion', number: 1, label: '陪伴会话', count: 1 } ],
    label: '归属（含未知归属）：归属未知 1 行 / 陪伴会话 1 行' });
});
test('R1 单一其他/精确global加未知也不能证明多个，未知行不能丢', () => {
  for (const [id, label] of [ ['a-secret', '归属（含未知归属）：归属未知 2 行 / 其他会话 1 1 行'], ['global', '归属（含未知归属）：全局记录 1 行 / 归属未知 2 行'] ]) {
    const rows = [row(id), row(null), row(' ')], c = create(rows, known('absent'));
    assert.deepEqual({ label: c.turn(rows).label, mixed: c.turn(rows).mixed, unknownCount: c.turn(rows).unknownCount, count: c.turn(rows).count }, { label, mixed: false, unknownCount: 2, count: 3 });
    assert.equal(c.turn(rows).groups.reduce((n, group) => n + group.count, 0), 3);
  }
});
test('R1 多个已知加未知同时说明确认混合与未知，global计为已知', () => {
  const rows = ['a-secret', 'global', null, 'a-secret'].map(row), c = create(rows, known('a-secret'));
  assert.deepEqual({ label: c.turn(rows).label, mixed: c.turn(rows).mixed, unknownCount: c.turn(rows).unknownCount, count: c.turn(rows).count }, {
    label: '混合归属（含未知归属）：全局记录 1 行 / 归属未知 1 行 / 陪伴会话 2 行（多个记账归属，不代表同一会话执行）', mixed: true, unknownCount: 1, count: 4 });
  assert.deepEqual(c.turn(rows).groups.map(g => g.count), [1, 1, 2]);
});
test('R1 仅未知/零行不虚构多个归属，未知数量明确', () => {
  const rows = [row(null), row(''), row(' \t'), row(7)], c = create(rows, known('a-secret'));
  assert.deepEqual(c.turn(rows), { count: 4, mixed: false, unknownCount: 4,
    groups: [ { category: 'unknown', number: null, label: '归属未知', count: 4 } ], label: '归属（含未知归属）：归属未知 4 行' });
  assert.deepEqual(c.turn([]), { count: 0, mixed: false, unknownCount: 0, groups: [], label: '归属：无审计行' });
});
test('R1 未核对陪伴仍按不同有效原键识别混合，未知不算额外键', () => {
  const rows = ['a-secret', 'z-secret', null].map(row), c = create(rows, { state: 'unchecked' });
  assert.deepEqual({ label: c.turn(rows).label, mixed: c.turn(rows).mixed, unknownCount: c.turn(rows).unknownCount }, {
    label: '混合归属（含未知归属）：归属未知 1 行 / 会话 1 · 陪伴未核对 1 行 / 会话 2 · 陪伴未核对 1 行（多个记账归属，不代表同一会话执行）', mixed: true, unknownCount: 1 });
  assert.deepEqual({ label: c.turn([rows[0], rows[2]]).label, mixed: c.turn([rows[0], rows[2]]).mixed, unknownCount: c.turn([rows[0], rows[2]]).unknownCount }, {
    label: '归属（含未知归属）：归属未知 1 行 / 会话 1 · 陪伴未核对 1 行', mixed: false, unknownCount: 1 });
});
test('完整窗口编号对乱序/倒序稳定，子集/两页复用窗口编号', () => {
  const rows = ['z-secret', 'a-secret', 'b-secret', 'a-secret', 'global'].map(row);
  const a = create(rows, known('b-secret')), b = create(rows.slice().reverse(), known('b-secret'));
  const c = create([rows[3], rows[0], rows[4], rows[2], rows[1]], known('b-secret'));
  for (const r of rows) { assert.deepEqual(a.row(r), b.row(r)); assert.deepEqual(a.row(r), c.row(r)); }
  assert.equal(a.turn([rows[0]]).groups[0].number, 3);
});
test('待核对/缺失/失败/超时不冒充其他或全局，更新只影响标签', () => {
  const rows = ['a-secret', 'global', null].map(row), c = create(rows, { state: 'checking' });
  assert.equal(c.row(rows[0]).label, '会话 1 · 陪伴未核对');
  c.update({ state: 'unchecked' });
  assert.equal(c.row(rows[0]).category, 'session');
  assert.equal(c.row(rows[1]).label, '全局记录');
  c.update(known('a-secret'));
  assert.equal(c.row(rows[0]).label, '陪伴会话');
  assert.equal(rows[0].sessionId, 'a-secret');
});
test('渲染投影完整序列化不含原值/片段/内部标识，函数不修改输入', () => {
  const ids = ['private-unique-alpha', 'session-12abcdef', '12345678-1234-1234-1234-123456789abc', 'C:\\private\\value'];
  const rows = ids.map(id => Object.freeze(row(id))), c = create(Object.freeze(rows), known(ids[0]));
  const output = JSON.stringify({ rows: rows.map(r => c.row(r)), turn: c.turn(rows) });
  for (const id of [...ids, 'unique-alpha', '12abcdef', '123456789abc', 'private']) assert.equal(output.includes(id), false);
});
