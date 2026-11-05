/**
 * A7b:面板读口 —— 「记忆架构 v2」那一格的数据从哪来。
 *
 * 一条纪律:**判定口径只在引擎里有一份**(`python/engine/arch.py`)。
 * 这个模块只做两件事:把命令拼对、把 JSON 收回来。它自己**不判断**哪格能退、
 * 也不重算任何东西 —— 否则面板就成了"第二个判定处"。
 *
 *   * `readArchStatus({dbPath})`  → `python -m engine.arch --db <库> --json`(**只读**)
 *   * `rollbackArch({dbPath, route})` → 上面那条 + `--rollback <路线> --apply --by panel`(**写**)
 *
 * ⚠️ 两个都是**独立进程**(不是 worker 帧):面板读数不该挤在线检索那条管道上,
 * 也就不用碰 `worker.py` 的协议表。
 * ⚠️ `shadow-table` **没有回退动作**(已冻结)—— 路线白名单里就没有它 ⇒ 面板也没法误点。
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ENGINE_DIR = fileURLToPath(new URL('../python', import.meta.url))

/** 可回退的路线(**唯一出处是引擎的 `ROLLBACK_ROUTES`**;这里只是白名单,防手滑)。 */
export const ARCH_ROUTES = ['cooc-evidence', 'topic-view']

/** 拼命令(纯函数 —— 测试直接钉它,不用起进程)。 */
export function buildArchArgs ({ dbPath, route = null, apply = false, by = 'panel' } = {}) {
  const args = ['-m', 'engine.arch', '--db', String(dbPath), '--json']
  if (route) {
    args.push('--rollback', String(route))
    if (apply) args.push('--apply', '--by', String(by))
  }
  return args
}

/** 收 stdout:引擎只印一行 JSON;印了别的(警告/报错)就当失败说清楚。 */
export function parseArchOutput (stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') return null
  try {
    const got = JSON.parse(text)
    return got !== null && typeof got === 'object' ? got : null
  } catch {
    return null
  }
}

/**
 * 跑一次引擎(返回 `{ok, data, error, code}`)。**失败要看得见** —— 面板显示"读数拉取失败"
 * 比显示一个猜出来的空状态诚实。
 */
export function runArch (args, { pythonPath = null, timeoutMs = 20000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(pythonPath || 'python', args, {
        cwd: ENGINE_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      })
    } catch (err) {
      resolve({ ok: false, data: null, error: 'spawn failed: ' + String(err?.message ?? err) })
      return
    }
    let out = ''
    let errText = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { }
      resolve({ ok: false, data: null, error: 'timeout after ' + timeoutMs + 'ms' })
    }, Math.max(1000, Number(timeoutMs) || 20000))
    child.stdout?.on('data', (b) => { out += String(b) })
    child.stderr?.on('data', (b) => { errText += String(b) })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, data: null, error: 'spawn error: ' + String(err?.message ?? err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const data = parseArchOutput(out)
      if (code !== 0 || data === null) {
        resolve({ ok: false, data: null, code,
                  error: ('exit ' + code + (errText ? ': ' + errText.trim().slice(0, 400) : '')) })
        return
      }
      resolve({ ok: true, data, code })
    })
  })
}

/** 只读状态。 */
export const readArchStatus = ({ dbPath, pythonPath = null, timeoutMs = 20000 } = {}) =>
  runArch(buildArchArgs({ dbPath }), { pythonPath, timeoutMs })

/** 一键回退(写)。路线白名单之外一律不跑。 */
export const rollbackArch = ({ dbPath, route, pythonPath, timeoutMs = 30000, by = 'panel' } = {}) => {
  if (!ARCH_ROUTES.includes(String(route))) {
    return Promise.resolve({ ok: false, data: null, error: 'route-not-allowed: ' + String(route) })
  }
  return runArch(buildArchArgs({ dbPath, route, apply: true, by }),
    { pythonPath, timeoutMs })
}
