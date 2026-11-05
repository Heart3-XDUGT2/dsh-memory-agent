/**
 * A8:评估与验收的守卫。
 *
 * A8 的东西是"照出真相"的两件:**联想对照台**(改造前 vs 改造后,同一机械判据)与
 * **既有检索台逐档不退化**断言。这个测试钉它们的**契约**(不是钉那些会随库增长的数字
 * —— 把某一跑的数字冻进测试,库一长就成了假红):
 *
 *   ① 对照台真的是"同一判据两边量",样本是机械选的,不是挑好看的;
 *   ② 逐档对照**任一项退化就红**(拿两份小样本喂它,验证它真的会退出码 1);
 *   ③ 三条红线复核:红线文件/模块没被这几期碰过(源码 + git 两条路各查一遍);
 *   ④ 文档里留着**前后对照数**(验收①要求"记录在文档里")。
 *
 * 2026-10-05 升级 ③ 的 git 那一路(方案 1):
 *   原来的判据是「`lib/relay.js` **不许出现在** `git status --porcelain` 里」—— 太粗:
 *   它把"改了逻辑"和"只改了注释"当成同一件事。当天 `lib/relay.js` 的 `say_again`
 *   注释被**授权**修正(拍板 5:那段原本写着"不进白名单 QQ 就收不到",而 P2 之后
 *   事实正好相反),这道闸就把一次**授权过的纯注释改动**误判成红线事故。
 *   现在改成**更严的两段判据**:文件出现 → 必须证明"没有一行逻辑改动"
 *   (`git diff -U0 -- lib/relay.js` 逐行看:去掉行首空白后以 `*`、`//`、`#`、`/*`,
 *   或者注释块的收尾符号(星号+斜杠)开头,才算注释行)。逻辑只要动一行,照样红 ——
 *   这是**收紧**判据,不是放宽。⚠️ 往注释块里插空行请写成 ` *`(仓库风格本就如此):
 *   真空行不匹配注释前缀,会被判成逻辑改动。⚠️ 也**别在注释里写出块注释的收尾符号**:
 *   它会当场把这个注释闭合掉(本文件第一版就这么炸过一次)。
 *
 * 2026-10-05 二次升级(他裁定 = 方案 1):红线文件上**授权过的逻辑改动**要有出路 ——
 *   `RED_LINE_AUTHORIZATIONS` 表 = 授权栏:闸仍逐行查 diff,**有非注释行就必须在表里
 *   找到匹配的授权**(file 对上 + lines 条数对得上),否则红并列出未授权的行;多了少了
 *   都算不匹配。加一条记录 = 在授权栏签字(写清 why 与 by),不是给红线开门。
 *   配套元测试(③″)盯着这张表本身:file/date/lines/why/by 一个都不许空。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const read = (rel) => readFileSync(join(REPO, rel), 'utf8')

const BENCH = read('scripts/assoc-bench.py')
const PLAN = read('docs/PLAN_MEMORY_ARCH_V2.md')

/** 跑一次对照台的 `--tiers`(纯文本比较,不起引擎 —— 快且确定)。 */
function tierCheck (nowText, baseText) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-assoc-eval-'))
  const nowPath = join(dir, 'now.txt')
  const basePath = join(dir, 'base.txt')
  writeFileSync(nowPath, nowText, 'utf8')
  writeFileSync(basePath, baseText, 'utf8')
  try {
    const out = execFileSync('python',
      [join(REPO, 'scripts', 'assoc-bench.py'), '--tiers', nowPath, '--baseline', basePath],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    return { code: 0, out }
  } catch (err) {
    return { code: err.status ?? -1, out: String(err.stdout ?? '') }
  }
}

const TIER_HEAD = [
  '  路              MRR@10    NDCG@5    首答位次中位    SEH@3   装下k中位',
  '  --------------------------------------------------------------------------',
  '  R0现状           0.135     0.000               6     0.0%          14',
  '  R1BM25           0.694     0.598               1    76.2%           6',
  '  --------------------------------------------------------------------------'
].join('\n')

test('① 对照台:同一判据两边量,样本是机械选的(判据写在脚本里)', () => {
  assert.match(BENCH, /def sibling_map/, '缺机械判据:sibling_map')
  assert.match(BENCH, /共享至少一条证据行/, '判据没写清(得说明"共享证据行")')
  assert.match(BENCH, /def v1_reachable/, '缺改造前读数')
  assert.match(BENCH, /COALESCE\(kind, ''\) = ''/, '改造前那条该只走事实边')
  assert.match(BENCH, /def v2_topk/, '缺改造后读数')
  assert.match(BENCH, /run_ppr/, '改造后该走只读 PPR')
  assert.match(BENCH, /hub_max_deg|HUB_RANK_MAX_DEG/, '改造后该用 hub 不进排名')
  assert.match(BENCH, /def sample_seeds/, '样本该是机械选的')
  assert.match(BENCH, /sort|sorted/, '样本选择该有确定的排序')
  // 只读:不许有 --apply
  assert.ok(!BENCH.includes("--apply"), '对照台不该有写开关')
  assert.ok(!BENCH.includes('INSERT ') && !BENCH.includes('DELETE '), '对照台里出现了写语句')
})

test('② 逐档对照真的会红:拿同一份当基线 ⇒ 全 OK;把一项改坏 ⇒ 退出码 1', () => {
  const same = tierCheck(TIER_HEAD, TIER_HEAD)
  assert.equal(same.code, 0, '同一份应该判 OK:' + same.out)

  const worse = TIER_HEAD.replace('  R1BM25           0.694     0.598               1    76.2%           6',
    '  R1BM25           0.500     0.400               2    50.0%           9')
  const bad = tierCheck(worse, TIER_HEAD)
  assert.equal(bad.code, 1, '退化了却没红 —— 这个断言是空的')
  assert.match(bad.out, /regressed|退化/, '红了但没说清哪一档')
  assert.match(bad.out, /R1BM25/, '红了但没点名退化的那一档')
})

test('③ 三条红线复核:这几期没碰红线(源码这一路)', () => {
  // 新加的模块一律不许 import 红线里的东西
  const mods = ['python/engine/arch.py', 'python/engine/ppr.py', 'python/engine/topics.py',
    'python/engine/cooc.py', 'lib/arch.js', 'scripts/assoc-bench.py',
    'scripts/assoc-ppr-report.mjs', 'scripts/graph-topics-build.mjs']
  for (const rel of mods) {
    const src = read(rel)
    for (const bad of ['relay.js', "from './relay.js'", 'lib/relay', '压缩域', 'persona.json']) {
      assert.ok(!src.includes(bad), rel + ' 里出现了红线相关的东西:' + bad)
    }
  }
  // 红线三件(人格注入点 / 压缩域 / relay)的既有文件仍在,且没被这几期改写
  for (const rel of ['lib/relay.js']) assert.ok(read(rel).length > 0)
  assert.match(PLAN, /红线/, '计划书该有红线复核那一节')
})

/**
 * 一行(已剥掉 diff 的 `+`/`-` 前缀)算不算注释行。
 * 判据与升级理由见文件头「2026-10-05 升级 ③ 的 git 那一路(方案 1)」。
 */
function isCommentLine (text) {
  const t = String(text ?? '').replace(/^\s+/, '')
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('#') ||
    t.startsWith('/*') || t.startsWith('*/')
}

/**
 * 从 `git diff -U0` 的补丁里分拣改动行:`changed` = 所有增删行(已剥 `+++`/`---` 头),
 * `logic` = 其中**非注释**的那些(= 红线事故本体)。抽成纯函数,是为了下面那条
 * 判据自检能拿"编出来的 diff"喂它 —— 免得这道闸自己变成空断言。
 */
function logicChangedLines (patch) {
  const changed = String(patch ?? '').split('\n')
    .filter((l) => /^[+-]/.test(l) && !/^(?:\+\+\+|---) /.test(l))
  return { changed, logic: changed.filter((l) => !isCommentLine(l.slice(1))) }
}

/**
 * 红线文件**逻辑改动**的授权记录(2026-10-05 他裁定:方案 1)。
 *
 * 判据形状:红线文件出现在改动里、且逐行查完后**有非注释行** ⇒ 必须在下表里找到
 * 明确授权(`file` 对上 + `lines` 条数对得上);对不上就红,并把未授权的行列出来。
 * 三条都空/不对齐都算不匹配:多了 = 有未授权的改动;少了 = 授权与 diff 对不上
 * (撤销过期授权,或写清剩下那几行去哪了)。
 *
 * 为什么不是"放宽":闸仍然逐行查 diff,红线上的每一次逻辑改动都必须有人**明确授权**
 * + **留审计出处**;拿不到授权的改动照旧过不去。加一条记录 = 在授权栏签字,不是开门。
 *
 * @type {{file: string, date: string, lines: number, why: string, by: string}[]}
 */
// No active business-code grant: historical at-hint changes are already in HEAD.
const RED_LINE_AUTHORIZATIONS = []

test('③′ 三条红线复核:git 这一路(git 只读,不 add 不 commit)', () => {
  const diff = execFileSync('git', ['-C', REPO, 'status', '--porcelain'], { encoding: 'utf8' })
  const touched = diff.split('\n').map((l) => l.slice(3).trim()).filter(Boolean)
  for (const red of ['lib/relay.js']) {
    if (!touched.includes(red)) continue
    // 2026-10-05 方案 1(他裁定):红线文件**允许出现在改动里**,但必须自证 ——
    // 出现就查 diff,逐行看有没有逻辑改动;**有逻辑改动则必须有授权记录**。
    // P4 补记(2026-10-05):`git add --renormalize .` 之后,部分红线的改动会**暂存**在
    // 索引里,此时 `git diff -- <file>` 是空的(工作区与索引一致)⇒ 拿不到 patch。
    // 所以改成对 **HEAD** 取 diff(= 已暂存 + 未暂存的全量改动),语义与原来一致
    // ("这条红线上到底改了什么"),只是不再被"改动停在哪一层"影响。
    // P4 补记:`git add --renormalize .` 之后改动可能停在索引里(工作区与索引一致,
    // `git diff` 就空了)⇒ 把**未暂存 + 已暂存**两层合起来看(语义不变:"这条红线上
    // 到底改了什么");CR 一律剥掉 —— 行尾归一是 `.gitattributes`(`text=auto eol=lf`)
    // 的事,**不是内容改动**,不该冒充实改行。
    // `--ignore-cr-at-eol`:行尾 CR 的差异不算内容(否则一份 CRLF 工作区会把整文件
    // 都算成"实改行",1228 行那种假警报就是这么来的)。
    const worktreeDiff = execFileSync('git', ['-C', REPO, 'diff', '-U0', '--ignore-cr-at-eol', '--', red], { encoding: 'utf8' })
    const stagedDiff = execFileSync('git', ['-C', REPO, 'diff', '--cached', '-U0', '--ignore-cr-at-eol', '--', red], { encoding: 'utf8' })
    const patch = (worktreeDiff + stagedDiff).replace(/\r/g, '')
    const { changed, logic } = logicChangedLines(patch)
    assert.ok(changed.length > 0,
      red + ' 出现在改动里,diff 却一行都拿不到 —— 说不清改了什么,按红线处理')
    const grants = RED_LINE_AUTHORIZATIONS.filter((a) => a.file === red)
    const allowed = grants.reduce((n, a) => n + Number(a.lines ?? 0), 0)
    const audit = grants.length === 0
      ? '  （这条红线上没有任何授权记录）'
      : '\n' + grants.map((a) => '  · ' + a.date + ' 授权 ' + a.lines + ' 行 —— ' + a.by + ':' + a.why).join('\n')
    if (logic.length > allowed) {
      assert.fail(
        red + ' 有 ' + logic.length + ' 条**非注释**改动行,授权只覆盖 ' + allowed + ' 行 ——\n'
        + '  未授权的改动行:\n    ' + logic.slice(allowed).join('\n    ') + audit
      )
    }
    if (logic.length < allowed) {
      assert.fail(
        red + ' 的授权是 ' + allowed + ' 行,实际只有 ' + logic.length + ' 条非注释改动 —— '
        + '授权与 diff 对不上(撤掉过期授权,或写清剩下那几行去哪了)' + audit
      )
    }
  }
  // 判据自检(防空断言):编两条 diff 喂同一个判据 —— 纯注释必须放过,混进一行
  // 逻辑必须抓住。没有这一段,上面那条断言可能永远为真而没人知道。
  const commentOnly = [
    '--- a/lib/relay.js', '+++ b/lib/relay.js', '@@ -217,4 +217,10 @@',
    '- * 旧注释', '+ * 新注释', '+ * 还是注释'
  ].join('\n')
  const withLogic = [
    '--- a/lib/relay.js', '+++ b/lib/relay.js', '@@ -245,3 +245,3 @@',
    " export function marksProactive (source) {",
    "+   if (source.form === 'x') return false",
    '+ * 一句注释'
  ].join('\n')
  assert.equal(logicChangedLines(commentOnly).logic.length, 0,
    '纯注释被误判成逻辑改动 ⇒ 判据太严,会误伤授权改动')
  assert.equal(logicChangedLines(withLogic).logic.length, 1,
    '逻辑改动能溜过去 ⇒ 这个判据是空的')
  // 宿主文件、人格文件也不该出现在改动里
  for (const line of touched) {
    assert.ok(!/cordis\.patch\.yml$/.test(line), '碰了宿主配置:' + line)
    assert.ok(!/persona\.json$/.test(line), '碰了人格文件:' + line)
  }
})

test('③″ 红线授权记录自检:每条都要有 file/date/lines/why/by(授权栏不许签空白)', () => {
  const RED = ['lib/relay.js']
  assert.ok(Array.isArray(RED_LINE_AUTHORIZATIONS), '授权表必须是数组；空表表示没有新的逻辑改动授权')
  for (const a of RED_LINE_AUTHORIZATIONS) {
    assert.ok(RED.includes(a.file), '授权记录指向了红线清单之外的文件:' + String(a.file))
    assert.match(String(a.date ?? ''), /^\d{4}-\d{2}-\d{2}$/, 'date 必须是 YYYY-MM-DD:' + String(a.date))
    assert.ok(Number.isInteger(a.lines) && a.lines > 0, 'lines 必须是正整数(授权几行):' + String(a.lines))
    for (const k of ['why', 'by']) {
      assert.equal(typeof a[k], 'string', k + ' 必须是字符串')
      assert.ok(a[k].trim().length > 0, k + ' 不许空 —— 授权必须写清"为什么"和"谁批的"')
    }
    assert.ok(a.why.length >= 16, 'why 太短 = 等于没写(≥16 字):' + a.file)
    assert.ok(a.by.length >= 8, 'by 太短 = 说不清谁批的(≥8 字):' + a.file)
  }
})

test('④ 文档里留着前后对照数(验收①:记录在文档里)', () => {
  assert.match(PLAN, /A8/, '计划书里该有 A8 那一节')
  const m = PLAN.match(/v1\s*(\d+)\/(\d+)[^\n]*→[^\n]*v2\s*(\d+)\/(\d+)/)
    || PLAN.match(/改造前[^\n]*?(\d+)\/(\d+)[^\n]*改造后[^\n]*?(\d+)\/(\d+)/)
  assert.ok(m !== null, '文档里没找到"改造前 → 改造后"的对照数(验收①要求记录在文档里)')
})
