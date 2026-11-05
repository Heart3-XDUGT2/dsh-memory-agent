import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectReminder, extractReminderTask, REMINDER_CMD_RE } from '../lib/reminder.js'
import { stampOf } from '../lib/reflect.js'

test('命令式提醒:认出命令并抠出任务短语', () => {
  // A 侧 main.py:149 的原始用例:「echo,提醒我两分钟后去洗澡」→「洗澡」
  assert.deepEqual(detectReminder('echo,提醒我两分钟后去洗澡'),
    { task: '洗澡', raw: 'echo,提醒我两分钟后去洗澡' })
  assert.equal(detectReminder('提醒我十分钟后吃药').task, '吃药')
  assert.equal(detectReminder('提醒我8点吃药').task, '吃药')
  // 剥命令动词表里连「给」一起剥掉 —— A 侧原样照抄(给妈打电话 → 妈打电话)
  assert.equal(detectReminder('别忘了半小时后提醒我给妈打电话').task, '妈打电话')
})

test('A 侧时间短语表的两个盲区:抠不出就整句兜底,不是漏掉', () => {
  // ① 钟点只认阿拉伯数字(「八点」不认);② 「到点」不是时间短语。
  // 两处都是 A 侧原样:**任务抠不出 → 整句当内容**,到期时间仍由引擎侧
  // 解析器算(python 认得「明晚八点」);「到点喊我」则压根算不出时间,
  // requireTime 会把它丢掉 —— 永不响的约定比没有更糟。
  assert.equal(detectReminder('记得叫我明晚八点收衣服').task, '记得叫我明晚八点收衣服')
  assert.equal(detectReminder('到点喊我去跑步').task, '到点喊我去跑步')
  assert.equal(extractReminderTask('提醒我'), '') // 空 → 调用方兜底
})

test('不是命令的话一律不碰(触发层不许广撒网)', () => {
  for (const s of [
    '今天天气不错', '我在想晚饭吃什么', '帮我看看这个 bug',
    '校园跑还差十公里', '', '   '
  ]) {
    assert.equal(detectReminder(s), null, '不该命中: ' + JSON.stringify(s))
  }
})

test('正则就是 A 侧那一条(触发面不许悄悄扩大)', () => {
  assert.equal(REMINDER_CMD_RE.source,
    '(?:提醒|记得|记着|别忘了|别忘记).{0,8}我|到点.{0,4}(?:喊|叫|催)')
  // 识别是宽进:真假由引擎侧的时间换算与内容去重兜底,这里不重复把关。
  assert.equal(extractReminderTask('echoo,提醒我五分钟后关火'), '关火')
})

test('F2 时间锚:stampOf 出「YYYY-MM-DD HH:MM:SS 周X」', () => {
  // 本地时间构造 → 断言与时区无关;相对时间换算全靠这个锚点。
  assert.equal(stampOf(new Date(2026, 8, 24, 22, 13, 20).getTime()),
    '2026-09-24 22:13:20 周四')
  assert.match(stampOf(Date.now()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 周[日一二三四五六]$/)
})
