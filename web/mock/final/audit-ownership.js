// 记账归属独立于来源、折轮和执行位置。原始会话键只在闭包内使用。
(function () {
  'use strict';
  const valid = value => typeof value === 'string' && value.trim() !== '';
  function create(rows, initial = { state: 'unchecked' }) {
    const numbers = new Map([...new Set(rows.map(row => row?.sessionId).filter(id => valid(id) && id !== 'global'))]
      .sort().map((id, index) => [id, index + 1]));
    let metadata = initial;
    function row(input) {
      const id = input?.sessionId;
      if (!valid(id)) return { category: 'unknown', number: null, label: '归属未知' };
      if (id === 'global') return { category: 'global', number: null, label: '全局记录' };
      const number = numbers.get(id);
      if (!number) return { category: 'unknown', number: null, label: '归属未知' };
      if (metadata.state === 'known' && valid(metadata.session)) {
        if (id === metadata.session) return { category: 'companion', number, label: '陪伴会话' };
        return { category: 'other', number, label: `其他会话 ${number}` };
      }
      return { category: 'session', number, label: `会话 ${number} · 陪伴未核对` };
    }
    function turn(input) {
      const items = Array.isArray(input) ? input : input?.rows || [];
      const groups = new Map();
      for (const item of items) {
        const projection = row(item), key = `${projection.category}:${projection.number}`;
        if (!groups.has(key)) groups.set(key, { ...projection, count: 0 });
        groups.get(key).count += 1;
      }
      const parts = [...groups.values()].sort((a, b) => (a.number || 0) - (b.number || 0) || a.category.localeCompare(b.category));
      // 未知行可能属于已知会话；只有不同已知记账键才能证明混合。
      const mixed = parts.filter(part => part.category !== 'unknown').length > 1;
      const unknownCount = parts.find(part => part.category === 'unknown')?.count || 0;
      const detail = parts.map(part => `${part.label} ${part.count} 行`).join(' / ');
      return { count: items.length, mixed, unknownCount, groups: parts,
        label: items.length === 0 ? '归属：无审计行' : `${mixed ? '混合归属' : '归属'}${unknownCount ? '（含未知归属）' : ''}：${detail}${mixed ? '（多个记账归属，不代表同一会话执行）' : ''}` };
    }
    return { row, turn, update: next => { metadata = next; }, state: () => metadata.state };
  }
  globalThis.EchoAuditOwnership = { create, valid };
})();
