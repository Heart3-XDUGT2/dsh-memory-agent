/**
 * P4a 电池:她的自由活动(`lib/her-activity.js` + 心跳里那一档 + 第四类候选)。
 *
 * 这一套钉四件事:
 *   ① **判据是纯函数**(表驱动:太近/够久/夜间/额度用完/今天已做过/busy);
 *   ② **默认关 = 零行为变化**(不注入 `getHerActivity` 时心跳一个字都不做 ——
 *      不落账、不调执行体、老路逐条不变);
 *   ③ **产出真的落盘**(临时目录,不碰真 workspace)+ 上限清理 + UTF-8 无 BOM;
 *   ④ **来源标记**(`note:` 前缀 + `source:'self-activity'`)且**不污染主记忆**:
 *      这一档只写文件与 `care_beats` 台账,`episodic_memory` 一行都不许多。
 *
 * 全是离线件:心跳的模型调用由假执行体顶替(这一档本身**不新增调用点**)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isolateTestHome, assertHomeIsolated } from './fixtures/test-home.js'

// 2026-09-30 测试隔离(与 `heartbeat.test.js` / `care-beats.test.js` 同一套):
// 先隔离 `DSH_HOME`,再**动态** import 库模块 —— `lib/toggle.js` 的 `CONFIG_PATH` 与
// `lib/persona.js` 的 `DATA_DIR` 都是模块级常量,首次 import 时按当时的 `DSH_HOME` 定死;
// 静态 `import` 会先于隔离那一行执行,用例就又会读**真机配置**。
//
// 现场(2026-09-30 P4b):真机 `herActivity.enabled` 按他的批准置了 `true`(③),于是
// 本文件里"**不注入** `getHerActivity` = 旧装机位 ⇒ 零行为变化"那条**真的做起了活动**
// (`ran=1`,实测) —— 那是判据漂了,不是产品坏了。与 `proactiveScoring` 那次同科:
// 「不注入 getter」的用例会回落到 `readSettings()`,所以它必须活在**已知**的配置上。
const TEST_HOME = isolateTestHome()
const { CONFIG_PATH, readSettings, SETTINGS_DEFAULTS, normalizeSettings } = await import('../lib/toggle.js')
assertHomeIsolated(CONFIG_PATH)
const {
  HER_ACTIVITY_OFF, ACTIVITY_REASONS, ACTIVITY_KEEP_DEFAULT,
  ACTIVITY_KINDS, ACTIVITY_FILE_PREFIXES, ACTIVITY_KIND_DEFAULT,
  planActivityTick, activityFileName, activityFileExists, activityKindOf, activityKindFromName,
  writeActivityFile, pruneActivityFiles, listActivityFiles, listActivityNotes,
  hasSnapshotData, composeTidyText
} = await import('../lib/her-activity.js')
const { createHeartbeat, PROACTIVE_SCORING_OFF } = await import('../lib/heartbeat.js')
const { collectCandidates, pickTop } = await import('../lib/topic-score.js')
const { openStore, MASTER_ID } = await import('../lib/store.js')
const { describeReason, UNKNOWN_REASON_TEXT } = await import('../lib/care-report.js')

// 固定钟面:2026-09-28 15:00(本地)—— "白天"的判定必须能拨,不能看真表。
const AT = (h = 15, m = 0) => new Date(2026, 8, 28, h, m, 0, 0).getTime()
const NOW_MS = AT()
const NOW_SEC = NOW_MS / 1000

/** 临时"工作目录"(绝不写真 workspace)。 */
function tempDir () {
  return mkdtempSync(join(tmpdir(), 'echo-activity-'))
}

const CFG_ON = (over = {}) => ({ ...HER_ACTIVITY_OFF, enabled: true, ...over })

// ---- ① 纯判据:表驱动 --------------------------------------------------------

test('planActivityTick:表驱动(太近/够久/没有读数/夜间/额度/已做过/busy)', () => {
  const cases = [
    // [名字, 输入, 期望 action, 期望 reason]
    ['够安静 ⇒ 做', { lastUserAtSec: NOW_SEC - 60 * 60 }, 'run', ACTIVITY_REASONS.done],
    ['正好卡在空闲下界上 ⇒ 做(闭区间)', { lastUserAtSec: NOW_SEC - 30 * 60 }, 'run', ACTIVITY_REASONS.done],
    ['离他上一句太近 ⇒ 不做', { lastUserAtSec: NOW_SEC - 10 * 60 }, 'skip', ACTIVITY_REASONS.notIdle],
    ['没有读数(他几天没说话/日志里查不到)⇒ 按够安静算', { lastUserAtSec: 0 }, 'run', ACTIVITY_REASONS.done],
    ['夜里 ⇒ 不做(沿用 care 口径)', { lastUserAtSec: NOW_SEC - 3600, isNight: true }, 'skip', ACTIVITY_REASONS.night],
    ['额度用完 ⇒ 不做', { lastUserAtSec: NOW_SEC - 3600, usedToday: 1 }, 'skip', ACTIVITY_REASONS.budget],
    ['额度给 0 = 等于关掉', { lastUserAtSec: NOW_SEC - 3600, cfg: CFG_ON({ budgetPerDay: 0 }) }, 'skip', ACTIVITY_REASONS.budget],
    ['今天已经做过 ⇒ 不做(防重复)', { lastUserAtSec: NOW_SEC - 3600, doneToday: true }, 'skip', ACTIVITY_REASONS.already],
    ['手上有没干完的活 ⇒ 不做', { lastUserAtSec: NOW_SEC - 3600, busy: true }, 'skip', ACTIVITY_REASONS.busy],
    ['额度调到 3 ⇒ 用掉 2 次还能做', { lastUserAtSec: NOW_SEC - 3600, usedToday: 2, cfg: CFG_ON({ budgetPerDay: 3 }) }, 'run', ACTIVITY_REASONS.done],
    ['idleMin 调大 ⇒ 同一份读数变成太近', { lastUserAtSec: NOW_SEC - 60 * 60, cfg: CFG_ON({ idleMin: 120 }) }, 'skip', ACTIVITY_REASONS.notIdle]
  ]
  for (const [name, inputs, action, reason] of cases) {
    const plan = planActivityTick({
      nowMs: NOW_MS, dateKey: '2026-09-28', cfg: inputs.cfg ?? CFG_ON(), ...inputs
    })
    assert.equal(plan.action, action, name)
    assert.equal(plan.reason, reason, name)
  }
})

test('planActivityTick:判定顺序(额度 → 已做过 → 夜闸 → busy → 空闲),且不许崩', () => {
  // 四件都成立时:先判额度(最省事的那条)
  const all = planActivityTick({
    nowMs: NOW_MS, cfg: CFG_ON(), lastUserAtSec: NOW_SEC, usedToday: 9,
    doneToday: true, busy: true, isNight: true
  })
  assert.equal(all.reason, ACTIVITY_REASONS.budget)
  // 额度还有、但今天做过 ⇒ 已做过(压过夜闸与空闲)
  assert.equal(planActivityTick({ nowMs: NOW_MS, cfg: CFG_ON(), doneToday: true, busy: true, isNight: true }).reason,
    ACTIVITY_REASONS.already)
  // 没做过、但夜里 ⇒ 夜闸
  assert.equal(planActivityTick({ nowMs: NOW_MS, cfg: CFG_ON(), busy: true, isNight: true }).reason,
    ACTIVITY_REASONS.night)

  // 坏输入:空参/坏 cfg/坏读数一律不崩,且按"够安静"走(缺读数不许把她憋死)
  for (const bad of [undefined, null, {}, { cfg: null }, { nowMs: NaN, lastUserAtSec: 'x', cfg: 'nope' }]) {
    const p = planActivityTick(bad)
    assert.equal(typeof p.action, 'string')
    assert.equal(p.action, 'run')
  }
  assert.equal(planActivityTick({ nowMs: NOW_MS, cfg: CFG_ON(), lastUserAtSec: -5 }).idleSec, null)
})

// ---- ② 产出落盘(临时目录)----------------------------------------------------

test('落盘:文件名规则稳定可读、内容原样、UTF-8 **无 BOM**', () => {
  const dir = tempDir()
  try {
    assert.equal(activityFileName('2026-09-28'), '日记-2026-09-28.md')
    assert.equal(activityFileName(''), '')
    assert.equal(activityFileName('2026/09/28'), '', '不是 YYYY-MM-DD ⇒ 不认(不许拼出歪文件名)')
    const body = '今天他坐了夜车回家。\n嘴上说我才不担心,其实数了三遍时间。'
    const w = writeActivityFile(dir, { dateKey: '2026-09-28', content: body })
    assert.equal(w.ok, true, JSON.stringify(w))
    assert.equal(w.path, join(dir, '日记-2026-09-28.md'))
    const raw = readFileSync(w.path)
    assert.equal(raw.toString('utf8'), body, '内容 = 当天产出正文,原样写')
    assert.notEqual(raw[0], 0xEF, 'UTF-8 **无 BOM**(首字节不许是 EF)')
    assert.equal(existsSync(w.path), true)

    // 空内容/坏日期/坏目录 ⇒ ok:false,不抛(失败即不动)
    assert.equal(writeActivityFile(dir, { dateKey: '2026-09-28', content: '   ' }).ok, false)
    assert.equal(writeActivityFile(dir, { dateKey: 'x', content: '正文' }).ok, false)
    assert.equal(writeActivityFile('', { dateKey: '2026-09-28', content: '正文' }).ok, false)
    assert.equal(activityFileExists(dir, '2026-09-28'), true)
    assert.equal(activityFileExists(dir, '2026-09-29'), false)
    assert.equal(activityFileExists(join(dir, '不存在'), '2026-09-28'), false)
    assert.equal(activityFileExists('', '2026-09-28'), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('上限清理:只留最近 N 份,超出删**最旧**;别的文件一个不动', () => {
  const dir = tempDir()
  try {
    // 塞 35 天(2026-08-01 起)—— 每写一份就顺手清过一次,所以写完本来就只剩上限份
    for (let i = 1; i <= 35; i++) {
      const d = String(i).padStart(2, '0')
      writeActivityFile(dir, { dateKey: '2026-08-' + d, content: '第 ' + i + ' 页' })
    }
    // 无关文件(不是她的产出)不该被清理碰掉
    writeFileSync(join(dir, '笔记.txt'), '别人放的东西')
    writeFileSync(join(dir, 'readme.md'), '也一样')
    assert.equal(ACTIVITY_KEEP_DEFAULT, 30)
    const files = listActivityFiles(dir)
    assert.equal(files.length, 30, '上限 30 生效(' + files.length + ')')
    assert.equal(files[0].dateKey, '2026-08-06', '最旧的五份该被删掉,实际最旧:' + files[0].dateKey)
    assert.equal(files[29].dateKey, '2026-08-35', '最新的那份必须在')
    const names = readdirSync(dir)
    assert.ok(names.includes('笔记.txt') && names.includes('readme.md'), '无关文件不许动')

    // 单独调 prune:keep 更小 ⇒ 再删最旧的那批
    const p = pruneActivityFiles(dir, { keep: 3 })
    assert.equal(p.removed, 27)
    assert.equal(p.failed, 0)
    assert.equal(p.kept, 3)
    const left = listActivityFiles(dir).map((f) => f.dateKey)
    assert.deepEqual(left, ['2026-08-33', '2026-08-34', '2026-08-35'], '留下的必须是最新三份')

    // 坏输入:目录不存在 / keep 是坏值 ⇒ 不抛
    assert.deepEqual(pruneActivityFiles(join(dir, '不存在'), { keep: 3 }), { removed: 0, failed: 0, kept: 0 })
    assert.equal(pruneActivityFiles(dir, { keep: NaN }).removed, 0)
    assert.deepEqual(listActivityFiles(''), [])
    assert.deepEqual(listActivityNotes(''), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- ③ 产出读成候选(来源标记)-----------------------------------------------

test('listActivityNotes:note: 前缀 + source=self-activity + hasArtifact;读不到 ⇒ 空数组', () => {
  const dir = tempDir()
  try {
    writeActivityFile(dir, { dateKey: '2026-09-27', content: '昨天那一页' })
    writeActivityFile(dir, { dateKey: '2026-09-28', content: '今天这一页' })
    writeFileSync(join(dir, '别的.md'), '不是她的产出')
    const realNow = Date.now()
    const notes = listActivityNotes(dir, { limit: 10, nowMs: realNow, windowHours: 72 })
    assert.deepEqual(notes.map((n) => n.id), ['note:日记-2026-09-28', 'note:日记-2026-09-27'], '新的在前;id = `note:` + 文件名主干')
    const top = notes[0]
    assert.equal(top.type, 'artifact', '类型仍走 artifact(具体性满分,接既有的类型线)')
    assert.equal(top.source, 'self-activity', '★ 来源标记:数据层面可识别')
    assert.equal(top.hasArtifact, true)
    assert.equal(top.kind, 'diary', 'P4b:类型一并透出来(台账里可按类型 GROUP BY)')
    assert.equal(top.dateKey, '2026-09-28')
    assert.equal(top.text, '今天这一页')
    assert.ok(top.createdAt > 0, 'createdAt = 文件 mtime(她是**什么时候**做的)')

    // 窗口:把"现在"拨到十天以后 ⇒ 两份都出窗(给了 nowMs 才判窗口)
    assert.deepEqual(listActivityNotes(dir, { nowMs: realNow + 10 * 86400 * 1000, windowHours: 72 }), [])
    // nowMs 不给 ⇒ 不判窗口(宁可多收,不拿本机时钟当判据)
    assert.equal(listActivityNotes(dir, { limit: 10 }).length, 2)
    // 目录不在/是空串 ⇒ []
    assert.deepEqual(listActivityNotes(join(dir, '不存在'), { nowMs: realNow }), [])

    // 打分的产物里也带着来源标记(判到一半也查得出这条是谁的产出)
    const scored = pickTop(notes, { minScore: 0, ctx: { now: NOW_SEC } })
    assert.equal(scored.source, 'self-activity')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- ④ 第四类来源接进候选池 --------------------------------------------------

/** 假 db 替身(与 topic-score.test.js 同款):只认表名,不碰真库。 */
function fakeThreads (n = 10) {
  const rows = Array.from({ length: n }, (_, i) => ({
    thread_id: i + 1, content: '悬置话题 ' + (i + 1), session_id: 's', last_mentioned_at: 0, created_at: NOW_SEC - 2 * 86400
  }))
  return { prepare: (sql) => ({ all: () => (sql.includes('pending_threads') ? rows : []) }) }
}

test('collectCandidates:不给 activityDir ⇒ 老行为**逐条不变**(这一类来源今天没有)', () => {
  const db = fakeThreads(10)
  const out = collectCandidates({ db, now: NOW_SEC, limit: 4 })
  assert.equal(out.some((c) => String(c.id).startsWith('note:')), false)
  assert.deepEqual(out.map((c) => c.id), ['thread:1', 'thread:2', 'thread:3', 'thread:4'], 'P1 的"按来源顺序切"不许动')
})

test('collectCandidates:note: 进池,而且**吃既有来源保底**(不被话题挤掉)', () => {
  const dir = tempDir()
  try {
    writeActivityFile(dir, { dateKey: '2026-09-28', content: '今天这一页' })
    const db = fakeThreads(10)
    // 不保底:座位先被话题吃光(这就是"产出永远进不了池"的饥饿)
    const noFloor = collectCandidates({ db, now: NOW_SEC, limit: 4, activityDir: dir })
    assert.equal(noFloor.some((c) => String(c.id).startsWith('note:')), false)
    // 保底 1 条/来源:她的产出**必进**
    const floored = collectCandidates({ db, now: NOW_SEC, limit: 4, floor: 1, activityDir: dir })
    assert.ok(floored.some((c) => c.id === 'note:日记-2026-09-28'), '保底必须把她自己的产出收进来')
    assert.equal(floored.length, 4, 'limit 仍是硬上限')
    // 只给目录、没有库 ⇒ 只剩这一类来源,也要能组出池
    const only = collectCandidates({ activityDir: dir, now: NOW_SEC })
    assert.deepEqual(only.map((c) => c.id), ['note:日记-2026-09-28'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('生产路径真的接了第四类来源:打分器开着时,盘上的产出进池(台账 candidates 数得到)', async () => {
  const store = freshStore()
  const dir = tempDir()
  try {
    writeActivityFile(dir, { dateKey: '2026-09-28', content: '今天这一页。他坐了夜车回家。' })
    const on = makeHb(store, {
      // 打分那一套只在"引擎说该开口"之后才走(它长在 care 通道里)—— 所以这一拍
      // 得先让想念过线,否则压根到不了候选池那一步。
      engine: fakeEngine({ longing: careState() }),
      getProactiveScoring: () => ({ ...PROACTIVE_SCORING_OFF, enabled: true }),
      getActivityDir: () => dir
    })
    await on.hb.tick(fakeAgent('sess-1'))
    const care = store.careBeatsSince(0, 20).find((b) => b.kind === 'care')
    assert.equal(care.candidates, 1, '★ 她自己的产出必须真的进候选池(不是只写了个函数没人调)')
    // 如果它进了边缘区/过了线,台账里那条 topic_id 必须带 `note:` 前缀(来源可查)
    if (String(care.topicId || '') !== '') assert.equal(care.topicId, 'note:日记-2026-09-28')

    // 对照:盘上没产出 ⇒ 池子是空的(这一档没开 / 没做过,不许凭空多出候选)
    const store2 = freshStore()
    try {
      const off = makeHb(store2, {
        engine: fakeEngine({ longing: careState() }),
        getProactiveScoring: () => ({ ...PROACTIVE_SCORING_OFF, enabled: true }),
        getActivityDir: () => NO_DIR
      })
      await off.hb.tick(fakeAgent('sess-1'))
      assert.equal(store2.careBeatsSince(0, 20).find((b) => b.kind === 'care').candidates, 0)
    } finally { store2.close() }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ---- ④b P4b:多活动类型(整理记忆)-------------------------------------------
//
// 这一组钉三件事:
//   ① 类型 → 文件名前缀**一处写死**(`日记-` / `整理-`),认不出的类型不硬拼文件名;
//   ② 防重复**按类型**判(写过日记 ≠ 整理过),而上限清理**各类共用**一份;
//   ③ 整理那一类的正文**复用既有的策展管线**(只读快照 + `composeCuratedText`),
//      **零模型调用**;空快照 ⇒ 空串(不许拿 `fallbackText()` 冒充"她整理过了")。

test('类型 → 文件名前缀一处写死:diary / memory 各一份,认不出的类型不硬拼', () => {
  assert.deepEqual([...ACTIVITY_KINDS], ['diary', 'memory'], '认得的活动类型')
  assert.equal(ACTIVITY_FILE_PREFIXES.memory, '整理-')
  assert.equal(ACTIVITY_KIND_DEFAULT, 'diary')
  assert.equal(activityFileName('2026-09-28'), '日记-2026-09-28.md', '不给 kind ⇒ 出厂 diary(旧调用逐字不变)')
  assert.equal(activityFileName('2026-09-28', 'memory'), '整理-2026-09-28.md')
  assert.equal(activityFileName('2026-09-28', 'MEMORY'), '整理-2026-09-28.md', '大小写归一')
  assert.equal(activityFileName('2026-09-28', 'goal'), '', '没实现的类型**不许**硬拼出文件名(也就不会写成文件)')
  assert.equal(activityFileName('', 'memory'), '')
  assert.equal(activityKindOf('memory'), 'memory')
  assert.equal(activityKindOf('goal'), '')
  assert.equal(activityKindFromName('整理-2026-09-28.md'), 'memory')
  assert.equal(activityKindFromName('日记-2026-09-28.md'), 'diary')
  assert.equal(activityKindFromName('别的-2026-09-28.md'), '', '前缀认不出 ⇒ 不是她的产出')
})

test('整理那一类落盘:`整理-日期.md`、内容原样、UTF-8 无 BOM;日记那份不受影响', () => {
  const dir = tempDir()
  try {
    const body = '── 账本: 聊过 40 轮 · 她记得 12 件事'
    const w = writeActivityFile(dir, { dateKey: '2026-09-28', content: body, kind: 'memory' })
    assert.equal(w.ok, true, JSON.stringify(w))
    assert.equal(w.path, join(dir, '整理-2026-09-28.md'))
    const raw = readFileSync(w.path)
    assert.equal(raw.toString('utf8'), body, '内容原样写')
    assert.notEqual(raw[0], 0xEF, 'UTF-8 **无 BOM**')
    // 两类各一份:同一日期互不覆盖
    writeActivityFile(dir, { dateKey: '2026-09-28', content: '今天这一页', kind: 'diary' })
    assert.equal(existsSync(join(dir, '日记-2026-09-28.md')), true)
    assert.equal(existsSync(join(dir, '整理-2026-09-28.md')), true)
    assert.deepEqual(readdirSync(dir).sort(), ['整理-2026-09-28.md', '日记-2026-09-28.md'])
    // 类型不认识 ⇒ 不落盘(不是"写成 diary")
    assert.equal(writeActivityFile(dir, { dateKey: '2026-09-28', content: 'x', kind: 'goal' }).ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('防重复**按类型**判(写过日记 ≠ 整理过);上限清理**各类共用**一份', () => {
  const dir = tempDir()
  try {
    writeActivityFile(dir, { dateKey: '2026-09-28', content: '今天这一页' })
    assert.equal(activityFileExists(dir, '2026-09-28'), true)
    assert.equal(activityFileExists(dir, '2026-09-28', 'diary'), true)
    assert.equal(activityFileExists(dir, '2026-09-28', 'memory'), false, '★ 按类型判:日记在盘上不等于整理做过了')
    assert.equal(activityFileExists(dir, '2026-09-28', 'goal'), false, '认不出的类型 ⇒ 当"没有"')
    writeActivityFile(dir, { dateKey: '2026-09-28', content: '整理正文', kind: 'memory' })
    assert.equal(activityFileExists(dir, '2026-09-28', 'memory'), true)
    const rows = listActivityFiles(dir)
    assert.deepEqual(rows.map((f) => [f.kind, f.dateKey]), [['memory', '2026-09-28'], ['diary', '2026-09-28']],
      '读回时带 kind;同一日期按文件名排(`整理-` 的码位在 `日记-` 前)')

    // ★ 共用上限:两类各写 20 天(共 40 份)⇒ 只留最近 30 份(按类分额会留下 60 份)
    const dir2 = tempDir()
    try {
      for (let i = 1; i <= 20; i++) {
        const d = String(i).padStart(2, '0')
        writeActivityFile(dir2, { dateKey: '2026-08-' + d, content: '日记 ' + i })
        writeActivityFile(dir2, { dateKey: '2026-08-' + d, content: '整理 ' + i, kind: 'memory' })
      }
      const left = listActivityFiles(dir2)
      assert.equal(left.length, ACTIVITY_KEEP_DEFAULT, '两类**合起来**封顶 30')
      assert.equal(left[0].dateKey, '2026-08-06', '删掉的是最旧那几天(两类一起),实际:' + left[0].dateKey)
      assert.equal(left.filter((f) => f.kind === 'memory').length, 15, '两个类型都被保留(共用池,不是按类各留一份)')
    } finally { rmSync(dir2, { recursive: true, force: true }) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('listActivityNotes:两类产出都进候选,id 用文件名主干(同类同日不撞车)', () => {
  const dir = tempDir()
  try {
    writeActivityFile(dir, { dateKey: '2026-09-28', content: '今天这一页' })
    writeActivityFile(dir, { dateKey: '2026-09-28', content: '── 账本: 她记得 12 件事', kind: 'memory' })
    const notes = listActivityNotes(dir, { limit: 10, nowMs: Date.now(), windowHours: 72 })
    const byId = new Map(notes.map((n) => [n.id, n]))
    assert.equal(byId.size, 2, '两类产出**都**读得到:' + JSON.stringify(notes.map((n) => n.id)))
    assert.deepEqual([...byId.keys()].sort(), ['note:整理-2026-09-28', 'note:日记-2026-09-28'])
    assert.equal(byId.get('note:整理-2026-09-28').kind, 'memory')
    assert.equal(byId.get('note:整理-2026-09-28').source, 'self-activity', '来源标记照旧')
    assert.equal(byId.get('note:日记-2026-09-28').kind, 'diary')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('整理正文:复用策展管线渲染(零模型调用);空快照 ⇒ 空串,不拿 fallback 冒充', () => {
  assert.equal(hasSnapshotData({}), false)
  assert.equal(hasSnapshotData(null), false)
  assert.equal(composeTidyText({}), '', '库不在/一页都没得整理 ⇒ 空串(执行体记 nothing-to-tidy, 不是"做过")')
  assert.equal(composeTidyText(null), '')
  assert.equal(composeTidyText('nope'), '')

  const snap = {
    profile: { name: '阿岚', core_traits: '{"偏好":"画画"}', affinity: 7 },
    counts: { memories: 12, beliefs: 3, turns: 40, firstAt: NOW_SEC - 86400 * 30, lastAt: NOW_SEC - 3600 },
    threads: [{ content: '问他面试怎么样', follow_up_after: 0, created_at: NOW_SEC - 7200 }],
    moments: [{ summary: '他说他喜欢舞萌', timestamp: NOW_SEC - 3600, emotion_score: 8 }],
    mood: { mood_intensity: 7, user_emotion: 'happy', mood_reason: '' }
  }
  assert.equal(hasSnapshotData(snap), true)
  const text = composeTidyText(snap, { now: NOW_SEC })
  assert.ok(text.includes('策展'), '渲染的是压缩域那条**既有**管线(同一份文案,不是新造的)')
  assert.ok(text.includes('他说他喜欢舞萌'), '她记得的事进了这一页')
  assert.ok(text.includes('问他面试怎么样'), '没结掉的事也在')
  assert.ok(text.includes('阿岚'), '关系账本在')
  // 预算也能压(与压缩域同一条纪律:绝不超过)
  assert.ok(composeTidyText(snap, { now: NOW_SEC, budgetTokens: 120 }).length > 0)
  // 只有轮次、没有记忆点 ⇒ 仍算有东西可整理
  assert.equal(hasSnapshotData({ counts: { turns: 1 } }), true)
  assert.equal(hasSnapshotData({ counts: { memories: 0, turns: 0 }, moments: [] }), false)
})

// ---- ⑤ 心跳里那一档:默认关 = 零行为变化;开着才动 ----------------------------
function fakeEngine (script = {}) {
  const calls = []
  return {
    calls,
    async threadsRemindable () { calls.push('remindable'); return { items: script.remindable ?? [] } },
    async threadsMark () {},
    async longingTick () { calls.push('tick') },
    async longing () { calls.push('longing'); return script.longing ?? null },
    async agendaPick () { calls.push('agendaPick'); return null },
    async agendaMark () {},
    async longingCare () {}
  }
}

function freshStore () {
  const store = openStore(':memory:')
  store.db.prepare("INSERT INTO user_profile (user_id, name) VALUES (?, '阿岚')").run(MASTER_ID)
  return store
}

const fakeAgent = (sid) => ({
  session: { id: sid }, sent: [],
  runMaintenance (cb) { return Promise.resolve(cb()).then(() => true) },
  followup (m) { this.sent.push(m) }
})

/** 心跳:现在只注入这一档相关的件(其余走老路)。 */
function makeHb (store, opts = {}) {
  const activityCalls = []
  // "他上一句话在什么时候":给了函数就每拍现问(能拨),否则一个定值
  const spokeAt = typeof opts.lastUserAt === 'function'
    ? opts.lastUserAt
    : () => (opts.lastUserAtSec === undefined ? NOW_SEC - 3600 : opts.lastUserAtSec)
  const hb = createHeartbeat({
    engine: opts.engine ?? fakeEngine({ longing: null }),
    store, logger: null, isEnabled: () => true,
    createUserMessage: (m) => ({ role: 'user', ...m }),
    masterId: MASTER_ID,
    now: typeof opts.nowMs === 'function' ? opts.nowMs : () => AT(opts.hour ?? 15, opts.minute ?? 0),
    getUserSpokeAt: () => spokeAt(),
    getNightHold: () => true,
    // ★ 把打分器**钉死成关着**(可被 opts 覆盖):这一套测的是"自由活动"那一档,
    //   不许受本机 `~/.dsh/echo/config.json` 里 `proactiveScoring.enabled` 的真值影响
    //   (`createHeartbeat` 在没注入时会回落到真配置 —— 那会让 care 通道的判词
    //   随他机器上的设置变来变去,电池就不再是电池了)。
    getProactiveScoring: opts.getProactiveScoring ?? (() => null),
    // ⚠️ 不给 getHerActivity 的那两种用例(默认关 / 旧装机位)由调用方自己省掉
    ...(opts.getHerActivity === undefined ? {} : { getHerActivity: opts.getHerActivity }),
    ...(opts.getActivityDir === undefined ? {} : { getActivityDir: opts.getActivityDir }),
    ...(opts.runSelfActivity === undefined
      ? {}
      : { runSelfActivity: async (o) => { activityCalls.push(o); return opts.runSelfActivity(o) } })
  })
  return { hb, activityCalls }
}

/** 一个**不存在**的目录:落盘/存在性检查都当"今天还没有产出"。 */
const NO_DIR = join(tmpdir(), 'echo-activity-nope')

const careState = (over = {}) => ({
  value: 8.2, threshold: 5.5, sinceMessage: 41400, sessionId: 'sess-1', shouldCare: true, ...over
})

const activityRows = (store) => store.careBeatsSince(0, 50).filter((b) => b.kind === 'activity')

test('默认关:不注入 herActivity(旧装机位)⇒ 一个字节都不做(不落账、不调执行体)', async () => {
  const store = freshStore()
  try {
    // 这一条测的是**回落路径**(壳没注入 getter ⇒ `readSettings().herActivity`)——
    // 所以先钉住"隔离 HOME 里的配置是出厂默认(关)",判据与真机配置无关:
    // 真机上 `enabled` 已按批准置 true,若没隔离,这条会真的做起活动来(实测 ran=1)。
    assert.equal(readSettings().herActivity.enabled, false,
      '隔离 HOME 里 herActivity 必须是关的(否则这条测的就是真机配置)')
    assert.ok(String(TEST_HOME).length > 0, 'DSH_HOME 已指到临时目录')
    let ran = 0
    const { hb } = makeHb(store, {
      engine: fakeEngine({ longing: null }),
      runSelfActivity: () => { ran += 1; return { ok: true, path: '/tmp/x.md', chars: 3 } }
    })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(ran, 0, '默认关 ⇒ 不许调执行体')
    assert.deepEqual(activityRows(store), [], '默认关 ⇒ 台账里一行 activity 都不该有')
    // 老路逐条不变:引擎说"不该开口" ⇒ engine-says-no(与今天一模一样)
    assert.deepEqual(store.careBeatsSince(0, 10).map((b) => b.reason), ['engine-says-no'])
    assert.equal(agent.sent.length, 0)
  } finally { store.close() }
})

test('显式关(enabled:false)⇒ 同样零行为变化', async () => {
  const store = freshStore()
  try {
    let ran = 0
    const { hb } = makeHb(store, {
      getHerActivity: () => ({ ...HER_ACTIVITY_OFF, enabled: false }),
      runSelfActivity: () => { ran += 1; return { ok: true } }
    })
    await hb.tick(fakeAgent('sess-1'))
    assert.equal(ran, 0)
    assert.deepEqual(activityRows(store), [])
  } finally { store.close() }
})

test('开着 + 够安静 ⇒ 做一次:台账 `activity/idle-done`(acted=false)+ payload 留痕', async () => {
  const store = freshStore()
  const dir = tempDir()
  try {
    const path = join(dir, '日记-2026-09-28.md')
    const { hb, activityCalls } = makeHb(store, {
      getHerActivity: () => CFG_ON(),
      getActivityDir: () => dir,
      runSelfActivity: async () => ({ ok: true, path, chars: 42, kept: 1, removed: 0 })
    })
    await hb.tick(fakeAgent('sess-1'))
    assert.equal(activityCalls.length, 1, '该动一次')
    assert.deepEqual(activityCalls[0], { dateKey: '2026-09-28', dir, kind: 'diary' })
    const row = activityRows(store)[0]
    assert.equal(row.reason, ACTIVITY_REASONS.done)
    assert.equal(row.kind, 'activity')
    assert.equal(row.acted, false, '★ 写日记不是"开口" —— 不许混进"她开口 N 次"')
    assert.equal(row.payload.path, path)
    assert.equal(row.payload.chars, 42)
    // 「开口额度」一格都没动(这一档不消耗开口额度)
    assert.equal(store.careSentCountSince(0), 0)

    // 第二拍:台账说今天做过了 ⇒ 不再组稿(额度=1 ⇒ 落到 budget-used 那条)
    await hb.tick(fakeAgent('sess-1'))
    assert.equal(activityCalls.length, 1, '★ 防重复:今天做过了就不许再组一次稿')
    assert.ok(activityRows(store).some((b) => b.reason === ACTIVITY_REASONS.budget), '实际:' + JSON.stringify(activityRows(store).map((b) => b.reason)))
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('防重复(产出已在盘上):额度还够也不做 —— reason=already-done', async () => {
  const store = freshStore()
  const dir = tempDir()
  try {
    writeActivityFile(dir, { dateKey: '2026-09-28', content: '今天这一页' })
    const { hb, activityCalls } = makeHb(store, {
      getHerActivity: () => CFG_ON({ budgetPerDay: 3 }), // 额度故意留够 ⇒ 判据只能落在"今天做过了"
      getActivityDir: () => dir,
      runSelfActivity: async () => ({ ok: true })
    })
    await hb.tick(fakeAgent('sess-1'))
    assert.equal(activityCalls.length, 0, '盘上已经有今天那一页 ⇒ 不许再组一次稿')
    assert.equal(activityRows(store)[0].reason, ACTIVITY_REASONS.already)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('开着但还没安静下来 / 夜里 / 额度用完 ⇒ 跳过并留痕(执行体一次都不调)', async () => {
  const cases = [
    ['not-idle', { lastUserAtSec: NOW_SEC - 60 }],
    ['night-hold', { hour: 23, minute: 30 }],
    ['budget-used', { usedUp: true }]
  ]
  for (const [reason, over] of cases) {
    const store = freshStore()
    if (over.usedUp === true) {
      for (let i = 0; i < 3; i++) store.careBeatAdd({ at: NOW_SEC - 60, kind: 'activity', reason: ACTIVITY_REASONS.done, acted: false })
    }
    const { hb, activityCalls } = makeHb(store, {
      getHerActivity: () => CFG_ON(),
      getActivityDir: () => NO_DIR,
      lastUserAtSec: over.lastUserAtSec,
      hour: over.hour, minute: over.minute,
      runSelfActivity: async () => ({ ok: true })
    })
    try {
      await hb.tick(fakeAgent('sess-1'))
      assert.equal(activityCalls.length, 0, reason + ':执行体不许被调')
      assert.ok(activityRows(store).some((b) => b.reason === reason),
        reason + ':跳过也要留痕,实际:' + JSON.stringify(activityRows(store).map((b) => b.reason)))
    } finally { store.close() }
  }
})

test('手上有没干完的活(上一句话还没送到他手机)⇒ busy,不抢着去干别的', async () => {
  const store = freshStore()
  try {
    let clock = AT(15, 0)
    let spokeAgo = 60 // 第一拍:他刚说完话(活动这一档按 not-idle 让开,关怀照常开口)
    const { hb, activityCalls } = makeHb(store, {
      engine: fakeEngine({ longing: careState() }),
      getHerActivity: () => CFG_ON(),
      getActivityDir: () => NO_DIR,
      nowMs: () => clock,
      lastUserAt: () => clock / 1000 - spokeAgo,
      runSelfActivity: async () => ({ ok: true })
    })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(activityCalls.length, 0, '第一拍太近 ⇒ 不该动')
    assert.equal(hb.pendingCareCount(), 1, '第一拍关怀真的开口了 ⇒ 留下一笔未兑现账')
    clock = AT(17, 0)
    spokeAgo = 3600 // 够安静了、天也亮着、额度没用、盘上也没产出 —— 只剩"上一句还没兑现"
    await hb.tick(agent)
    assert.equal(activityCalls.length, 0, 'busy:执行体不许被调')
    assert.ok(activityRows(store).some((b) => b.reason === ACTIVITY_REASONS.busy),
      '实际:' + JSON.stringify(activityRows(store).map((b) => b.reason)))
  } finally { store.close() }
})

test('执行体失败/没接上 ⇒ 记 failed、不抛(整拍照旧走完 care 通道)', async () => {
  const store = freshStore()
  try {
    // ① 执行体自己返回 ok:false
    const a = makeHb(store, {
      getHerActivity: () => CFG_ON(),
      getActivityDir: () => NO_DIR,
      runSelfActivity: async () => ({ ok: false, error: 'compose-null' })
    })
    await a.hb.tick(fakeAgent('sess-1'))
    const failed = activityRows(store).find((b) => b.reason === ACTIVITY_REASONS.failed)
    assert.ok(failed !== undefined, '失败也要留痕')
    assert.equal(failed.payload.error, 'compose-null')
    // 整拍没被带走:care 通道照旧判了(engine-says-no)
    assert.ok(store.careBeatsSince(0, 20).some((b) => b.reason === 'engine-says-no'))

    // ② 执行体抛错 ⇒ 整拍不许炸(留 failed + 宿主日志)
    const store2 = freshStore()
    try {
      const b = makeHb(store2, {
        getHerActivity: () => CFG_ON(),
        getActivityDir: () => NO_DIR,
        runSelfActivity: async () => { throw new Error('boom') }
      })
      await b.hb.tick(fakeAgent('sess-1'))
      const rows = activityRows(store2)
      assert.equal(rows[0].reason, ACTIVITY_REASONS.failed)
      assert.equal(rows[0].payload.error, 'boom')
      assert.ok(store2.careBeatsSince(0, 20).some((b2) => b2.reason === 'engine-says-no'), 'care 通道照旧')
    } finally { store2.close() }

    // ③ 壳没注入执行体 ⇒ 不硬做,记 no-runner
    const store3 = freshStore()
    try {
      const c = makeHb(store3, { getHerActivity: () => CFG_ON(), getActivityDir: () => NO_DIR })
      await c.hb.tick(fakeAgent('sess-1'))
      const rows = activityRows(store3)
      assert.equal(rows[0].reason, ACTIVITY_REASONS.failed)
      assert.equal(rows[0].payload.error, 'no-runner')
    } finally { store3.close() }
  } finally { store.close() }
})

test('不污染主记忆:这一档只写文件与 care_beats,记忆/图谱一行都不许多', async () => {
  const store = freshStore()
  const dir = tempDir()
  try {
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM episodic_memory').get().n
    const graphBefore = store.db.prepare('SELECT COUNT(*) AS n FROM graph_nodes').get().n
    const auditsBefore = store.listAudit(0, 10).length
    const { hb } = makeHb(store, {
      getHerActivity: () => CFG_ON(),
      getActivityDir: () => dir,
      // 执行体在这条用例里**真的**落一份盘(其余用例用假件)
      runSelfActivity: async ({ dateKey }) => {
        const w = writeActivityFile(dir, { dateKey, content: '今天他坐了夜车回家。' })
        return { ok: w.ok, path: w.path, chars: 10 }
      }
    })
    await hb.tick(fakeAgent('sess-1'))
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM episodic_memory').get().n, before, '★ 主记忆不许被污染')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM graph_nodes').get().n, graphBefore, '★ 图谱也不许')
    assert.equal(store.listAudit(0, 10).length, auditsBefore, '审计是"她说了什么"的贵账 —— 这一档不写它')
    // diary 表也不许被碰(那一页仍归 22:30 的既有管线)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM diary').get().n, 0, '★ 不许代日记管线写表')
    // 但产出真的在盘上 + 台账有痕
    assert.equal(existsSync(join(dir, '日记-2026-09-28.md')), true)
    assert.equal(activityRows(store).length, 1)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('目录写不进去(拿文件当目录)⇒ 记 failed,不抛', async () => {
  const store = freshStore()
  const dir = tempDir()
  try {
    const notADir = join(dir, '其实是个文件')
    writeFileSync(notADir, 'x')
    const { hb } = makeHb(store, {
      getHerActivity: () => CFG_ON(),
      getActivityDir: () => notADir,
      runSelfActivity: async ({ dir: d, dateKey }) => {
        const w = writeActivityFile(d, { dateKey, content: '正文' })
        return { ok: w.ok, error: w.error, path: w.path }
      }
    })
    await hb.tick(fakeAgent('sess-1'))
    const rows = activityRows(store)
    assert.equal(rows[0].reason, ACTIVITY_REASONS.failed)
    assert.ok(String(rows[0].payload.error).length > 0)
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('P4b:kind=memory ⇒ 执行体拿到 memory,防重复按 `整理-` 那份判(盘上只有日记 ⇒ 照做)', async () => {
  const store = freshStore()
  const dir = tempDir()
  try {
    // 盘上只有**日记**那一份(= P4a 留下的产出)⇒ memory 这一拍不该判 already-done
    writeActivityFile(dir, { dateKey: '2026-09-28', content: '今天这一页' })
    const { hb, activityCalls } = makeHb(store, {
      getHerActivity: () => CFG_ON({ kind: 'memory', budgetPerDay: 2 }), // 额度留够 ⇒ 判据只能落在类型上
      getActivityDir: () => dir,
      runSelfActivity: async (o) => {
        const w = writeActivityFile(o.dir, { dateKey: o.dateKey, content: '── 账本: 她记得 12 件事', kind: o.kind })
        return { ok: w.ok, path: w.path, chars: 20, kept: w.kept, removed: w.removed }
      }
    })
    await hb.tick(fakeAgent('sess-1'))
    assert.deepEqual(activityCalls, [{ dateKey: '2026-09-28', dir, kind: 'memory' }], '配置的那一类原样交给执行体')
    const row = activityRows(store)[0]
    assert.equal(row.reason, ACTIVITY_REASONS.done)
    assert.equal(row.payload.kind, 'memory')
    assert.equal(existsSync(join(dir, '整理-2026-09-28.md')), true, '产出落在**整理-**那一份上')
    // 第二拍:整理那份已在盘上 ⇒ already-done(额度还有 2 次,所以不是 budget-used)
    await hb.tick(fakeAgent('sess-1'))
    assert.equal(activityCalls.length, 1, '★ 防重复按类型判:整理过了就不再整理')
    assert.ok(activityRows(store).some((b) => b.reason === ACTIVITY_REASONS.already),
      '实际:' + JSON.stringify(activityRows(store).map((b) => b.reason)))
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('没实现的 kind(goal)⇒ 原样交给执行体,由它回 kind-not-implemented 并落 failed 账', async () => {
  const store = freshStore()
  try {
    const { hb, activityCalls } = makeHb(store, {
      getHerActivity: () => CFG_ON({ kind: 'goal' }),
      getActivityDir: () => NO_DIR,
      // 真执行体(`lib/index.js runHerActivity`)对没实现的类型就是这个返回值 ——
      // 这里钉的是**心跳侧不许偷偷把 goal 换成 diary**(不许静默降级)。
      runSelfActivity: async () => ({ ok: false, error: 'kind-not-implemented' })
    })
    await hb.tick(fakeAgent('sess-1'))
    assert.equal(activityCalls[0].kind, 'goal', '配置值原样下传(不许被顶成 diary)')
    const row = activityRows(store)[0]
    assert.equal(row.reason, ACTIVITY_REASONS.failed)
    assert.equal(row.payload.kind, 'goal')
    assert.equal(row.payload.error, 'kind-not-implemented')
    // 跳过/失败那一格也带 kind(台账可按类型 GROUP BY)
    const store2 = freshStore()
    try {
      const b = makeHb(store2, {
        getHerActivity: () => CFG_ON({ kind: 'memory' }),
        getActivityDir: () => NO_DIR,
        lastUserAtSec: NOW_SEC - 60 // 太近 ⇒ skip
      })
      await b.hb.tick(fakeAgent('sess-1'))
      assert.equal(activityRows(store2)[0].payload.kind, 'memory')
    } finally { store2.close() }
  } finally { store.close() }
})

// ---- ⑥ 枚举闭环 / 配置连锁 ---------------------------------------------------

test('枚举闭环:ACTIVITY_REASONS 的每个值都在文案表里(不许印"未知理由")', () => {
  for (const reason of Object.values(ACTIVITY_REASONS)) {
    assert.notEqual(describeReason(reason), UNKNOWN_REASON_TEXT, 'reason「' + reason + '」还没进 care-report 的文案表')
  }
  assert.ok(describeReason('idle-done').includes('自由活动'))
})

test('配置连锁:默认值 / normalize / 字段表三处都在,且坏值回落', () => {
  const d = SETTINGS_DEFAULTS.herActivity
  assert.deepEqual({ ...d }, { ...HER_ACTIVITY_OFF }, '出厂默认值必须与 her-activity.js 同一份')
  const n = normalizeSettings({ herActivity: { enabled: true, budgetPerDay: 99, idleMin: 0, quietHoursSameAsCare: 'yes', kind: 'DIARY' } })
  assert.equal(n.herActivity.enabled, true)
  assert.equal(n.herActivity.budgetPerDay, 24, '钳到上限')
  assert.equal(n.herActivity.idleMin, 1, '钳到下限')
  assert.equal(n.herActivity.quietHoursSameAsCare, true, '脏值(non-boolean)回落默认')
  assert.equal(n.herActivity.kind, 'diary', '大写/歪值归一到出厂')
  assert.equal(normalizeSettings({}).herActivity.enabled, false, '缺省 ⇒ 关(零行为变化)')
  assert.equal(normalizeSettings({ herActivity: { kind: 'study' } }).herActivity.kind, 'study', '认得的值照收')
  // P4b:新类型也是"照收"—— 归一**不做白名单**(否则没实现的 kind 会被静默换成 diary)
  assert.equal(normalizeSettings({ herActivity: { kind: 'memory' } }).herActivity.kind, 'memory', '新类型照收')
  assert.deepEqual([...ACTIVITY_KINDS], ['diary', 'memory'], '允许值域(实现的那两类)')
})
