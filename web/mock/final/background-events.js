// 一条后台审计的三个阅读模块。只投影该行事实，不推算执行时序或历史状态。
globalThis.EchoBackgroundEvents = (function () {
  'use strict';
  const MISSING = String.fromCharCode(0x2014);
  const NAMES = { diary: '日记', diary_fail: '日记组稿失败', reflection: '记忆整固', reflection_failed: '记忆整固失败', emotion_decay: '情绪衰减', 'session-reaper': '会话清理', 'ipc-appraise': '人际打分', extract: '记忆提取' };
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);

  function safe(value) {
    if (value === null || value === undefined) return MISSING;
    const text = String(value);
    try { const parsed = JSON.parse(text); if (parsed !== null && typeof parsed === 'object') return '（原始字段已隐藏）'; } catch { /* 普通正文 */ }
    return text.replace(/\{\s*"[\s\S]*$/u, '（原始字段已隐藏）')
      .replace(/[A-Za-z]:[\\/][^\n，。；<>|]*/gu, '（本机路径已隐藏）')
      .replace(/session-[A-Za-z0-9_-]+/gu, '（会话标识已隐藏）')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu, '（标识已隐藏）');
  }
  function dateValid(v) {
    if (typeof v !== 'string' || v.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/u.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    return y > 0 && d > 0 && d <= ([31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] || 0);
  }
  function detailOf(row) {
    const raw = row?.stageDetail;
    if (raw === null || raw === undefined || raw === '') return { state: 'missing', value: {} };
    if (object(raw)) return { state: 'valid', value: raw };
    try { const v = JSON.parse(raw); return object(v) ? { state: 'valid', value: v } : { state: 'invalid', value: {} }; }
    catch { return { state: 'invalid', value: {} }; }
  }
  function kindOf(row) {
    // 工具类型优先；不拿无关工具的 stage 冒充后台事件。
    const tool = typeof row?.toolCall === 'string' ? row.toolCall.trim() : '';
    if (tool !== '') return own(NAMES, tool) ? tool : '';
    const stage = typeof row?.stage === 'string' ? row.stage.trim() : '';
    return own(NAMES, stage) ? stage : '';
  }
  function text(v) {
    if (typeof v === 'boolean') return v ? '是' : '否';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : MISSING;
    return typeof v === 'string' && v.trim() !== '' ? safe(v) : MISSING;
  }
  function number(v) { return typeof v === 'number' && Number.isFinite(v) ? String(v) : MISSING; }
  function field(label, value, source) { return { label, value, source }; }
  function pairs(value, prefix = '') {
    if (!object(value)) return MISSING;
    const out = [];
    for (const [k, v] of Object.entries(value)) {
      const label = prefix ? `${prefix} / ${safe(k)}` : safe(k);
      if (typeof v === 'number' && Number.isFinite(v)) out.push(`${label}：${v}`);
      else if (object(v)) { const nested = pairs(v, label); if (nested !== MISSING) out.push(nested); }
    }
    return out.length ? out.join('\n') : MISSING;
  }
  function parsedObject(value) {
    if (object(value)) return value;
    try { const v = JSON.parse(value); return object(v) ? v : null; } catch { return null; }
  }
  function countFrom(reply, key, suffix = '') {
    const match = String(reply || '').match(new RegExp(`(?:^|\\s)${key}=(\\d+)${suffix}(?=\\s|$)`, 'u'));
    return match ? match[1] : MISSING;
  }
  function project(row, rowIndex = 0) {
    const kind = kindOf(row);
    if (!kind) return null;
    const detail = detailOf(row), d = detail.value;
    const input = typeof row.userInput === 'string' ? row.userInput : '';
    const reply = typeof row.llmReply === 'string' ? row.llmReply : '';
    const stamp = typeof row.timestamp === 'number' && Number.isFinite(row.timestamp) && row.timestamp > 0
      ? new Date(row.timestamp * 1000).toLocaleString('zh-CN', { hour12: false }) : MISSING;
    const trigger = [field('记录时刻', stamp, 'timestamp')];
    const process = [], output = [];
    let status = /_fail(?:ed)?$/u.test(kind) ? '失败' : '已记录';
    let diaryDate = null;
    const df = (label, key) => field(label, number(d[key]), `stageDetail.${key}`);
    if (kind === 'diary' || kind === 'diary_fail') {
      diaryDate = dateValid(d.diaryDate) ? d.diaryDate : null;
      trigger.push(field('日记日期', diaryDate || MISSING, 'stageDetail.diaryDate'));
      if (/^\(日记补写\) /u.test(input)) trigger.push(field('触发说明', '补写（该行明确标记）', 'userInput'));
      if (kind === 'diary_fail') {
        process.push(field('失败记录', text(input), 'userInput'));
        output.push(field('重试说明', text(reply), 'llmReply'));
      } else {
        process.push(field('审计摘要', text(reply), 'llmReply'), field('该行情绪强度', number(row.moodIntensity), 'moodIntensity'));
        output.push(field('日记关联', diaryDate ? '有明确日期，可读取日记正文' : '未关联日记，仅保留审计摘要', 'stageDetail.diaryDate'));
      }
      process.push(field('模型 / 素材 / 耗时', MISSING, '未保存'));
    } else if (kind === 'reflection' || kind === 'reflection_failed') {
      const match = input.match(/^\(记忆整固·(夜窗|过阈)\)$/u);
      trigger.push(field('触发标记', match ? match[1] : MISSING, 'userInput'), df('累计情感', 'importance'), df('候选条数', 'candidates'));
      process.push(df('整理条数', 'items'), field('模型输入', MISSING, '未保存'));
      if (kind === 'reflection_failed') process.push(field('失败原因', text(reply), 'llmReply'));
      output.push(df('写成', 'written'), df('合并', 'merged'), df('待跟进', 'agenda'), field('游标推进', text(d.cursorAdvanced), 'stageDetail.cursorAdvanced'), field('结果原因', text(d.reason), 'stageDetail.reason'));
    } else if (kind === 'emotion_decay') {
      trigger.push(df('间隔（小时）', 'hours'));
      process.push(field('处理', '按该次记录执行情绪衰减', 'toolCall'), field('历史参数', MISSING, '未保存'));
      output.push(field('本次变化', pairs(d.delta), 'stageDetail.delta'), field('该行保存的向量', pairs(parsedObject(row.emotionVector)), 'emotionVector'), field('衰减前向量', pairs(d.before), 'stageDetail.before'));
    } else if (kind === 'session-reaper') {
      trigger.push(field('触发原因', MISSING, '未保存'));
      process.push(field('轮数边界', countFrom(reply, 'turns'), 'llmReply.turns'), field('时间边界（毫秒）', countFrom(reply, 'boundary'), 'llmReply.boundary'));
      for (const [key, label] of [['reaped', '清理会话'], ['kept', '保留会话'], ['unknown', '无法确认'], ['freed', '释放（字节）']]) {
        output.push(field(label, countFrom(reply, key, key === 'freed' ? 'B' : ''), `llmReply.${key}`));
      }
    } else if (kind === 'ipc-appraise') {
      const match = input.match(/^\(人际打分·([^()]+)\)$/u);
      const tag = match ? match[1] : '';
      status = tag === '失败' ? '失败' : tag === '跳过' || tag === '门槛不足' ? '跳过' : tag === '已判定' ? '已判定' : '未判定';
      trigger.push(field('记录类型', text(tag), 'userInput.kind'));
      const gate = reply.match(/(?:^|\s)gate=([^\s]+)/u), gain = reply.match(/(?:^|\s)gain=(-?\d+(?:\.\d+)?)(?=\s|$)/u);
      // 已判定行的 other JSON 不是用户可读产出，只取明确的 gain/gate。
      process.push(field('记录原因', text(reply.replace(/other=\{[\s\S]*?\}(?=\s|$)/u, '')), 'llmReply'));
      output.push(field('判定状态', status, 'userInput.kind'), field('门控', gate ? safe(gate[1]) : MISSING, 'llmReply.gate'), field('增益', gain ? gain[1] : MISSING, 'llmReply.gain'));
    } else if (kind === 'extract') {
      trigger.push(field('当时素材', text(input), 'userInput'));
      process.push(df('原始三元组', 'triplesRaw'), df('格式拒绝', 'triplesSchemaRejected'), df('拒绝条数', 'triplesRejected'), field('图处理错误', text(d.graphError), 'stageDetail.graphError'));
      const reasons = Array.isArray(d.dropReasons) ? d.dropReasons.map(v => typeof v === 'string' ? safe(v) : object(v) ? text(v.reason) : MISSING).join('\n') : MISSING;
      output.push(df('写入三元组', 'triplesWritten'), df('学习条数', 'learned'), field('丢弃原因', reasons || MISSING, 'stageDetail.dropReasons'));
    }
    return { kind, title: NAMES[kind], rowIndex, status, detailState: detail.state, diaryDate,
      modules: [{ title: '触发', fields: trigger }, { title: '处理', fields: process }, { title: '产出', fields: output }],
      links: [{ label: '触发记录 → 处理记录', detail: '按同一条审计的触发信息阅读处理记录；不代表另一次执行。' }, { label: '处理记录 → 已保存产出', detail: '按同一条审计的处理信息阅读保存结果；没有推算交接时刻或耗时。' }] };
  }
  function ofTurn(turn, steps = []) {
    const rows = Array.isArray(turn?.rows) ? turn.rows : [];
    const pure = rows.length > 0 && rows.every(row => kindOf(row))
      && !rows.some(row => kindOf(row) === 'extract' && (Number(row.step) > 0 || String(row.stage || '').trim() !== ''));
    const events = rows.flatMap((row, i) => {
      if (!pure && !steps.some(s => s.rowIndex === i && s.outsider)) return [];
      const event = project(row, i);
      return event ? [event] : [];
    });
    return { pure, rowCount: rows.length, events };
  }
  return { safe, dateValid, detailOf, kindOf, project, ofTurn, missing: MISSING };
})();
