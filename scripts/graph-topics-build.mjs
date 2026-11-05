/**
 * A5b:主题簇的**离线**构建 —— 算簇 + 提示词供给 + 摘要填回。
 *
 * 为什么是"离线":摘要要跑 LLM,而**在线路径一个字都不许碰**(§A5 的原则)。
 * 这个脚本自己**不算簇、不校验摘要** —— 两件事都在引擎侧(`python/engine/topics.py`),
 * 因为提示词与校验规则只能有**单一出处**;这里只做编排 + 报告。
 *
 * 用法(在 dsh-echo 根目录):
 *   node scripts/graph-topics-build.mjs                      # 只读:盘点现行簇 + 出提示词包
 *   node scripts/graph-topics-build.mjs --apply              # 真算:整批换代落库(+ 出提示词包)
 *   node scripts/graph-topics-build.mjs --apply --include-fact
 *   node scripts/graph-topics-build.mjs --summaries <file>   # 把 {cluster_id: 一句话} 填回
 *   node scripts/graph-topics-build.mjs --db <path>
 *
 * 提示词包落在 `.scratch/topics-prompts.json`(gitignored):每簇一条 system + user。
 * ⚠️ **模型调用发生在宿主内**:壳侧的 LLM 通道(`lib/reflect.js:runStructured`)要
 * `subagents` 服务,离线进程拿不到 ⇒ 这个脚本只负责"把提示词递出去、把回答收回来"。
 * 递出去的对象可以是宿主的子代理、也可以是你自己 —— 回答必须是 JSON:
 *   { "summaries": { "<cluster_id>": "<一句话>" } }
 * 引擎侧**只认**它自己 `SUMMARY_MAX_CHARS` 上限内的单行文本,不合格一条都不写。
 *
 * 默认 dry-run:不 `--apply` 就只读(单测与演练都按这条纪律)。
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

const apply = has('--apply')
const summaries = val('--summaries')
const db = val('--db', join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'echo', 'echo.db'))
const scratch = join(REPO, '.scratch')
const promptsPath = join(scratch, 'topics-prompts.json')

if (has('--help') || has('-h')) {
  console.log('用法: node scripts/graph-topics-build.mjs [--db <path>] [--apply]' +
    ' [--include-fact] [--summaries <file>]')
  console.log('  默认 dry-run(只读 + 出提示词包);--apply 才整批换代落库。')
  process.exit(0)
}
if (!existsSync(db)) {
  console.error('[主题簇] 库不存在:' + db + '(用 --db 指路)')
  process.exit(2)
}

if (!existsSync(scratch)) mkdirSync(scratch, { recursive: true })

// ── 编排:真正的活全在引擎侧(提示词 / 校验 / 落库都只有一份)────────────────
const args = ['-m', 'engine.topics', '--db', db, '--prompts', promptsPath]
if (apply) args.push('--apply')
if (has('--include-fact')) args.push('--include-fact')
if (summaries) args.push('--summaries', summaries)

console.log('== A5b 主题簇' + (apply ? '(APPLY:真写)' : '(DRY-RUN:只读)') + ' ==')
console.log('  库:' + db)
console.log('  引擎:python ' + args.join(' ') + '(cwd=python/)')
const r = spawnSync('python', args, { cwd: join(REPO, 'python'), stdio: 'inherit' })
if (r.error) {
  console.error('[主题簇] 起不了 python:' + r.error.message)
  process.exit(1)
}
if (r.status !== 0) {
  console.error('[主题簇] 引擎退出码 ' + r.status + ' —— 上面有它的原话')
  process.exit(r.status || 1)
}

if (!summaries) {
  console.log('\n下一步(摘要是离线写的,**不进在线路径**):')
  console.log('  ① 把 ' + promptsPath + ' 里的每簇 system+user 交给模型(宿主子代理 / 你自己);')
  console.log('  ② 把回答存成 {"summaries": {"<cluster_id>": "<一句话>"}};')
  console.log('  ③ node scripts/graph-topics-build.mjs --summaries <那个文件>')
  if (!apply) console.log('  (想先落簇:`--apply` —— 整批换代,旧批 is_active=0)')
}
