import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fingerprint, fingerprints, judgeSession, lastEventTime, lastSystemMessage, personaPosition, sessionDepth } from '../scripts/check-echo-persona.mjs'
import { SNAPSHOT_ORDER } from '../lib/turn-snapshot.js'

// 2026-09-26 现场:他问「她讲话的语气完全不符合我给的人物提示词」。
// 当时的真相:面板/审计/日志**全都显示正常**(人格字数 1813),而她实际跑的是
// 插件默认人格 —— 只有从真实请求体里读才能发现。这个自检就是那次的仪器化。
// 这几条用例钉的是判据本身:✓已生效 / ✓历史送达 / ⏳等下一轮 / ✗对不上。

const PERSONA = {
  prefix: '# 角色扮演提示词：Echo\n\n## 基本信息\n风又Echo，昵称小E。以幽灵形态出现的少女。',
  suffix: '【Echo 的两条铁律】(不能弄反):\n一、对恶意挑衅用嘲笑和毒舌回击。'
}
const SAVED = 1_790_400_000_000 // 人格保存时刻

const sysLine = (time, text) => JSON.stringify({
  type: 'system/message', seq: 9, time,
  data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text }] } }
})
const userLine = (time, text) => JSON.stringify({ type: 'user/message', seq: 10, time, data: { content: [{ type: 'text', text }] } })

test('指纹取无空白片段(会话流里换行是转义的 \\n,带空白的片段匹配不上)', () => {
  assert.equal(fingerprint(PERSONA.prefix), '角色扮演提示词：Echo')
  assert.equal(fingerprint(PERSONA.suffix), '的两条铁律】(不能弄反):')
  assert.equal(fingerprint('短'), '短')
  assert.equal(fingerprint(''), '')
})

test('✓ 已生效:最后一条 system/message 里两段都在', () => {
  const stream = [sysLine(SAVED + 1000, PERSONA.prefix + '\n\n' + PERSONA.suffix), userLine(SAVED + 2000, '在吗')].join('\n')
  assert.equal(judgeSession({ stream, persona: PERSONA, savedAt: SAVED }).verdict, 'ok')
})

test('✗ 对不上:保存**之后**组装过,而那一次的 system prompt 里是别人的人格', () => {
  const stream = [
    sysLine(SAVED + 55000, '你是 Echo。你调皮、毒舌,带着像 Neuro-sama 一样的玩心。'),
    userLine(SAVED + 60000, '聊天'),
    JSON.stringify({ type: 'assistant/message', seq: 11, time: SAVED + 61000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '行啊。' }] } } })
  ].join('\n')
  const r = judgeSession({ stream, persona: PERSONA, savedAt: SAVED })
  assert.equal(r.verdict, 'stale')
  assert.match(r.detail, /旧人格|默认人格/)
})

test('⏳ 等下一轮:最后一次组装早于人格保存 —— 不算错(哪怕她刚说过话)', () => {
  const stream = [
    sysLine(SAVED - 60000, '你是 Echo。你调皮、毒舌,带着像 Neuro-sama 一样的玩心。'),
    userLine(SAVED - 30000, '睡了吗')
  ].join('\n')
  assert.equal(judgeSession({ stream, persona: PERSONA, savedAt: SAVED }).verdict, 'pending')
})

test('✓ 已送达:宿主把更新放进历史(systemPromptUpdate: in-history)时不误报', () => {
  const stream = [
    sysLine(SAVED - 1000, '你是 Echo。你调皮、毒舌。'),
    JSON.stringify({ type: 'request/context', seq: 12, time: SAVED + 1000, data: { systemPromptUpdate: 'in-history' } }),
    JSON.stringify({
      type: 'user/message', seq: 13, time: SAVED + 1001,
      data: { content: [{ type: 'text', text: PERSONA.prefix + '\n\n' + PERSONA.suffix }] }
    }),
    userLine(SAVED + 60000, '在吗')
  ].join('\n')
  assert.equal(judgeSession({ stream, persona: PERSONA, savedAt: SAVED }).verdict, 'in-history')
})

test('改正文、留标题 ⇒ 不许假绿(2026-09-26 当场抓到的假 ✓)', () => {
  // 那天我改了「说话方式」的正文、没动「两条铁律」的标题,而旧版判据取的是
  // **第一个**无空白片段 —— 正好是没变的标题,于是它拿着旧请求体报「✓ 已生效」。
  const OLD = PERSONA.suffix
  const NEW = PERSONA.suffix.replace('一、对恶意挑衅用嘲笑和毒舌回击。', '一、对恶意挑衅用嘲笑和毒舌回击 —— 锋利只留给挑衅,对阿岚不用。')
  assert.notEqual(NEW, OLD)
  const persona2 = { prefix: PERSONA.prefix, suffix: NEW }

  // 保存之前组装的(旧正文):只算「还没轮到」
  const before = [sysLine(SAVED - 50000, PERSONA.prefix + '\n\n' + OLD), userLine(SAVED - 40000, '在吗')].join('\n')
  assert.equal(judgeSession({ stream: before, persona: persona2, savedAt: SAVED }).verdict, 'pending')

  // 保存之后组装过、却还是旧正文:必须 ✗(这才是要报警的那一种)
  const after = [sysLine(SAVED + 50000, PERSONA.prefix + '\n\n' + OLD), userLine(SAVED + 60000, '在吗')].join('\n')
  assert.equal(judgeSession({ stream: after, persona: persona2, savedAt: SAVED }).verdict, 'stale')

  // 而新正文真的到了,才算 ✓
  const ok = [sysLine(SAVED + 50000, PERSONA.prefix + '\n\n' + NEW), userLine(SAVED + 60000, '在吗')].join('\n')
  assert.equal(judgeSession({ stream: ok, persona: persona2, savedAt: SAVED }).verdict, 'ok')
})

test('多点指纹:首/中/尾三点,确定且能跨过「只改了一处」', () => {
  // 每行都得是 ≥12 字的无空白片段,否则会被 fingerprint 的过滤条件滤掉
  // (我第一版写了 11 字的行 → runs 为空、退化成整段,用例自己先红了)
  const seg = (i) => '第' + i + '段足够长的内容片段在这'
  const text = Array.from({ length: 9 }, (_, i) => seg(i + 1)).join('\n')
  const fps = fingerprints(text, 3)
  assert.equal(fps.length, 3)
  assert.ok(fps[0].startsWith('第1段'))
  assert.ok(fps[2].startsWith('第9段'))
  assert.ok(fps[1].startsWith('第5段'))
  assert.deepEqual(fingerprints(text, 3), fps, '取点必须确定,不许随机')
  // 只改中间那一段 → 中间那点必须变(这就是它能抓到「改了正文留了标题」的原因)
  const changed = text.replace(seg(5), '第五段换成完全不同的另一种说法')
  assert.notDeepEqual(fingerprints(changed, 3), fps)
})

test('位置:报出前段落在 system prompt 的百分之几处(B 有没有生效,靠这个数字)', () => {
  // 挪尾部前的真实版式:前段在 1.1% 处,后面隔着 8000 字工具说明
  const filler = 'x'.repeat(8000)
  const before = PERSONA.prefix + '\n\n' + filler + '\n\n' + PERSONA.suffix
  const p1 = personaPosition(before, PERSONA)
  assert.ok(p1.prePct < 2, '前段在 1% 量级,实得 ' + p1.prePct)
  assert.ok(p1.sufPct > 95, '后段在尾部,实得 ' + p1.sufPct)

  // 挪尾部后(B):两段挨着,前段紧跟后段之前
  const after = filler + '\n\n' + PERSONA.prefix + '\n\n' + PERSONA.suffix
  const p2 = personaPosition(after, PERSONA)
  assert.ok(p2.prePct > 95, '前段该在尾部,实得 ' + p2.prePct)
  assert.ok(p2.sufPct > p2.prePct, '后段该在前段之后')
})

test('辅助:lastSystemMessage / lastEventTime 取的是最后一条', () => {
  const stream = [sysLine(1000, 'A'), sysLine(2000, 'B'), userLine(3000, 'x')].join('\n')
  assert.equal(lastSystemMessage(stream).text, 'B')
  assert.equal(lastSystemMessage(stream).time, 2000)
  assert.equal(lastEventTime(stream), 3000)
  assert.equal(lastSystemMessage(userLine(1, 'x')).text, '', '没有 system/message 时返回空串')
})

// ── 组装顺序的源码纪律(2026-09-26 当晚)────────────────────────────────
// 这条不测运行结果,测**源码里的顺序** —— 因为顺序就是权重,而这个仓的段是散在
// lib/index.js 里注册的,没有别的机器可读的注册表。改了顺序必须有人红。
test('组装顺序:语域规格在记忆/心情快照之后,而且尾部**没有**自检段', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const orderOf = (name) => {
    const m = new RegExp("name: '" + name + "',[\\s\\S]{0,400}?order: (\\d+)").exec(src)
    return m ? Number(m[1]) : NaN
  }
  const rules = orderOf('echo:rules')
  assert.ok(Number.isFinite(rules), 'echo:rules 段要在')
  assert.ok(rules > SNAPSHOT_ORDER, '她的语域规格必须晚于记忆/心情快照(尾部才是锚点):rules=' + rules + ' snapshot=' + SNAPSHOT_ORDER)
  // 2026-09-26 当晚他拍的:撤掉尾部自检。它没解决问题(她 8 条真消息里「～」仍
  // 0%),却让她思考里的「像 Echo 吗/人格规则/防漂移自检」从 9%/4%/0% 升到 25%。
  // 谁要是"顺手补一个尾部提醒",这条就要红。
  // 判据用**注册名**而不是被删的原文 —— 上面那段注释里引用了原文,拿原文判会假红
  // (我第一版就是这么写的,当场被自己的用例抓出来)。
  assert.equal(orderOf('echo:voice'), NaN, 'echo:voice(尾部自检段)已被撤掉,不许回来')
  assert.ok(!src.includes("'echo.voice()'"), '尾部自检段的 ctx.effect 注册不许回来')
  assert.ok(!src.includes('systemPrompt.section({\n    name: \'echo:voice\''), '不许再注册这个段')
  // 顺序移动本身保留:语域规格仍在快照之后
  assert.ok(rules > 10260, 'rules 要在快照(10260)之后')
})

/**
 * v0.23.0:那 19 条 ✗ 的真身。
 *
 * `check:persona` 报过「19 个会话在她开口时没带人格」。查下去是**子代理会话**
 * —— 她跑 Judge/整固时 fork 出去的内部工,**按设计就不该带人格**。判据于是
 * 加了会话头那层:`delegationDepth > 0` 一律不判(但报数,免得"跳过"成了掩盖)。
 * 这条用例钉住解析本身:读头帧、坏头回 0。
 */
test('会话头解析:子代理会话(delegationDepth>0)认得出来,坏头当 0', () => {
  assert.equal(sessionDepth('{"type":"session","delegationDepth":1,"cwd":"x"}\n{}'), 1)
  assert.equal(sessionDepth('{"type":"session","delegationDepth":0}'), 0)
  assert.equal(sessionDepth('{"type":"session"}'), 0, '没有这个字段的老会话 = 顶层会话')
  assert.equal(sessionDepth('不是 JSON 的一行'), 0, '坏头不许抛 —— 抛了整场检查就没了')
  assert.equal(sessionDepth(''), 0)
  assert.equal(sessionDepth('{"delegationDepth":"2"}'), 2, '字符串数字也认(会话头是宿主写的)')
})
