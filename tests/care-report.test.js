/**
 * A5「她为什么没开口」报告层(M0)的离线电池:纯逻辑,不碰库、不碰宿主。
 * 口径来自 docs/DISCIPLINE.md —— reason 只许枚举、可 GROUP BY,
 * 而报告必须**不许装懂**:没读数的行不带数字,一拍都没有就说一拍都没有。
 * （渲染形状用内存库真跑过一遍才交付,见最终回复里的实输出。）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseSince, summarizeBeats, renderBeats, describeReason, DEFAULT_SINCE_SEC, UNKNOWN_REASON_TEXT } from '../lib/care-report.js'

/** 本地钟面(不写死时区名,免得换个机器这份测试就红)。 */
const at = (y, m, d, h = 0, mi = 0, s = 0) => new Date(y, m - 1, d, h, mi, s).getTime() / 1000
const NOW = at(2026, 9, 29, 20, 11, 0)

const beat = (o = {}) => ({
  id: 0, at: NOW - 60, kind: 'care', reason: 'sent', value: 0, threshold: 0,
  should_act: 0, acted: 0, session_id: '', trace_id: '', payload_json: '', ...o
})

// ── parseSince ────────────────────────────────────────────────────

test('parseSince:认 24h / 7d / 90m / 30s', () => {
  assert.equal(parseSince('24h', NOW).since, NOW - 86400)
  assert.equal(parseSince('7d', NOW).since, NOW - 7 * 86400)
  assert.equal(parseSince('90m', NOW).since, NOW - 5400)
  assert.equal(parseSince('30s', NOW).since, NOW - 30)
  // 大写、空格、小数都不该被拒 —— 他为这点小事重敲一遍不值
  assert.equal(parseSince('24 H', NOW).since, NOW - 86400)
  assert.equal(parseSince('1.5h', NOW).since, NOW - 5400)
  assert.equal(parseSince('24h', NOW).fallback, false)
})

test('parseSince:ISO 串与纯数字(epoch 秒)', () => {
  assert.equal(parseSince('2026-09-28T20:11:00Z', NOW).since, Date.parse('2026-09-28T20:11:00Z') / 1000)
  assert.equal(parseSince('2026-09-28T20:11:00Z', NOW).fallback, false)
  assert.equal(parseSince('1759000000', NOW).since, 1759000000)
  assert.equal(parseSince('1759000000', NOW).fallback, false)
})

test('parseSince:空或认不出 ⇒ 回落默认 86400 秒前,并如实说明(不抛)', () => {
  for (const bad of ['', '   ', undefined, null, '昨天', 'abc', '24y', '-1h', {}, []]) {
    const got = parseSince(bad, NOW)
    assert.equal(got.since, NOW - DEFAULT_SINCE_SEC, '「' + String(bad) + '」该回落到默认窗口')
    assert.equal(got.fallback, true, '回落必须显式标出来,不许假装是他要的窗口')
    assert.ok(got.why.length > 0, '回落要带一句为什么')
  }
})

// ── summarizeBeats ────────────────────────────────────────────────

test('summarizeBeats:空数组 ⇒ total 0 / byReason [] / 时间 null', () => {
  assert.deepEqual(summarizeBeats([]), { total: 0, byReason: [], firstAt: null, lastAt: null, acted: 0 })
  assert.equal(summarizeBeats(undefined).total, 0, '非数组也别炸')
})

test('summarizeBeats:排序 count 降序,同 count 按 reason 字典序', () => {
  const rows = [
    beat({ reason: 'night-hold', at: NOW - 300 }),
    beat({ reason: 'engine-says-no', at: NOW - 240 }),
    beat({ reason: 'quiet', at: NOW - 180 }),
    beat({ reason: 'night-hold', at: NOW - 120 }),
    beat({ reason: 'engine-says-no', at: NOW - 60 }),
    beat({ reason: 'engine-says-no', at: NOW - 30, acted: 1 })
  ]
  const s = summarizeBeats(rows)
  assert.equal(s.total, 6)
  assert.deepEqual(s.byReason.map((g) => g.reason), ['engine-says-no', 'night-hold', 'quiet'])
  assert.deepEqual(s.byReason.map((g) => g.count), [3, 2, 1])
  assert.equal(s.byReason[0].acted, 1, 'acted 只数 acted=1 的条数(3 条里 1 条开口)')
  assert.equal(s.byReason[1].acted, 0)
  assert.equal(s.acted, 1, '总计开口 1 次')
  assert.equal(s.firstAt, NOW - 300)
  assert.equal(s.lastAt, NOW - 30)
})

test('summarizeBeats:同 count 的字典序是钉子(否则报告每次跑都换顺序)', () => {
  const s = summarizeBeats([
    beat({ reason: 'sent' }), beat({ reason: 'idle' }),
    beat({ reason: 'wake-busy' }), beat({ reason: 'daily-cap' })
  ])
  assert.deepEqual(s.byReason.map((g) => g.reason), ['daily-cap', 'idle', 'sent', 'wake-busy'])
})

test('summarizeBeats:firstAt/lastAt 是每组的首末拍,不是数组首末', () => {
  const s = summarizeBeats([
    beat({ reason: 'sent', at: NOW - 10 }),
    beat({ reason: 'sent', at: NOW - 900 }),
    beat({ reason: 'night-hold', at: NOW - 500 })
  ])
  const sent = s.byReason.find((g) => g.reason === 'sent')
  assert.equal(sent.firstAt, NOW - 900)
  assert.equal(sent.lastAt, NOW - 10)
})

// ── describeReason ────────────────────────────────────────────────

test('describeReason:上面那批枚举每条都有话(口径照 docs)', () => {
  assert.equal(describeReason('sent'), '她开口了')
  assert.equal(describeReason('engine-says-no'), '想念没过阈值')
  assert.equal(describeReason('night-hold'), '夜闸压住(23~8点)')
  assert.equal(describeReason('daily-cap'), '当天已开过 3 次口')
  assert.equal(describeReason('pending-ack'), '上一句还没送到他手机')
  // 2026-09-29:判词换了 —— 旧的 session-mismatch(锚会话 ≠ tick 到的会话)
  // 已退役,新的是 no-target(她那条会话拿不到)。文案不许悄悄消失:
  // 老库里的拍还得有名字。
  assert.ok(describeReason('session-mismatch').includes('已退役'))
  assert.ok(describeReason('no-target').includes('没拿到'))
  assert.equal(describeReason('working'), '他正在干活(有工具在跑),这一拍不插话',
    'working 判词退役了(2026-09-29 删闸),老账仍要有名字')
  assert.equal(describeReason('deliver-busy'), '她正忙,下轮再试')
  assert.equal(describeReason('reminder-sent'), describeReason('reminder-busy'))
  assert.ok(describeReason('wake-sent').includes('闹钟'))
  assert.ok(describeReason('wake-night-hold').includes('夜里'))
  assert.ok(describeReason('wake-busy').includes('忙'))
  assert.equal(describeReason('quiet'), describeReason('idle'))
  assert.ok(describeReason('quiet').includes('安静'))
  assert.equal(describeReason('backoff'), describeReason('quiet'), 'backoff 和 quiet 同科:没有否定,只是这一拍先不问')
})

test('describeReason:未知理由明说未知 —— 不抛、不静默返回空', () => {
  for (const bad of ['brand-new-reason', '', undefined, null, 'sent ']) {
    let got = ''
    assert.doesNotThrow(() => { got = describeReason(bad) })
    if (bad === 'sent ') assert.equal(got, '她开口了', '首尾空白不该把已知理由变成未知')
    else assert.equal(got, UNKNOWN_REASON_TEXT)
  }
  assert.ok(UNKNOWN_REASON_TEXT.includes('未知'), '未知理由必须自称未知')
})

// ── renderBeats ───────────────────────────────────────────────────

test('renderBeats:总拍数 / 开口 / 压住分布 / 最近几拍 / 结论都在', () => {
  const rows = [
    beat({ reason: 'engine-says-no', at: NOW - 4000, value: 3.4, threshold: 5.2 }),
    beat({ reason: 'engine-says-no', at: NOW - 3000, value: 4.1, threshold: 5.2 }),
    beat({ reason: 'night-hold', at: NOW - 2000, value: 6.1, threshold: 5.2 }),
    beat({ reason: 'daily-cap', at: NOW - 1500 }),
    beat({ reason: 'sent', at: NOW - 900, value: 6.3, threshold: 5.2, acted: 1 }),
    beat({ reason: 'quiet', at: NOW - 600, value: 4.1, threshold: 5.2 }),
    beat({ reason: 'quiet', at: NOW - 60, acted: 0 })
  ]
  const out = renderBeats({ rows, since: NOW - 86400, now: NOW })
  assert.ok(out.includes('Echo 关心账'), '要有抬头')
  assert.ok(out.includes('合计 7 拍'), '要有总拍数')
  assert.ok(out.includes('开口 1 次'), '要数出真开口的次数')
  assert.ok(out.includes('其余 4 拍没开口'), '没开口 = 总 − 开口 − 安静通过(7 − 1 − 2 = 4);措辞是"没开口"不是"被压住"(后者是夸大)')
  // 每个理由的人话都要出现(报告不许只给枚举就完事)
  assert.ok(/engine-says-no\s+×2\s+想念没过阈值/.test(out), '每个理由都要带人话')
  assert.ok(/night-hold\s+×1\s+夜闸压住\(23~8点\)/.test(out))
  assert.ok(/daily-cap\s+×1\s+当天已开过 3 次口/.test(out))
  // 有读数的行带上数字,没读数的行不许编 0/0
  assert.ok(out.includes('想念 4.1/5.2'), '有读数就带上')
  assert.ok(!out.includes('0/0'), '没读数就不许写 0/0 假装有读数')
  assert.ok(out.includes('最近 5 拍'), '最近几拍要有')
  assert.ok(out.includes('结论:'), '要有结论行')
  assert.ok(out.includes('她开口过 1 次'), '有开口 —— 但结论也不许吹成「一切正常」')
})

test('renderBeats:total=0 ⇒ 必须说「一拍都没有」,绝不许写「一切正常」', () => {
  const out = renderBeats({ rows: [], since: NOW - 3600, now: NOW })
  assert.ok(out.includes('一拍都没有'), '零拍是心跳没跑,必须点名')
  assert.ok(out.includes('心跳没跑'))
  assert.ok(!out.includes('一切正常'), '零拍写成「一切正常」就是骗人')
  assert.ok(out.includes('合计 0 拍'))
})

test('renderBeats:一次都没开口时,结论要指向「每拍都被压住」', () => {
  const out = renderBeats({
    rows: [beat({ reason: 'engine-says-no', at: NOW - 120 }), beat({ reason: 'night-hold', at: NOW - 60 })],
    since: NOW - 3600, now: NOW
  })
  assert.ok(out.includes('没开口'))
  assert.ok(out.includes('一次都没开口'))
  assert.ok(out.includes('共 2 拍'))
  assert.ok(out.includes('engine-says-no'), '卡点要逐条列出来')
})

test('renderBeats:全通过(只有 quiet)不报成"没开口"', () => {
  const out = renderBeats({ rows: [beat({ reason: 'quiet', at: NOW - 120 }), beat({ reason: 'idle', at: NOW - 60 })], since: NOW - 3600, now: NOW })
  assert.ok(out.includes('合计 2 拍'))
  assert.ok(!out.includes('拍没开口'), '静默通过不是"没开口"(全通过才静默)')
  assert.ok(out.includes('安静通过'))
  assert.ok(!out.includes('没开口的原因'))
  assert.ok(out.includes('安静'), '安静要通过 describeReason 说出来')
})

test('renderBeats:只出现过一次的时刻不许打印两遍(第一版印出「(13:02、13:02)」)', () => {
  const out = renderBeats({ rows: [beat({ reason: 'sent', at: NOW - 900, acted: 1 })], since: NOW - 86400, now: NOW })
  assert.ok(!/\(\d\d-\d\d \d\d:\d\d、\d\d-\d\d \d\d:\d\d\)/.test(out), '同一个时刻不该出现两次')
  assert.ok(/sent\s+×1\(\d\d-\d\d \d\d:\d\d\)/.test(out), '单次只印一个时刻')
})

test('枚举闭环:心跳写进账的每个 reason 都要有「人话」,不许落到"未知理由"', () => {
  // 心跳的 logBeat 调用点就是枚举的真相源 —— 从源码里把 reason(**第二个位置参数**)
  // 抠出来,逐个要求 describeReason 认识它(新加枚举忘了更新文案表 = 报告上印"未知")。
  //
  // ★ 2026-09-30 P2 修正:原实现是 `logBeat\(([^)]*)\)` 扫**整段实参**里的所有
  //   `'[a-z-]+'`,P2 给 logBeat 加了 `rejectedBy:'review'` 这种**不是 reason** 的
  //   短词,于是"review"被当成了 reason(`reason「review」还没进文案表`,假红)。
  //   现在只取第二个位置参数,再过滤掉 kind('care'/'wake'/'remind'/'quiet')。
  const src = readFileSync(new URL('../lib/heartbeat.js', import.meta.url), 'utf8')
  const kinds = new Set(['care', 'wake', 'remind', 'quiet'])
  /** 从 `logBeat(` 起扫到**配平**的右括号,按顶层逗号切参数(字符串/括号都不算分隔)。 */
  function argsOf (text, from) {
    const start = text.indexOf('(', from)
    if (start < 0) return null
    let depth = 0
    let quote = ''
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (quote !== '') {
        if (ch === '\\') { i++; continue }
        if (ch === quote) quote = ''
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
      if (ch === '(' || ch === '[' || ch === '{') depth++
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--
        if (depth === 0) return { body: text.slice(start + 1, i), end: i }
      }
    }
    return null
  }
  function splitTop (body) {
    const out = []
    let depth = 0
    let quote = ''
    let cur = ''
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (quote !== '') {
        cur += ch
        if (ch === '\\') { cur += body[i + 1] ?? ''; i++; continue }
        if (ch === quote) quote = ''
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue }
      if (ch === '(' || ch === '[' || ch === '{') depth++
      if (ch === ')' || ch === ']' || ch === '}') depth--
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
      cur += ch
    }
    out.push(cur)
    return out
  }
  const found = new Set()
  for (let i = src.indexOf('logBeat('); i >= 0; i = src.indexOf('logBeat(', i + 1)) {
    const call = argsOf(src, i)
    if (call === null) continue
    i = call.end
    const second = splitTop(call.body)[1] ?? ''
    for (const q of second.matchAll(/'([a-z][a-z-]+)'/g)) {
      if (!kinds.has(q[1])) found.add(q[1])
    }
  }
  found.add('tick-error') // 抛错那条走的是 logBeat('care','tick-error',...):抠得出,这里显式再钉一次
  assert.ok(found.size >= 8, '抠出来的 reason 太少 ⇒ 正则失效了,别让这条测试变成空转')
  for (const reason of found) {
    assert.notEqual(describeReason(reason), UNKNOWN_REASON_TEXT, 'reason「' + reason + '」还没进 care-report 的文案表')
  }
})

test('renderBeats:毫秒时间戳会被纠正(他手敲的常是 Date.now())', () => {
  const out = renderBeats({ rows: [], since: (NOW - 86400) * 1000, now: NOW * 1000 })
  // 毫秒被当成秒的话窗口会是天文数字(≈5.7e8 天),所以这一行是钉子
  assert.ok(out.includes('最近 1 天'), '毫秒必须被当成毫秒,不然窗口会算成天文数字')
})
