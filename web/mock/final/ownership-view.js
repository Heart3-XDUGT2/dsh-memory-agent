// 只替换中性归属文字；保留表、图、焦点及日记控件本身。
globalThis.EchoOwnershipView = (function () {
  'use strict';
  const bindings = new WeakMap();
  function label(api, input, single = false) {
    const node = api.el('span', 'audit-ownership');
    const context = api.ownership;
    const paint = () => { node.textContent = context ? (single ? context.row(input).label : context.turn(input).label) : '归属未核对'; };
    bindings.set(node, paint);
    paint();
    return node;
  }
  function update(root) {
    if (!root) return;
    for (const node of root.querySelectorAll('.audit-ownership')) bindings.get(node)?.();
  }
  const explanation = '按本次读取时的陪伴设置核对；编号仅本窗口有效。记账会话不证明代理执行位置。';
  function note(api, context) {
    const node = api.el('p', 'ownership-note audit-ownership');
    const paint = () => { node.textContent = explanation + (context?.state() === 'checking' ? ' 陪伴设置正在核对。' : context?.state() !== 'known' ? ' 陪伴未核对，可刷新重试。' : ''); };
    bindings.set(node, paint); paint();
    return node;
  }
  return { label, update, note };
})();
