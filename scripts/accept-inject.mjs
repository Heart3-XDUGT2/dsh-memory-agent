/**
 * v0.32.0 A1a 真机探针(**只读**):`node scripts/accept-inject.mjs [--port 3080] [--base URL] [--json]`
 *
 * 量什么 —— 注入位置工程开工前必须先有的基线:
 *   ① `compat`:`section/context/variable` 三个挂点这台宿主有没有(尤其 `context`,
 *      A1 要用的就是它);
 *   ② `inject`:她这次注入的块在**数过的语料**里出现几份(`scopes` 说清份数管到哪),
 *      `duplicated=true` 就是当年那场 62 条重复块事故的味道。
 *
 * 纪律:只 GET 一个状态面,不写库、不改配置、不建表。数字不对就说不对(exit 1)。
 */
const argv = process.argv.slice(2)
const flag = (name, def = '') => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] !== undefined ? String(argv[i + 1]) : (argv.find((a) => a.startsWith(name + '='))?.slice(name.length + 1) ?? def)
}
const asJson = argv.includes('--json')
const base = (() => {
  const b = flag('--base', '')
  if (b !== '') return /^https?:\/\//i.test(b) ? b : 'http://' + b
  return 'http://127.0.0.1:' + (flag('--port', '3080') || '3080')
})()

const lines = []
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: ok === true, detail: String(detail) })
  lines.push((ok === true ? '  ok   ' : '  FAIL ') + name + (detail === '' ? '' : ' —— ' + detail))
  return ok === true
}

let st = null
let err = ''
try {
  const res = await fetch(base + '/api/echo/status', { signal: AbortSignal.timeout(4000) })
  st = await res.json()
} catch (e) { err = String(e?.message ?? e) }

if (st === null) {
  check('状态面可达 ' + base + '/api/echo/status', false, err)
} else {
  check('状态面可达', true)
  const c = st.compat
  check('compat 在位(A0 兼容闸已加载)', c !== null && typeof c === 'object',
    c === undefined ? '字段不在 ⇒ 新代码还没被宿主加载(要重启 dsh web)' : '')
  if (c !== null && typeof c === 'object') {
    check('systemPrompt.section 可用(人格/记忆注入的地基)', c.section === true)
    // 这条**允许是 false**:没有就等于"这台宿主不支持尾部注入",A1 自动退回旧做法,不是故障。
    lines.push('  info inject 位置工程需要的 systemPrompt.context = ' + String(c.context === true)
      + (c.context === true ? '(A1 可以搬)' : '(这台宿主没有 ⇒ A1 退回旧做法)'))
    lines.push('  info 人格变量化需要的 systemPrompt.variable = ' + String(c.variable === true))
    if (String(c.note ?? '') !== '') lines.push('  info note: ' + c.note)
  }
  const p = st.inject
  check('inject 探针在位(A1a 已加载)', p !== null && typeof p === 'object',
    p === undefined ? '字段不在 ⇒ 新代码还没被宿主加载(要重启 dsh web)' : '')
  if (p !== null && typeof p === 'object') {
    // v0.40.0:「还没组装过」与「注入没进去」分开报 —— 两种情况要做的动作完全不同,
    // 一句含糊的 FAIL 会把人指到错的方向(2026-09-28 夜真机就是这么被误报的)。
    if (Number(p.readings) === 0) {
      lines.push('  info 探针已加载,但**还没有读数** —— ' + String(p.note ?? ''))
      lines.push('       这不是故障:去陪伴会话里跟她说一句,下一次组装就有数了')
    } else {
      check('数到过一次注入(她在会话里说过话之后才有)', Number(p.occurrences) >= 1,
        Number(p.occurrences) === 0 ? '0 份 —— 组装过,但注入块一份都没进去(这才是真问题)' : '')
    }
    check('没有重复(**A1b 的红线**)', p.duplicated !== true,
      p.duplicated === true ? '出现 ' + p.occurrences + ' 份 —— 这就是 2026-09-26 那场事故的味道' : '')
    lines.push('  ── 本次注入:标记「' + String(p.marker ?? '') + '」 '
      + Number(p.occurrences) + ' 份 / ' + Number(p.chars) + ' 字'
      + ' · 语料=' + (Array.isArray(p.scopes) && p.scopes.length > 0 ? p.scopes.join('+') : '(还没数到)'))
    lines.push('  ── 逐语料:' + JSON.stringify(p.per ?? {}))
    lines.push('  ── 提醒:份数只对上面列出的语料成立(整段派生历史的份数要另一件仪器 —— 见计划 §12)')
  }
}

const failed = results.filter((r) => !r.ok)
if (asJson) {
  console.log(JSON.stringify({ base, results, compat: st?.compat ?? null, inject: st?.inject ?? null }, null, 2))
} else {
  console.log('# 注入位置工程探针 · ' + base + '(只读)')
  for (const l of lines) console.log(l)
  console.log(failed.length === 0 ? '结论:基线正常 —— 可以按 A1b 搬(记得留开关)。' : '结论:' + failed.length + ' 条没通过。')
}
process.exitCode = failed.length === 0 ? 0 : 1
