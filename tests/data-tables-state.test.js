/**
 * B3(P3-d 状态初值):`state-defaults.json` 的三个初值在 JS 侧**真的被读了**,
 * 而且**空 / 坏 ⇒ 逐位回到迁移前的字面值** —— 后者才是 P3 的硬验收
 * (P3 迁移设计 §5.2 的"指纹法":数据为空时行为与迁移前一致)。
 *
 * 为什么要 `await import`:
 *   读点(`lib/store.js` 的 getState / saveState / emotionStates、`lib/reflect.js` 的
 *   normalizeExtract、`lib/heartbeat.js` 的 isNightHour / isWakeStale)走的是
 *   `graphCfgOf()` / `stateDefaultsOf()`(**不传 env**)⇒ 一律以 `process.env`
 *   解析数据目录,而 `lib/data-dir.js:83-91` 的口径是"**进程内第一个问到的人定死**"。
 *   所以必须在任何 lib 模块被解析**之前**把 `ECHO_DATA_DIR` 指到临时目录 ——
 *   静态 import 会被提升到这段之前,只能用动态 import。
 *   (`node --test` 每个测试文件一个进程,所以这里改 env 不会串到别的文件。)
 *
 * 三组断言:
 *   ① 数据给了值 ⇒ 用它(mood 6 / prev 4 / tired / affinity 70 都要能覆盖掉出厂值);
 *   ② 文件缺 / 坏 ⇒ 3 / 3 / neutral / 50(DDL 的 `DEFAULT 50` 兜底,见 §1.3 row 16);
 *   ③ 追加(§2.1 row 18/19 + `reflect.js:124`):夜闸钟面 / 过期阈值 / emotion_score
 *      兜底也吃数据,空 ⇒ 23 / 8 / 24 / 3。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'echo-state-defaults-'))
process.env.ECHO_DATA_DIR = dir

const { openStore } = await import('../lib/store.js')
const { normalizeExtract } = await import('../lib/reflect.js')
const { isNightHour, isWakeStale, nightHoldWindow } = await import('../lib/heartbeat.js')
// 2026-10-10 笔 3:衰减基线也吃 `state-defaults.json.emotionVector` ——
// 动态 import 的原因同上(必须在 ECHO_DATA_DIR 定死之后再解析)。
const { decayedEmotionVector, defaultEmotionVector } = await import('../lib/emotion.js')

const H = 3600
const NOW = 1_800_000_000

/** 把 state-defaults.json 写成给定内容(字符串原样落盘,便于造坏文件)。 */
function writeStateDefaults (body) {
  writeFileSync(join(dir, 'state-defaults.json'), typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
}

/** 把 graph.json 写成给定内容(夜闸钟面的落点;`windows` 是自由 object)。 */
function writeGraph (body) {
  writeFileSync(join(dir, 'graph.json'), typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
}

/**
 * 把 config.json 写成给定内容 —— **过期阈值的落点在这里**(`settings.staleHours`):
 * 与面板、壳侧注入(`getStaleHours`)读的是同一份真值(§2.1 row 19)。
 */
function writeSettings (settings) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ settings }), 'utf8')
}

/** 插一行"列里没有值"的认知状态(老库 / 显式写空 —— 兜底判据就在这里生效)。 */
function insertBareStateRow (store) {
  store.db.prepare(
    'INSERT INTO agent_state (session_id, mood_intensity, prev_mood_intensity, user_emotion, updated_at)' +
    ' VALUES (?, NULL, NULL, NULL, 1)'
  ).run('global')
}

test('有值:状态初值以 state-defaults.json 为准(出厂值 3 / 3 / neutral / 50 都被覆盖)', () => {
  writeStateDefaults({
    schemaRev: 1, moodIntensity: 6, prevMoodIntensity: 4, userEmotion: 'tired', affinity: 70
  })

  // 写侧(saveState):给 0 / 空串 ⇒ 回数据里的初值,而不是代码里的 3 / neutral
  const s = openStore(':memory:')
  assert.equal(s.getState().moodIntensity, 6, '没聊过时 getState 的初值也来自数据')
  s.saveState({ moodIntensity: 0, prevMoodIntensity: 0, userEmotion: '' })
  const row = s.db.prepare('SELECT mood_intensity, prev_mood_intensity, user_emotion FROM agent_state').get()
  assert.equal(row.mood_intensity, 6)
  assert.equal(row.prev_mood_intensity, 4)
  assert.equal(row.user_emotion, 'tired')
  s.close()

  // 读侧(emotionStates):列里是 NULL(老库 / 显式写空)⇒ 同样回数据初值
  const s2 = openStore(':memory:')
  insertBareStateRow(s2)
  const rows = s2.emotionStates(5)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].moodIntensity, 6)
  assert.equal(rows[0].prevMoodIntensity, 4)
  assert.equal(rows[0].userEmotion, 'tired')

  // 好感度初值:建行(setName)与改行(saveProfileTraits)两条路都带 70
  s2.setName('阿岚')
  assert.equal(s2.db.prepare('SELECT affinity FROM user_profile WHERE user_id = ?').get('master').affinity, 70)
  s2.saveProfileTraits({ 语言: '中文' })
  const p = s2.db.prepare('SELECT name, affinity FROM user_profile WHERE user_id = ?').get('master')
  assert.equal(p.affinity, 70, '改行不许把好感度打回 DDL 默认')
  assert.equal(p.name, '阿岚')
  s2.close()

  // 反思产出(reflect.normalizeExtract):模型漏字段时兜底值也是 6;钳位 1/10 仍是形状
  assert.equal(normalizeExtract({ mood_intensity: 'x' }).moodIntensity, 6)
  assert.equal(normalizeExtract({}).moodIntensity, 6)
  assert.equal(normalizeExtract({ mood_intensity: 99 }).moodIntensity, 10)
  assert.equal(normalizeExtract({ mood_intensity: -5 }).moodIntensity, 1)
})

test('文件不在 / 坏:逐位回到迁移前的字面值(3 / 3 / neutral / 50)', () => {
  rmSync(join(dir, 'state-defaults.json'), { force: true })

  const s = openStore(':memory:')
  assert.equal(s.getState().moodIntensity, 3, '缺文件 ⇒ 3')
  assert.equal(s.getState().prevMoodIntensity, 3)
  assert.equal(s.getState().userEmotion, 'neutral')
  s.saveState({ moodIntensity: 0, prevMoodIntensity: 0, userEmotion: '' })
  const row = s.db.prepare('SELECT mood_intensity, prev_mood_intensity, user_emotion FROM agent_state').get()
  assert.equal(row.mood_intensity, 3)
  assert.equal(row.prev_mood_intensity, 3)
  assert.equal(row.user_emotion, 'neutral')
  s.close()

  const s2 = openStore(':memory:')
  insertBareStateRow(s2)
  const rows = s2.emotionStates(5)
  assert.equal(rows[0].moodIntensity, 3)
  assert.equal(rows[0].prevMoodIntensity, 3)
  assert.equal(rows[0].userEmotion, 'neutral')
  // affinity:不写这一列 ⇒ DDL 的 DEFAULT 50 兜底(结构默认留 schema)
  s2.setName('阿岚')
  assert.equal(s2.db.prepare('SELECT affinity FROM user_profile WHERE user_id = ?').get('master').affinity, 50)
  s2.close()

  assert.equal(normalizeExtract({}).moodIntensity, 3)

  // 坏文件 = 没有数据(不抛、不判坏),行为与"文件不在"一致
  writeStateDefaults('{ 这不是 json')
  const s3 = openStore(':memory:')
  assert.equal(s3.getState().moodIntensity, 3)
  s3.saveState({ moodIntensity: NaN })
  assert.equal(s3.db.prepare('SELECT mood_intensity FROM agent_state').get().mood_intensity, 3)
  s3.setName('阿岚')
  assert.equal(s3.db.prepare('SELECT affinity FROM user_profile WHERE user_id = ?').get('master').affinity, 50)
  s3.close()
  // 认不出的读数 ⇒ 兜底 3(注意 `null` 是**老行为**里就有的特例:Number(null)=0,
  // 会被钳到下限 1 —— 那是钳位形状的事,不是初值,这里不碰)
  assert.equal(normalizeExtract({ mood_intensity: 'x' }).moodIntensity, 3)
})

test('追加(§2.1 row 18/19 + reflect:124):夜闸钟面 / 过期阈值 / emotion_score 兜底也吃数据,空则逐位不变', () => {
  // ① 文件都不在 ⇒ 出厂 23~8 / 24 小时 / 3(与迁移前逐位一致)
  rmSync(join(dir, 'state-defaults.json'), { force: true })
  rmSync(join(dir, 'graph.json'), { force: true })
  rmSync(join(dir, 'config.json'), { force: true })
  assert.deepEqual(nightHoldWindow(), { fromHour: 23, toHour: 8 })
  assert.equal(isNightHour(new Date(2026, 0, 1, 23, 30)), true)
  assert.equal(isNightHour(new Date(2026, 0, 1, 7, 59)), true)
  assert.equal(isNightHour(new Date(2026, 0, 1, 8, 0)), false)
  assert.equal(isNightHour(new Date(2026, 0, 1, 22, 59)), false)
  assert.equal(isWakeStale({ atSec: NOW - 3 * H, nowSec: NOW }).stale, false, '晚 3 小时 < 24 ⇒ 照响')
  assert.equal(isWakeStale({ atSec: NOW - 30 * H, nowSec: NOW }).stale, true)
  assert.equal(isWakeStale({ atSec: NOW - Math.round(8.5 * H), nowSec: NOW, staleHours: 0 }).stale, false,
    '门槛填 0 ⇒ 回出厂 24 小时')
  assert.equal(normalizeExtract({}).emotionScore, 3)

  // ② 有值:窗口 22~6、阈值 6 小时、兜底分 6
  writeGraph({ schemaRev: 1, windows: { nightHoldFromHour: 22, nightHoldToHour: 6 } })
  writeStateDefaults({ schemaRev: 1, moodIntensity: 6 })
  writeSettings({ staleHours: 6 })
  assert.deepEqual(nightHoldWindow(), { fromHour: 22, toHour: 6 })
  assert.equal(isNightHour(new Date(2026, 0, 1, 22, 0)), true)
  assert.equal(isNightHour(new Date(2026, 0, 1, 5, 59)), true)
  assert.equal(isNightHour(new Date(2026, 0, 1, 6, 0)), false)
  assert.equal(isNightHour(new Date(2026, 0, 1, 12, 0)), false)
  assert.equal(isWakeStale({ atSec: NOW - Math.round(8.5 * H), nowSec: NOW }).stale, true, '阈值 6 ⇒ 晚 8.5 小时作废')
  assert.equal(isWakeStale({ atSec: NOW - 30 * H, nowSec: NOW, staleHours: 0 }).stale, true)
  assert.equal(normalizeExtract({}).emotionScore, 6)
  assert.equal(normalizeExtract({ emotion_score: 0 }).emotionScore, 1, '钳位 1/10 仍是形状')

  // ③ 坏文件 / 越界 ⇒ 回出厂值(坏数据不许把夜闸判据带崩,也不许判成"一律作废")
  writeGraph('{ 这不是 json')
  writeSettings({ staleHours: -3 })
  assert.deepEqual(nightHoldWindow(), { fromHour: 23, toHour: 8 })
  assert.equal(isWakeStale({ atSec: NOW - 30 * H, nowSec: NOW, staleHours: 0 }).stale, true, '≤0 ⇒ 回出厂 24 小时')
  writeGraph({ schemaRev: 1, windows: { nightHoldFromHour: 99, nightHoldToHour: 'x' } })
  assert.deepEqual(nightHoldWindow(), { fromHour: 23, toHour: 8 }, '越界钟点 / 非数字 ⇒ 回出厂值')
})

/**
 * 2026-10-10 笔 3(B-2 的验证步):**衰减基线也吃 `state-defaults.json`**。
 *
 * 为什么值得单独一条:调研的结论是"所有先例都真的走到基线,只有 Echo 卡在出厂 8.0"
 * —— 而修法**不需要改代码**(`lib/emotion.js:208` 的 `const base =
 * defaultEmotionVector().target_master` 本来就走这条路)。
 * 所以这条测试要证明的是:**数据能改变那条下界**,而不是"代码改对了"。
 *
 * 三个断言点:
 *   ① 给 6.0 ⇒ 基线就是 6.0(不是出厂 8.0);
 *   ② 衰减足够久 ⇒ 收敛到 6.0(证明 `decayedEmotionVector` 真的用了它);
 *   ③ 文件缺 / 坏 ⇒ 回出厂 8.0(降级不许把衰减带崩)。
 *
 * ⚠️ 写文件必须走 `writeFileSync(..., 'utf8')`(**无 BOM**)。用带 BOM 的写法
 * (如 PowerShell 5.1 的 `Set-Content -Encoding UTF8`)会让 `JSON.parse` 直接抛,
 * 而 `readJsonObject` 会**静默降级回出厂值、不报错** —— 正是这类测试要挡的坑。
 */
test('2026-10-10 笔 3:衰减基线吃 state-defaults.json.emotionVector(**数据能改变下界**)', () => {
  const high = () => ({
    global: { fatigue: 2, valence: 2, arousal: 3 },
    target_master: { affection: 9.0, playfulness: 7.0, sadness: 0.0, dependency: 6.0 }
  })

  // ① + ② 给 6.0:默认向量与"衰减足够久"都必须落到 6.0
  writeStateDefaults({ schemaRev: 1, emotionVector: { target_master: { affection: 6.0 } } })
  assert.equal(defaultEmotionVector().target_master.affection, 6.0,
    'state-defaults 给的爱意初值没被读 —— 数据→基线的通路断了')
  const converged = decayedEmotionVector(high(), 1000)
  assert.equal(converged.target_master.affection, 6.0,
    '衰减没收敛到数据给的基线(仍是出厂 8.0)= 下界还是卡死的')
  // 未被点名的维度仍旧出厂值(只覆盖给了的)
  assert.equal(converged.target_master.playfulness, 7.0, '没给的维度不许被顺手改掉')

  // ③ 文件缺 ⇒ 回出厂 8.0(降级,不抛)
  rmSync(join(dir, 'state-defaults.json'), { force: true })
  assert.equal(defaultEmotionVector().target_master.affection, 8.0)
  assert.equal(decayedEmotionVector(high(), 1000).target_master.affection, 8.0)

  // ③' 坏文件(含 BOM 的那种坏法)⇒ 同样回出厂 8.0,不抛
  writeStateDefaults('\uFEFF' + JSON.stringify({ schemaRev: 1, emotionVector: { target_master: { affection: 6 } } }))
  assert.equal(decayedEmotionVector(high(), 1000).target_master.affection, 8.0,
    '带 BOM 的坏文件该静默降级回出厂(这正是写入侧必须无 BOM 的理由)')

  // ④ 越界 / 非数字 ⇒ 非数字被丢弃(回出厂),越界被 **clampDim 夹取**
  //    (不是丢弃:`lib/emotion.js:98-104` 是 Math.max/Math.min ⇒ 99 变 10)。
  //    两种都是既有口径,这里钉住,免得以后有人以为是"越界丢弃"。
  writeStateDefaults({ schemaRev: 1, emotionVector: { target_master: { affection: 99, playfulness: 'x' } } })
  assert.equal(defaultEmotionVector().target_master.affection, 10.0, '越界值该被夹到上界 10,不是丢弃')
  assert.equal(defaultEmotionVector().target_master.playfulness, 7.0, '非数字该被丢弃、回出厂 7.0')

  rmSync(join(dir, 'state-defaults.json'), { force: true })
})
