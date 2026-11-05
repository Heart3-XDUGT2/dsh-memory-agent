/**
 * dsh-echo — 她的自由活动(P4a:让「她真产出素材」存在)
 * ============================================================
 * 出处:`docs/PLAN_PROACTIVE_TOPIC_SCORER.md` §2.1(候选来源表的第三行:
 * 「她的自由活动产出 —— 日记、工作目录里的文件」)、§7(不做的事)、
 * P4 那一期;施工图 §2.8 的 P4 行、§3.5 决定④(P4 要做,但必须带
 * `self-activity` 来源标记 + 预算 + 静默 + 清理,不得污染主记忆)。
 *
 * 要解决的问题(概念稿 §4 那条分界线):「我拍了张自拍,想看吗」(FOMO 钩子,
 * 编的)与「我有件事给你看」(真做过)表面一模一样 —— **区别是后者真的做了
 * 那件事**。可是 `~/.dsh/echo/workspace` 一直是**空目录**,所以那条分界线
 * 此前**根本不存在**:她没有任何"真做过"的东西可以拿出来。
 * 本模块就让"真产出"存在:她会按空闲自己写一页,而且那一页**真的落在盘上**。
 *
 * 本模块只做四件事(全部可离线测,零模型调用):
 *   ① `planActivityTick` —— **纯函数**判据:这一拍该不该动(空闲/夜间/额度/防重复);
 *   ② `writeActivityFile` / `pruneActivityFiles` —— 产出落盘 + 上限清理;
 *   ③ `listActivityNotes` —— 把盘上的产出读成**候选**(`note:` 前缀 + `source:'self-activity'`);
 *   ④ 文件名规则一处写死(`<类型前缀>-YYYY-MM-DD.md`),别的模块别拼字符串。
 *
 * # P4b:多了活动类型(但**没有**多出模型调用点)
 * `kind` 的允许值域从 `diary` 扩到 `diary | memory`(见 `ACTIVITY_FILE_PREFIXES`),
 * 每一类对应一个文件名前缀(`日记-` / `整理-`),上限清理**共用**一份(见
 * `pruneActivityFiles`:她自己的产出总数封顶,不按类型各留一份)。
 * 判据 `planActivityTick` **与类型无关**(它判的是"该不该动");防重复那一格
 * (`activityFileExists`)是**按类型**判的 —— 今天写过日记,不等于整理做过了。
 *
 * 两条**硬约束**照旧(施工图 §3.5 + 本次任务的硬约束):
 *   · `diary` 一类复用的是日记管线那次**既有**的模型调用(`composeDiary`);
 *   · `memory`(整理记忆)一类**一个模型都不调** —— 它复用的是既有的
 *     **策展管线**(`lib/soul-snapshot.js` 的只读快照 + `lib/curation.js` 的
 *     `composeCuratedText`,压缩域那一次已在使用),所以本模块仍保持"零模型调用"。
 *     换言之:新增类型**不许**顺手新造一个组稿提示词/调用点。
 *
 * 四条纪律(与施工图 §3.5 卫生纪律同源,逐条落在这里):
 *   · **默认关**:整组挂在 `herActivity.enabled`(默认 false)后面,关着 = 零行为变化;
 *   · **不新增模型调用点**:真正的组稿**不在这里** —— 它复用日记管线那次已有的
 *     调用(`lib/diary.js` 的 `composeDiary`,由壳执行,见 `lib/index.js` 的
 *     `runHerActivity`);本模块一个模型都不调;
 *   · **不污染主记忆**:产出只落**文件**+台账;这里既不碰 `episodic_memory`、
 *     也不碰图谱与 L0(见 `# 防污染`);
 *   · **失败即不动**:落盘失败只回 `{ok:false}`,不抛 —— 她的心跳不该因为
 *     写不进一个文件而整拍炸掉(那正是 45 小时静默的同科)。
 *
 * # 防污染(为什么候选 id 必须用独立前缀)
 * 判据不是"内容像不像她写的",而是**数据层面可识别**:产出文件的候选 id 一律
 * `note:` 开头,并带 `source:'self-activity'`。于是:
 *   · 候选池里第四类来源一眼可查(与前缀 `thread:` / `mem:` / `diary:` 并列);
 *   · 台账/报告里能按来源 GROUP BY;
 *   · 真出问题时,按前缀一键挑出来就是全部 —— 不需要"猜哪条是她的产出"。
 * 类型仍记 `artifact`(方案 A 里 `artifact` 那条线 = "她真有产出",具体性满分),
 * 这样**不新增配置键**就接进了既有的分类型阈值(`thresholdArtifact`)。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { composeCuratedText } from './curation.js'

/** 出厂配置(必须与 `lib/toggle.js SETTINGS_DEFAULTS.herActivity` 同值)。 */
export const HER_ACTIVITY_OFF = Object.freeze({
  enabled: false,        // 总闸:关着时心跳一个字都不做(零行为变化)
  budgetPerDay: 1,       // 一天最多做几次(0 = 等于关掉;**多类型共用这一份额度**)
  idleMin: 30,           // 他安静多久她才自己找活干(分钟)
  quietHoursSameAsCare: true, // 沿用夜闸口径(23~8 点不做)
  kind: 'diary'          // 做什么:P4a diary(写一页)/ P4b memory(整理记忆)
})

/** 产出文件的保留上限(超出删最旧)—— 不许无限长大。**各类型共用**这一份。 */
export const ACTIVITY_KEEP_DEFAULT = 30

/**
 * 活动类型 → 产出文件名前缀(**单一事实源**,别的模块别拼字符串)。
 * 加一类就在这里加一行,`activityFileName` / 读回 / 上限清理都会跟着认。
 */
export const ACTIVITY_FILE_PREFIXES = Object.freeze({
  diary: '日记-',   // 复用日记管线那次既有调用(组稿 = composeDiary)
  memory: '整理-'   // 整理记忆:只读快照 + 策展渲染(**零模型调用**)
})

/** 认得的活动类型(配置面板/文档用;顺序即出厂注释顺序)。 */
export const ACTIVITY_KINDS = Object.freeze(Object.keys(ACTIVITY_FILE_PREFIXES))

/** 出厂类型(`herActivity.kind` 的兜底;认不出的值在这里落回它)。 */
export const ACTIVITY_KIND_DEFAULT = 'diary'


const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/
/** `<前缀>-YYYY-MM-DD.md`;前缀认不出(不是她的产出)⇒ 读回时一律跳过。 */
const ACTIVITY_FILE_RE = /^(.+)-(\d{4}-\d{2}-\d{2})\.md$/

/**
 * 台账用词(**只许枚举**,照 `docs/DISCIPLINE.md` 第一条:reason 要能 GROUP BY)。
 * 名字与施工图 §⑤ 点名的那几个词一致(`idle-done` / `budget-used` / `not-idle` /
 * `night-hold` / `failed`),多出来的两个(`already-done` / `busy`)是判据里
 * 真实存在的两条路 —— 少记一条就等于"她没做"这件事查不出原因。
 */
export const ACTIVITY_REASONS = Object.freeze({
  done: 'idle-done',        // 做了,而且产出落了盘
  budget: 'budget-used',    // 今天的额度用完了
  already: 'already-done',  // 今天已经做过这件事(防重复)
  night: 'night-hold',      // 夜闸压住(与 care/wake 同款词)
  busy: 'busy',             // 她手上有没干完的活
  notIdle: 'not-idle',      // 离他上一句话太近(不打扰)
  failed: 'failed'          // 没做成(组稿失败/落盘失败/这一档没实现)
})

function num (v, d = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 归一一个类型名:去空白、小写;认不出(不在 `ACTIVITY_FILE_PREFIXES` 里)⇒ 空串。 */
export function activityKindOf (kind) {
  const k = String(kind ?? '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(ACTIVITY_FILE_PREFIXES, k) ? k : ''
}

/** 文件名主干 → 类型(读回时用;认不出 ⇒ 空串 = 不是她的产出)。 */
export function activityKindFromName (name) {
  const s = String(name ?? '')
  for (const [kind, prefix] of Object.entries(ACTIVITY_FILE_PREFIXES)) {
    if (s.startsWith(prefix)) return kind
  }
  return ''
}

/**
 * 日期键 + 类型 → 产出文件名;认不出(空/不是 YYYY-MM-DD/类型不认识)⇒ 空串
 * (调用方按"没有"处理)。
 */
export function activityFileName (dateKey, kind = ACTIVITY_KIND_DEFAULT) {
  const key = String(dateKey ?? '').trim()
  const k = activityKindOf(kind)
  if (!DATE_KEY_RE.test(key) || k === '') return ''
  return ACTIVITY_FILE_PREFIXES[k] + key + '.md'
}

/** 今天的产出文件在不在(防重复的判据)—— **按类型**判:写过日记 ≠ 整理过。 */
export function activityFileExists (dir, dateKey, kind = ACTIVITY_KIND_DEFAULT) {
  const name = activityFileName(dateKey, kind)
  const root = String(dir ?? '')
  if (name === '' || root === '') return false
  try { return existsSync(join(root, name)) } catch { return false }
}

/**
 * 这一拍该不该动 —— **纯函数**(`now` 一律由调用方喂,不看真表、不摸盘)。
 *
 * 判定顺序(每条都留 reason,便于"为什么没做"可查):
 *   ① 额度(`budgetPerDay`)→ ② 防重复(今天已经做过)→ ③ 夜闸 → ④ 进行中的活
 *   → ⑤ 空闲下界(离他上一句太近 = 不打扰)。
 *
 * **本函数与类型无关**(它判的是"该不该动",不是"动哪一类"):`kind` 只影响
 * `doneToday` 那一格的读数(调用方按配置的那一类去问 `activityFileExists`)与
 * `budgetPerDay` 的口径 —— 多类型**共用一份日额度**(见 `HER_ACTIVITY_OFF`:
 * 额度是"她今天自己找过几次活干",不是"每一类各几次";按类分额会凭空多出
 * 配置键,而 `herActivity.kind` 本来就是单值 —— 一天只会做一类)。
 *
 * 空闲的**没有读数**怎么办:`lastUserAtSec <= 0`(= 他这几天一句话没说,或日志里
 * 查不到)按"够安静"处理 —— 这一档判的是"他不在",不是"他刚刚说过话";
 * 反过来把它读成"不安静"的话,她一个人待着的时候**永远**动不了(那正是
 * "45 小时静默"的同科:一个缺读数把整条路憋死)。
 *
 * @param {{nowMs?:number, dateKey?:string, cfg?:object, lastUserAtSec?:number,
 *          usedToday?:number, doneToday?:boolean, busy?:boolean, isNight?:boolean}} [inputs]
 * @returns {{action:'run'|'skip', reason:string, dateKey:string, idleMin:number,
 *            idleSec:number|null, budget:number, usedToday:number}}
 */
export function planActivityTick (inputs = {}) {
  const i = (inputs !== null && typeof inputs === 'object') ? inputs : {}
  const c = (i.cfg !== null && typeof i.cfg === 'object') ? i.cfg : {}
  const nowMs = num(i.nowMs, 0)
  const nowSec = nowMs / 1000
  const lastSec = num(i.lastUserAtSec, 0)
  const idleSec = (lastSec > 0 && nowSec > 0) ? Math.max(0, nowSec - lastSec) : null
  const budget = Math.max(0, Math.round(num(c.budgetPerDay, HER_ACTIVITY_OFF.budgetPerDay)))
  const idleMin = Math.max(0, num(c.idleMin, HER_ACTIVITY_OFF.idleMin))
  const usedToday = Math.max(0, Math.round(num(i.usedToday, 0)))
  const base = {
    dateKey: String(i.dateKey ?? ''), idleMin, idleSec, budget, usedToday
  }
  if (budget <= 0 || usedToday >= budget) return { action: 'skip', reason: ACTIVITY_REASONS.budget, ...base }
  if (i.doneToday === true) return { action: 'skip', reason: ACTIVITY_REASONS.already, ...base }
  if (i.isNight === true) return { action: 'skip', reason: ACTIVITY_REASONS.night, ...base }
  if (i.busy === true) return { action: 'skip', reason: ACTIVITY_REASONS.busy, ...base }
  if (idleSec !== null && idleMin > 0 && idleSec < idleMin * 60) {
    return { action: 'skip', reason: ACTIVITY_REASONS.notIdle, ...base }
  }
  return { action: 'run', reason: ACTIVITY_REASONS.done, ...base }
}

/**
 * 盘上的产出文件(最旧在前;`dateKey` 是文件名里的那一天,天然可排序)。
 * 目录不在/读不动 ⇒ `[]`(**永不抛** —— "这一档今天没有产出"不是"这一拍炸了")。
 * 每一份都带 `kind`(认不出前缀的杂物一律跳过,不认成素材)。
 */
export function listActivityFiles (dir) {
  const root = String(dir ?? '')
  if (root === '') return []
  let names = []
  try { names = readdirSync(root) } catch { return [] }
  const out = []
  for (const name of names) {
    const m = ACTIVITY_FILE_RE.exec(String(name))
    if (m === null) continue // 不是她的产出(别的文件一律不认,免得把杂物当素材)
    const kind = activityKindFromName(name)
    if (kind === '') continue // 前缀认不出(比如 `readme-2026-09-28.md`)⇒ 也不是她的产出
    const path = join(root, name)
    let at = 0
    try {
      const st = statSync(path)
      if (st.isFile() !== true) continue
      at = Number(st.mtimeMs) || 0
    } catch { continue }
    out.push({ name, kind, dateKey: m[2], path, at })
  }
  return out.sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : (a.name < b.name ? -1 : 1)))
}

/**
 * 上限清理:最多留最近 `keep` 份,超出删**最旧**的。
 * 返回 `{removed, failed, kept}`;删不动只记数,**不抛**(清不掉最多是占地方,
 * 不该惊动她的心跳)。
 *
 * ⚠️ **各类型共用这一份上限**(不按类型各留一份):总量封顶才是"她的工作目录
 * 不许无限长大"的本意;按类分额会在 `kind` 换一次之后凭空多出一倍的目录体积。
 */
export function pruneActivityFiles (dir, { keep = ACTIVITY_KEEP_DEFAULT } = {}) {
  const k = Math.max(0, Math.round(num(keep, ACTIVITY_KEEP_DEFAULT)))
  const files = listActivityFiles(dir)
  const overflow = Math.max(0, files.length - k)
  let removed = 0
  let failed = 0
  for (let n = 0; n < overflow; n++) {
    try { unlinkSync(files[n].path); removed += 1 } catch { failed += 1 }
  }
  return { removed, failed, kept: files.length - removed }
}

/**
 * 产出落盘(**额外一步**,失败只记痕不抛)。
 *
 *   · 内容 = 当天产出正文,**原样写**(不给它加前后缀 —— 素材是素材);
 *   · **UTF-8 无 BOM**(`writeFileSync` 不写 BOM);空内容视为失败(不落空文件);
 *   · 文件名 = `activityFileName(dateKey, kind)`(类型不认识 ⇒ `bad-path`,不硬拼);
 *   · 写成功之后顺手清理上限(新写的这份算在 `keep` 里)。
 *
 * @returns {{ok:boolean, path:string, error?:string, removed?:number, kept?:number, pruneFailed?:number}}
 */
export function writeActivityFile (dir, { dateKey = '', content = '', keep = ACTIVITY_KEEP_DEFAULT, kind = ACTIVITY_KIND_DEFAULT } = {}) {
  const root = String(dir ?? '')
  const name = activityFileName(dateKey, kind)
  const body = String(content ?? '')
  if (root === '' || name === '') return { ok: false, path: '', error: 'bad-path' }
  if (body.trim() === '') return { ok: false, path: '', error: 'empty-content' }
  const path = join(root, name)
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(path, body, 'utf8')
  } catch (err) {
    return { ok: false, path, error: String(err?.message ?? err) }
  }
  const pruned = pruneActivityFiles(root, { keep })
  return { ok: true, path, removed: pruned.removed, kept: pruned.kept, pruneFailed: pruned.failed }
}

/**
 * 把盘上的产出读成**候选**(第四类来源 `note:`;供 `lib/topic-score.js` 组卷)。
 *
 * 与其它三类来源同一条纪律:读不到/目录不在 ⇒ `[]`,**不抛**;
 * `nowMs` 没给(0)⇒ **不判窗口**(宁可多收,也不许拿本机时钟当判据)。
 * `createdAt` 取文件 mtime(秒)—— 这是"她什么时候做的"唯一诚实读数。
 *
 * 候选 id = `note:` + **文件名主干**(`note:日记-2026-09-28` / `note:整理-2026-09-28`)。
 * P4a 时一天只有一页,id 用日期就够;P4b 多类之后,"哪一类"是键的一部分
 * —— 同一个日期可能有不止一份产出(他中途换过类型),用日期当 id 会撞车。
 * 契约没变:一律 `note:` 开头(见 CHANGELOG「第四批」)且带 `source:'self-activity'`;
 * `kind` / `dateKey` 也一并透出来,台账里可按类型 GROUP BY。
 *
 * @returns {Array<{id:string, type:'artifact', text:string, createdAt:number,
 *                  hasArtifact:boolean, source:'self-activity', kind:string, dateKey:string}>}
 */
export function listActivityNotes (dir, { limit = 50, nowMs = 0, windowHours = 0 } = {}) {
  const cap = Math.max(1, Math.min(200, Math.round(num(limit, 50)) || 50))
  const nowSec = num(nowMs, 0) / 1000
  const windowSec = Math.max(0, num(windowHours, 0)) * 3600
  const out = []
  const files = listActivityFiles(dir).reverse() // 新的在前(候选池的习惯:越新越靠前)
  for (const f of files) {
    if (out.length >= cap) break
    let body = ''
    try { body = readFileSync(f.path, 'utf8') } catch { continue }
    // 自己写的时候不带 BOM;万一外部工具写进了 BOM,这里容错剥掉(不许把 U+FEFF 当正文)
    const text = String(body ?? '').replace(/^\uFEFF/, '').trim()
    if (text === '') continue
    const createdAt = f.at > 0 ? f.at / 1000 : 0
    if (nowSec > 0 && windowSec > 0 && createdAt > 0 && nowSec - createdAt > windowSec) continue
    out.push({
      id: 'note:' + String(f.name).replace(/\.md$/, ''),
      type: 'artifact',
      text,
      createdAt,
      hasArtifact: true,
      source: 'self-activity',
      kind: f.kind,
      dateKey: f.dateKey
    })
  }
  return out
}

// ---- P4b:「整理记忆」那一类的正文(**零模型调用**)------------------------------
//
// 为什么这一类能加(而"给自己立小目标"不能):它有一条**既有的**管线可复用 ——
// `lib/soul-snapshot.js readSoulSnapshot()`(只读快照,`node:sqlite` readOnly)
// + `lib/curation.js composeCuratedText()`(纯函数,把快照渲染成一页策展文本),
// 压缩域(`lib/compaction.js:99-100`)早就在用同一条。于是"整理"这一类的正文
// **一个模型都不调**,也就没有新增调用点 —— 这正是硬约束要的那件事。
//
// 反过来说:这条管线**只读**(readOnly 打开、不写 episodic_memory/图谱),
// 所以 P4a 那条"不污染主记忆"的纪律也自动成立。

/**
 * 快照里**有没有东西**可整理(库不在 / 全是 0 ⇒ 空)。
 * 判据只认"她真的有过去的痕迹":有记忆、聊过、或有该活下来的那几件。
 */
export function hasSnapshotData (snapshot) {
  const rows = (snapshot !== null && typeof snapshot === 'object') ? snapshot : {}
  const counts = (rows.counts !== null && typeof rows.counts === 'object') ? rows.counts : {}
  if (Number(counts.memories) > 0 || Number(counts.turns) > 0) return true
  return Array.isArray(rows.moments) && rows.moments.length > 0
}

/**
 * 整理那一页的正文:拿一份 `readSoulSnapshot()` 的行,渲染成策展文本。
 * 快照空(库不在/一页都没得整理)⇒ **空串**(执行体按"没做成"记 failed ——
 * 不许拿 `fallbackText()` 那段"库没读到"冒充她的整理)。
 *
 * 纯函数(给行不给连接),可离线测;`now` 由调用方喂(秒)。
 *
 * @param {object} snapshot `readSoulSnapshot()` 的返回值
 * @param {{now?:number, budgetTokens?:number, maxThreads?:number, maxMoments?:number}} [opts]
 * @returns {string} 整理正文;空串 = 这一类今天没东西可整理
 */
export function composeTidyText (snapshot, opts = {}) {
  const o = (opts !== null && typeof opts === 'object') ? opts : {}
  if (!hasSnapshotData(snapshot)) return ''
  const budgetTokens = num(o.budgetTokens, 0)
  try {
    return String(composeCuratedText(snapshot, {
      now: num(o.now, 0) || undefined,
      ...(budgetTokens > 0 ? { budgetTokens } : {}),
      ...(Number(o.maxThreads) > 0 ? { maxThreads: Math.round(Number(o.maxThreads)) } : {}),
      ...(Number(o.maxMoments) > 0 ? { maxMoments: Math.round(Number(o.maxMoments)) } : {})
    }) ?? '').trim()
  } catch { return '' }
}
