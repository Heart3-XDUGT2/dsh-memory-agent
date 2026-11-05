/**
 * F2 的电池:日记缺的那几页要补上,连败要走退避。
 *
 * 两个洞各一组测试守着(都是"会留下永久痕迹"的那种):
 *   ① 22:30 那拍她没起 ⇒ 那一页**再也不会被写**(旧行为:第二天只写第二天的);
 *   ② 连败时旧行为**通宵每 60 秒试一次**且一声不吭 ⇒ 现在退避 + 留账。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  missingDiaryDates, diaryRetryMs, planDiaryTick, midnightOfKey,
  DIARY_BACKFILL_MAX_DAYS, DIARY_RETRY_BASE_MS, DIARY_RETRY_MAX_MS, todayKey
} from '../lib/diary.js'

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0).getTime()

test('F2:昨天那一页没写 ⇒ 今天要补上它(旧行为:漏了就永远漏了)', () => {
  const now = at(2026, 9, 28, 23, 10)          // 今天 23:10,过了 22:30
  const dates = missingDiaryDates({ nowMs: now, lastDateKey: '2026-09-26' })
  assert.deepEqual(dates, ['2026-09-27', '2026-09-28'], '从最早那天起,含今天')
})

test('F2:今天还没到 22:30 ⇒ 今天不写,但昨天缺的照样补', () => {
  const now = at(2026, 9, 28, 9, 0)
  assert.deepEqual(missingDiaryDates({ nowMs: now, lastDateKey: '2026-09-26' }), ['2026-09-27'])
})

test('F2:从没写过页 ⇒ 只补今天(不许追溯远古)', () => {
  const now = at(2026, 9, 28, 23, 30)
  assert.deepEqual(missingDiaryDates({ nowMs: now, lastDateKey: '' }), ['2026-09-28'])
  assert.deepEqual(missingDiaryDates({ nowMs: at(2026, 9, 28, 3, 0), lastDateKey: '' }), [], '半夜还没到点')
})

test('F2:缺成一片也一次只写一页(补 7 页 = 7 分钟,不是 7 次组稿一起打过去)', () => {
  const now = at(2026, 9, 30, 23, 0)
  const plan = planDiaryTick({ nowMs: now, lastDateKey: '2026-09-22' })
  assert.equal(plan.action, 'write')
  assert.equal(plan.dates.length, DIARY_BACKFILL_MAX_DAYS, '缺 8 天:这次补 7 页(封顶)')
  assert.equal(plan.dates[0], '2026-09-23', '最早那天在前')
  assert.match(plan.reason, /补 7 页/)
})

test('F2:最后一页就在今天 ⇒ 无事可做,不组稿', () => {
  const now = at(2026, 9, 28, 23, 0)
  assert.equal(planDiaryTick({ nowMs: now, lastDateKey: '2026-09-28' }).action, 'skip')
})

test('F2:连败退避 5min → 10 → 20 → 40 → 60 封顶', () => {
  assert.equal(diaryRetryMs(1), DIARY_RETRY_BASE_MS)
  assert.equal(diaryRetryMs(2), DIARY_RETRY_BASE_MS * 2)
  assert.equal(diaryRetryMs(3), DIARY_RETRY_BASE_MS * 4)
  assert.equal(diaryRetryMs(4), DIARY_RETRY_BASE_MS * 8)
  assert.equal(diaryRetryMs(5), DIARY_RETRY_MAX_MS, '封顶 1 小时')
  assert.equal(diaryRetryMs(99), DIARY_RETRY_MAX_MS)
  assert.equal(diaryRetryMs(0), DIARY_RETRY_BASE_MS, '0 当第一次算')
})

test('F2:退避窗口里 ⇒ 一拍都不试(旧行为是通宵每 60 秒一次)', () => {
  const now = at(2026, 9, 28, 23, 30)
  const plan = planDiaryTick({ nowMs: now, lastDateKey: '2026-09-27', failCount: 2, retryAtMs: now + 60000 })
  assert.equal(plan.action, 'backoff')
  assert.deepEqual(plan.dates, [])
  assert.equal(plan.waitMs, 60000)
  assert.match(plan.reason, /连败 2 次/)
  // 到点了就继续写(退避不是放弃)
  assert.equal(planDiaryTick({ nowMs: now + 60001, lastDateKey: '2026-09-27', failCount: 2, retryAtMs: now + 60000 }).action, 'write')
})

test('F2:补写那天的素材按**那天**取(midnightOfKey 是本地 0 点)', () => {
  const m = midnightOfKey('2026-09-27')
  assert.equal(m.getFullYear(), 2026)
  assert.equal(m.getMonth() + 1, 9)
  assert.equal(m.getDate(), 27)
  assert.equal(m.getHours(), 0)
  assert.equal(midnightOfKey('乱七八糟'), null)
  assert.equal(midnightOfKey(''), null)
})

test('F2:日期键是本地日期,不是 UTC(跨时区不许差一天)', () => {
  assert.equal(todayKey(at(2026, 9, 28, 23, 59)), '2026-09-28')
  assert.equal(todayKey(at(2026, 9, 28, 0, 1)), '2026-09-28')
})
