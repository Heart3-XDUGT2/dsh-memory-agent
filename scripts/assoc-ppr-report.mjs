/**
 * A6b:只读 PPR 报表(同域联想)+ 真数据抽样 + 既有检索台不退化。
 *
 * 这一期**只出报表**:PPR 不接进 prompt(接线是另一次独立裁决)。
 * 这个脚本只做编排 —— 排名 / 路径 / hub 对照 / 时间邻近候选全在引擎侧
 * (`python/engine/ppr.py`),免得出现第二份口径。
 *
 * 用法(在 dsh-echo 根目录):
 *   node scripts/assoc-ppr-report.mjs --db <库> --seed KARDS        # 单个种子
 *   node scripts/assoc-ppr-report.mjs --db <库> --query "KARDS 那个卡组" --json
 *   node scripts/assoc-ppr-report.mjs --db <库> --from-audit 12      # 拿 12 条**真实提问**跑
 *   node scripts/assoc-ppr-report.mjs --db <库> --from-audit 12 --bench   # 顺手量既有检索台
 *
 * ⚠️ 默认拿 `--db` 指的库(**演练一律用 .scratch 副本**);本脚本自己不开库、不写库。
 * ⚠️ `--bench` 跑的是 `scripts/retrieval-bench.py`(只读),它的分档**不该**因为本期动过 ——
 *    本期一个字都没接进检索路径,所以这一跑的作用是"留一份当前基线数"。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const has = (k) => argv.includes(k)
const val = (k, d = null) => {
  const i = argv.indexOf(k)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d
}

const db = val('--db', join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'echo', 'echo.db'))
const fromAudit = val('--from-audit')
const outJson = val('--out', join(REPO, '.scratch', 'ppr-report.json'))
if (!existsSync(db)) {
  console.error('[PPR] 库不存在:' + db + '(用 --db 指路;演练请用 .scratch 副本)')
  process.exit(2)
}
mkdirSync(join(REPO, '.scratch'), { recursive: true })

const pargs = ['-m', 'engine.ppr', '--db', db, '--top', val('--top', '10')]
if (val('--seed')) pargs.push('--seed', val('--seed'))
if (val('--query')) pargs.push('--query', val('--query'))
if (fromAudit) pargs.push('--from-audit', fromAudit)
if (has('--no-fact')) pargs.push('--no-fact')
if (has('--no-cooc')) pargs.push('--no-cooc')
if (has('--json')) pargs.push('--json')
if (has('--report')) pargs.push('--report', val('--report'))

console.log('== A6 只读 PPR 报表(不写库 · 不进 prompt)==')
console.log('  库:' + db)
const r = spawnSync('python', pargs, { cwd: join(REPO, 'python'), stdio: 'inherit' })
if (r.error) {
  console.error('[PPR] 起不了 python:' + r.error.message)
  process.exit(1)
}
if (r.status !== 0) {
  console.error('[PPR] 引擎退出码 ' + r.status + ' —— 上面有它的原话')
  process.exit(r.status || 1)
}

if (has('--bench')) {
  console.log('\n== 既有检索台(只读;本期没接进检索路径,这一跑是留基线)==')
  const b = spawnSync('python', [join(REPO, 'scripts', 'retrieval-bench.py'), '--db', db],
    { cwd: REPO, stdio: 'inherit' })
  if (b.status !== 0) console.error('[PPR] 检索台退出码 ' + b.status)
}

console.log('\n报表 JSON(要留档就加 --json,或看 ' + outJson + ' 附近的产物)')
console.log('⚠️ 本阶段**不接进 prompt**:接线要单独裁决。')
