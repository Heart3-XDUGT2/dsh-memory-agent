/**
 * dsh-echo — Python sidecar 客户端(M2-c)
 * ============================================================
 * worker.py 的进程管理:探测 → spawn → 握手 → reqId 配对往返 →
 * 超时 → 崩溃自动重启 → 熔断(3 连败)→ ping 周期复活探测。
 *
 * 降级链上这层只负责「说实话」:引擎在不在、坏没坏、坏了几次。
 * 用不用 JS 基线顶上是 M2-d engine.js 门面的决策,本模块不越权。
 *
 * 探测链(PLAN §7 风险表):ECHO_PYTHON 环境变量 → config.json 的
 * pythonPath(面板可配)→ PATH(python → python3);逐个实测版本,
 * ≥3.9 才算数(worker 纯标准库,3.9 是 f-string/字典合并的下限)。
 * Windows 的 Store 假 python 在这一步自然淘汰(探不出版本)。
 *
 * 生命周期:
 *   start()   spawn + hello 握手(协议不符/验库失败 → 拒绝并击杀);
 *   request() reqId 严格配对;超时 = 引擎不可信,击杀并计失败;
 *             可选 opts.signal:abort 时发带外 cancel 帧并**立刻**本地拒绝
 *             (不等引擎的 cancelled 回帧 —— 引擎可能正卡在检查点之间,
 *             等它就等于把取消退化成超时,而超时会击杀进程);
 *   崩溃      非用户主动 stop 的退出 → 计失败,< 3 连败自动重启,
 *             ≥ 3 连败熔断打开:请求快速失败(不 spawn),周期
 *             复活探测成功才合闸;
 *   stop()    shutdown 帧 → bye → 退出码 0;宽限期后强杀。
 *
 * ⚠️ 取消与超时是**两回事**,别混:
 *   超时  = 「挂着的引擎不可信」 ⇒ _kill + 计失败;
 *   取消  = 正常控制流(调用方主动撤回) ⇒ 不 kill、不 noteSuccess、不计失败。
 *   把取消当成失败会让熔断器被正常操作误触发。
 *
 * 协议纪律(echo_wire_v1,与 worker.py 对齐):stdout 只出协议帧;
 * 一行一个 JSON;>1MiB 帧致命;未知 reqId 忽略(前向兼容)。
 * stderr 只进环形缓冲(尾部 20 行,诊断用),绝不解析。
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { CONFIG_PATH } from './toggle.js'
import { authorityBindingMatches, MEMORY_AUTHORITY_PROFILES } from './memory-authority.js'
import { SNAPSHOT_PROTOCOL, SNAPSHOT_TABLES, SOURCE_EXPORT_LIMITS } from './memory-source-export.js'

const hashText = value => createHash('sha256').update(String(value), 'utf8').digest('hex')
const hashBytes = value => createHash('sha256').update(value).digest('hex')
const SNAPSHOT_INSTALL_TYPE = 'memory_snapshot_install'
const SNAPSHOT_CLOSE_TYPE = 'memory_snapshot_close'
const SNAPSHOT_RECEIPT_FIELDS = Object.freeze([
  'protocol', 'kind', 'tokenHash', 'schemaHash', 'contentHash',
  'ownerHash', 'turnHash', 'attemptHash'
])
const SNAPSHOT_HASH_FIELDS = SNAPSHOT_RECEIPT_FIELDS.slice(2)
const SNAPSHOT_EMPTY_RECEIPT = Object.freeze({ status: 'no-go', kind: null,
  ...Object.fromEntries(SNAPSHOT_HASH_FIELDS.map(key => [key, null])) })
const SNAPSHOT_KINDS = new Set(['immutable_export', 'backup_export'])
const SNAPSHOT_HASH = /^[a-f0-9]{64}$/u
const SNAPSHOT_REASON = Object.freeze({
  invalid: 'snapshot_manifest_invalid',
  scope: 'snapshot_scope_unavailable',
  budget: 'snapshot_manifest_too_large',
  unreadable: 'snapshot_export_unreadable',
  token: 'snapshot_token_mismatch',
  receipt: 'snapshot_receipt_mismatch',
  install: 'snapshot_install_failed',
  unknown: 'snapshot_handle_unknown',
  closed: 'snapshot_handle_closed',
  close: 'snapshot_close_failed',
  conflict: 'snapshot_handle_conflict',
  capacity: 'snapshot_handle_capacity'
})
const SNAPSHOT_MAX_ACTIVE = 8 // Matches the worker's open reader limit.
const SNAPSHOT_MAX_CLOSED = 64

export const PROTOCOL = 'echo_wire_v1'
const PY_MIN_MAJOR = 3
const PY_MIN_MINOR = 9
const MAX_LINE = 1024 * 1024      // 与 worker 同限:防病态帧撑爆内存
const PROBE_TIMEOUT_MS = 3000     // 版本探测超时(Store 假 python 会挂)
const STOP_GRACE_MS = 2000        // stop() 宽限期,过了强杀

/** sidecar 往来错误:frame 字段挂原始协议帧,调用方可审计。 */
export class SidecarError extends Error {
  constructor(message, frame = null, options = {}) {
    super(message)
    this.name = 'SidecarError'
    this.frame = frame
    // 取消是正常控制流,不是故障:调用方据此区分「被撤回」与「真出错」,
    // 不必靠匹配 message 文本。
    this.cancelled = options.cancelled === true
  }
}

/**
 * 解析版本探测输出:「3 14」(我们自己的探针)或「3.14.7」(顺手
 * 兼容 sys.version 风格)。解析不出 → null,不猜。
 */
export function parsePythonVersion(text) {
  const m = String(text ?? '').trim().match(/(\d+)\s*[.\s]\s*(\d+)/)
  if (m === null) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null
  return { major, minor }
}

/** 版本门槛:≥3.9(或任何 4+)。 */
export function pythonVersionOk(ver) {
  if (ver === null || typeof ver !== 'object') return false
  if (ver.major > PY_MIN_MAJOR) return true
  if (ver.major < PY_MIN_MAJOR) return false
  return ver.minor >= PY_MIN_MINOR
}

/** 实测一个候选:跑版本探针,超时击杀。返回 {path, ver} 或 null。 */
async function probeCandidate(path) {
  return await new Promise((resolve) => {
    let settled = false
    let out = ''
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child?.kill() } catch { /* 已退就算了 */ }
      resolve(result)
    }
    let child
    try {
      child = spawn(path, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return resolve(null)
    }
    const timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (c) => { out += c })
    child.on('error', () => done(null))
    child.on('close', () => {
      const ver = parsePythonVersion(out)
      done(ver === null ? null : { path, ver })
    })
  })
}

/**
 * 探测链:env ECHO_PYTHON → config.json pythonPath → PATH。
 * 返回 { path, major, minor } 或 null(Python 缺失,调用方走基线)。
 * configPath 可注入(测试用);默认读面板配置文件,fail-soft。
 */
export async function detectPython(options = {}) {
  const env = options.env ?? process.env
  const configPath = options.configPath ?? CONFIG_PATH
  let configPython = ''
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf8'))
      if (typeof raw.pythonPath === 'string' && raw.pythonPath.trim() !== '') {
        configPython = raw.pythonPath.trim()
      }
    }
  } catch { /* 配置脏值 → 跳过这一级,不猜 */ }
  const candidates = options.candidates ?? [
    env.ECHO_PYTHON, configPython, 'python', 'python3'
  ]
  for (const c of candidates) {
    if (typeof c !== 'string' || c.trim() === '') continue
    const hit = await probeCandidate(c.trim())
    if (hit !== null && pythonVersionOk(hit.ver)) {
      return { path: hit.path, major: hit.ver.major, minor: hit.ver.minor }
    }
  }
  return null
}

export class SidecarClient {
  constructor(opts = {}) {
    this.pythonPath = opts.pythonPath
    this.workerPath = opts.workerPath
    this.dbPath = opts.dbPath
    this.a1 = opts.a1 ?? null
    this.a1Entries = opts.a1Entries ?? ['memory_add']
    if (!MEMORY_AUTHORITY_PROFILES.some(profile => JSON.stringify(profile) === JSON.stringify(this.a1Entries))) {
      throw new SidecarError('invalid authority profile')
    }
    this.logger = opts.logger ?? null
    this.timeoutMs = opts.timeoutMs ?? 10000
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 8000
    this.restartBackoffMs = opts.restartBackoffMs ?? 500
    this.failureLimit = opts.failureLimit ?? 3
    this.revivalIntervalMs = opts.revivalIntervalMs ?? 30000
    // 运行态
    this._child = null
    this._dead = false            // error/exit 只记账一次
    this._stopping = false
    this._startedOnce = false
    this._starting = null         // 并发 start() 去重
    this._pending = new Map()     // reqId -> { resolve, reject, timer }
    this._reqId = 0
    this._lineBuf = ''
    this._stderrTail = []
    this._failures = 0
    this._restarts = 0
    this._requests = 0
    this._cancels = 0
    this._breakerOpen = false
    this._revivalTimer = null
    this._restartTimer = null
    this._handshakeInfo = null
    this._lastError = ''
    this._memorySnapshots = new Map()
  }

  _log(level, msg) {
    try { this.logger?.[level]?.('echo-sidecar: ' + msg) } catch { /* 日志失败无妨 */ }
  }

  /** 进程活着且不是正在收尾。 */
  get running() {
    return this._child !== null && !this._dead && !this._stopping
  }

  /** 诊断快照(M2-i 面板引擎状态行的数据源)。 */
  state() {
    return {
      running: this.running,
      startedOnce: this._startedOnce,
      breakerOpen: this._breakerOpen,
      failures: this._failures,
      restarts: this._restarts,
      requests: this._requests,
      cancels: this._cancels,
      pid: this.running ? this._child.pid : null,
      engine: this._handshakeInfo?.engine ?? null,
      version: this._handshakeInfo?.version ?? null,
      protocol: this._handshakeInfo?.protocol ?? 'unverified',
      profileEntries: Array.isArray(this._handshakeInfo?.a1?.entries)
        ? [...this._handshakeInfo.a1.entries] : 'unverified',
      authority: this._handshakeInfo?.a1 ? {
        status: this._handshakeInfo.a1.status ?? 'unverified',
        protocol: this._handshakeInfo.a1.protocol ?? 'unverified',
        epochHash: typeof this._handshakeInfo.a1.epoch === 'string'
          ? hashText(this._handshakeInfo.a1.epoch) : null,
        generation: Number.isSafeInteger(this._handshakeInfo.a1.generation)
          ? this._handshakeInfo.a1.generation : null,
        entries: Array.isArray(this._handshakeInfo.a1.entries)
          ? [...this._handshakeInfo.a1.entries] : 'unverified'
      } : 'unverified',
      dbOk: this._handshakeInfo?.db?.ok ?? null,
      pythonPath: this.pythonPath ?? null,
      dbPath: this.dbPath ?? null,
      lastError: this._lastError,
      stderrTail: [...this._stderrTail]
    }
  }

  /** spawn + hello 握手。幂等:活着就直接回握手信息。 */
  async start() {
    if (this._breakerOpen) {
      throw new SidecarError('circuit breaker open — engine offline, revival probing')
    }
    if (this.running) return this._handshakeInfo
    if (this._starting !== null) return this._starting
    this._starting = this._startInternal().finally(() => { this._starting = null })
    return this._starting
  }

  async _startInternal() {
    if (this._stopping) throw new SidecarError('client is stopping')
    const child = spawn(this.pythonPath, [this.workerPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    this._child = child
    this._dead = false
    this._lineBuf = ''
    // 流错误必须吞掉(EPIPE 等):否则未处理 error 事件炸宿主
    child.stdin?.on('error', () => {})
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout.on('data', (c) => this._onStdout(c))
    child.stderr.on('data', (c) => this._onStderr(c))
    child.on('error', (err) => this._onDead(err))
    child.on('exit', (code) => this._onDead(null, code))
    if (typeof child.pid !== 'number' || child.pid <= 0) {
      // spawn 同步失败(ENOENT 走 error 事件,这里兜底异步窗口)
      await new Promise((r) => setTimeout(r, 0))
      if (this._dead) throw new SidecarError(this._lastError || 'spawn failed')
    }
    const info = await this._handshake()
    // 握手帧必须验:协议不符/验库失败 = 引擎不可用,击杀并拒绝。
    // 这是确定性永久错误(参数错),同步置 _dead:状态立即诚实,
    // 且 _onDead 跳过记账 —— 用户面 start() 失败不自动重启
    // (坏参数重启一万次也不会好;重启风暴留给瞬态故障)。
    if (info === null || typeof info !== 'object' || info.type !== 'ready'
        || info.protocol !== PROTOCOL || info.db?.ok !== true
        || info.a1?.status === 'blocked'
        || (this.a1 !== null && (!authorityBindingMatches(this.a1, info.a1)
          || info.a1?.status !== 'active' || info.a1.strengthProtocol !== 'echo-memory-strength/v1'
          || info.a1.bodyProtocol !== 'echo-memory-body/v1'
          || JSON.stringify(info.a1.entries) !== JSON.stringify(this.a1Entries)
          || !Array.isArray(info.a1.supportedEntries)
          || !this.a1Entries.every(entry => info.a1.supportedEntries.includes(entry))))
        || (this.a1 === null && info.a1?.status === 'active')) {
      this._dead = true
      this._lastError = 'handshake rejected — engine=' + String(info?.engine)
        + ' dbOk=' + String(info?.db?.ok)
      try { child.kill() } catch { /* 已死就算了 */ }
      throw new SidecarError('handshake failed: worker not usable with this db')
    }
    this._startedOnce = true
    this._handshakeInfo = info
    this._log('info', 'worker ready — engine=' + info.engine + ' version=' + info.version + ' pid=' + child.pid)
    return info
  }

  _handshake() {
    const reqId = ++this._reqId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(reqId)
        this._kill('handshake timeout')
        reject(new SidecarError('handshake timeout'))
      }, this.handshakeTimeoutMs)
      this._pending.set(reqId, {
        resolve: (frame) => { clearTimeout(timer); resolve(frame) },
        reject: (err) => { clearTimeout(timer); reject(err) }
      })
      this._writeLine(JSON.stringify({ reqId, type: 'hello', protocol: PROTOCOL, dbPath: this.dbPath,
        ...(this.a1 === null ? {} : { a1: this.a1 }),
        ...(this.a1Entries.includes('memory_association') ? { a1Entries: this.a1Entries } : {}) }))
    })
  }

  /**
   * 业务帧往返:reqId 严格配对。error 帧 → 拒绝(frame 挂在错误上);
   * 超时 → 拒绝并击杀(挂着的引擎不可信),失败记账走 exit 路径。
   *
   * `opts.signal`(可选 AbortSignal):abort 时发一帧带外 cancel 并**立刻**
   * 本地拒绝,错误带 `cancelled: true`。刻意不等引擎的 cancelled 回帧 ——
   * 引擎可能正卡在两次检查点之间(尤其是在长 BFS 里),等它就把「取消」
   * 退化成了「超时」,而超时会击杀进程、记一次失败,把熔断器推开。
   *
   * 取消**不计失败、不 noteSuccess**:前者会把正常操作当故障,后者会
   * 假原谅一次真正的失败。
   */
  async request(type, payload = {}, opts = {}) {
    if (this._breakerOpen) {
      throw new SidecarError('circuit breaker open — engine offline, revival probing')
    }
    if (!this.running) {
      throw new SidecarError('sidecar not running' + (this._lastError !== '' ? ' — ' + this._lastError : ''))
    }
    const signal = opts.signal ?? null
    if (signal !== null && signal.aborted === true) {
      // 已经中止的信号:一帧都不发(发了也白发,调用方已经不想要结果)
      throw new SidecarError('request cancelled before send: ' + type, null, { cancelled: true })
    }
    const reqId = ++this._reqId
    this._requests++
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs
    return await new Promise((resolve, reject) => {
      const self = this
      let settled = false
      let timer = null

      function onAbort() {
        if (settled) return
        settled = true
        if (timer !== null) clearTimeout(timer)
        try { signal.removeEventListener('abort', onAbort) } catch { /* 非标准实现 */ }
        self._pending.delete(reqId)
        self._cancels++
        self._sendCancel(reqId)
        reject(new SidecarError('request cancelled: ' + type, null, { cancelled: true }))
      }

      timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { signal?.removeEventListener('abort', onAbort) } catch { /* 非标准实现 */ }
        this._pending.delete(reqId)
        this._kill('request timeout (' + type + ')')
        reject(new SidecarError('request timeout: ' + type))
      }, timeoutMs)

      this._pending.set(reqId, {
        snapshotControl: type === SNAPSHOT_INSTALL_TYPE || type === SNAPSHOT_CLOSE_TYPE,
        resolve: (frame) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { signal?.removeEventListener('abort', onAbort) } catch { /* 非标准实现 */ }
          this.noteSuccess()
          resolve(frame)
        },
        reject: (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          try { signal?.removeEventListener('abort', onAbort) } catch { /* 非标准实现 */ }
          reject(err)
        }
      })

      if (signal !== null) {
        try { signal.addEventListener('abort', onAbort, { once: true }) } catch { /* 非标准实现 */ }
      }
      this._writeLine(JSON.stringify({ reqId, type, ...payload }))
    })
  }

  /**
   * Private snapshot control plane. Raw path and receipt are sent only in this
   * control frame; the returned object is deliberately bounded and opaque.
   */
  async installMemorySnapshot(manifest, opts = {}) {
    const checked = validateSnapshotManifest(manifest)
    if (!checked.ok) return { status: 'no-go', reason: checked.reason }
    const { value } = checked
    const { handle, path, receipt } = value
    const existing = this._memorySnapshots.get(handle)
    const fingerprint = snapshotFingerprint(value)
    if (existing?.status === 'closed') return { status: 'no-go', reason: SNAPSHOT_REASON.closed }
    if (existing?.status === 'closing') return { status: 'no-go', reason: SNAPSHOT_REASON.close }
    if (existing && existing.fingerprint !== fingerprint) return { status: 'no-go', reason: SNAPSHOT_REASON.conflict }
    if (existing?.status === 'installing') return { status: 'no-go', reason: SNAPSHOT_REASON.install }
    if (!existing && [...this._memorySnapshots.values()].filter(item => item.status !== 'closed').length >= SNAPSHOT_MAX_ACTIVE) {
      return { status: 'no-go', reason: SNAPSHOT_REASON.capacity }
    }
    let bytes
    try { bytes = readFileSync(path) } catch {
      return { status: 'no-go', reason: SNAPSHOT_REASON.unreadable }
    }
    if (hashBytes(bytes) !== receipt.tokenHash) {
      return { status: 'no-go', reason: SNAPSHOT_REASON.token }
    }
    if (opts.signal?.aborted) return { status: 'no-go', reason: SNAPSHOT_REASON.install }
    if (existing?.status === 'ready') return { status: 'ready', handle }
    const child = this._child
    this._rememberSnapshot(handle, 'installing', fingerprint)
    const pending = this._memorySnapshots.get(handle)
    try {
      const hashes = Object.fromEntries(SNAPSHOT_HASH_FIELDS.map(key => [key, receipt[key]]))
      const frame = await this.request(SNAPSHOT_INSTALL_TYPE, { handle, path, receipt, ...hashes }, opts)
      if (this._child !== child || frame?.type !== 'memory_snapshot_install_result'
        || this._memorySnapshots.get(handle) !== pending
        || frame.handleHash !== hashText(handle)
        || !((frame.status === 'ready' && frame.reason === null)
          || (frame.status === 'duplicate' && frame.reason === 'snapshot_handle_duplicate'))
        || !receiptMatches(frame.receipt, { status: 'ready', reason: null, kind: receipt.kind, ...hashes })) {
        return { status: 'no-go', reason: SNAPSHOT_REASON.receipt }
      }
      this._rememberSnapshot(handle, 'ready', fingerprint)
      return { status: 'ready', handle }
    } catch {
      return { status: 'no-go', reason: SNAPSHOT_REASON.install }
    } finally {
      if (this._memorySnapshots.get(handle) === pending) this._memorySnapshots.delete(handle)
    }
  }

  /** Idempotent private snapshot close; raw manifest data never returns. */
  async closeMemorySnapshot(handle, opts = {}) {
    if (!validSnapshotHandle(handle)) return { status: 'no-go', reason: SNAPSHOT_REASON.invalid }
    const existing = this._memorySnapshots.get(handle)
    if (existing?.status === 'closed') return { status: 'closed', handle }
    // An attempted install can have reached the worker without a valid acknowledgement.
    if (existing?.status !== 'ready' && existing?.status !== 'closing' && (existing || opts.reclaim !== true)) {
      return { status: 'no-go', reason: SNAPSHOT_REASON.unknown }
    }
    const child = this._child
    if (existing) this._rememberSnapshot(handle, 'closing', existing.fingerprint)
    try {
      const frame = await this.request(SNAPSHOT_CLOSE_TYPE, { handle }, opts)
      if (this._child !== child || frame?.type !== 'memory_snapshot_close_result'
        || frame.status !== 'closed' || frame.handleHash !== hashText(handle)
        || ![null, 'snapshot_handle_already_closed'].includes(frame.reason)
        || !receiptMatches(frame.receipt, { ...SNAPSHOT_EMPTY_RECEIPT, reason: frame.reason })) {
        return { status: 'no-go', reason: SNAPSHOT_REASON.close }
      }
      this._rememberSnapshot(handle, 'closed', existing?.fingerprint)
      return { status: 'closed', handle }
    } catch {
      return { status: 'no-go', reason: SNAPSHOT_REASON.close }
    }
  }

  _rememberSnapshot(handle, status, fingerprint = null) {
    this._memorySnapshots.delete(handle)
    this._memorySnapshots.set(handle, { status, fingerprint })
    if (status === 'closed') {
      const closed = [...this._memorySnapshots].filter(([, item]) => item.status === 'closed')
      if (closed.length > SNAPSHOT_MAX_CLOSED) this._memorySnapshots.delete(closed[0][0])
    }
  }

  /**
   * 带外取消帧:**自己不带 reqId**,引擎不为它回帧 ——
   * 应答走 target 自己的 reqId 通道(`{"reqId": target, "type": "cancelled"}`)。
   *
   * 发不出去不算错:管道断了的话,进程死亡路径已经把在途请求全拒了。
   */
  _sendCancel(reqId) {
    try {
      this._writeLine(JSON.stringify({ type: 'cancel', targetReqId: reqId }))
      return true
    } catch {
      return false
    }
  }

  /** 便捷健康探测。 */
  async ping(opts = {}) {
    const frame = await this.request('ping', {}, opts)
    if (frame.type !== 'pong') throw new SidecarError('unexpected ping reply: ' + frame.type, frame)
    return frame
  }

  /** 优雅收尾:shutdown → bye → 退出码 0;宽限期后强杀。 */
  async stop() {
    this._stopping = true
    if (this._restartTimer !== null) { clearTimeout(this._restartTimer); this._restartTimer = null }
    if (this._revivalTimer !== null) { clearInterval(this._revivalTimer); this._revivalTimer = null }
    const child = this._child
    if (child !== null && !this._dead) {
      try {
        this._writeLine(JSON.stringify({ reqId: ++this._reqId, type: 'shutdown' }))
      } catch { /* 管道已断,走强杀路径 */ }
      await new Promise((resolve) => {
        const grace = setTimeout(() => { try { child.kill() } catch { } resolve() }, STOP_GRACE_MS)
        child.once('exit', () => { clearTimeout(grace); resolve() })
      })
    }
    this._child = null
  }

  // ---- 内部:进程与帧 ----

  _writeLine(line) {
    const child = this._child
    if (child === null || this._dead) throw new SidecarError('worker is gone')
    child.stdin.write(line + '\n')
  }

  _onStdout(chunk) {
    this._lineBuf += chunk
    // v0.42.0 审计修复(P1:防线形同虚设):长度检查原来在 while **循环里面** ——
    // 它只看「切走一行之后剩下的残留」超没超限。而本模块真正要防的病态输入是
    // **一个没有换行的巨大 chunk**(worker 崩坏、或别的程序往标准输出灌二进制):
    // `indexOf('\n') < 0` ⇒ 循环一次都不进 ⇒ 一次都不检查,_lineBuf 一直涨到
    // 内存爆掉。现在先判长度、再切行,切完再判一次残留(与 worker 侧那道
    // 对称防线对齐)。
    if (this._lineBuf.length > MAX_LINE) {
      this._kill('stdout line exceeds 1MiB')
      return
    }
    let idx
    while ((idx = this._lineBuf.indexOf('\n')) >= 0) {
      const line = this._lineBuf.slice(0, idx)
      this._lineBuf = this._lineBuf.slice(idx + 1)
      if (line.trim() !== '') this._onLine(line)
    }
    if (this._lineBuf.length > MAX_LINE) {
      // 病态输出:协议违规,击杀(与 worker 的对称防线)
      this._kill('stdout line exceeds 1MiB')
      return
    }
  }

  _onLine(line) {
    let frame
    try { frame = JSON.parse(line) } catch {
      this._log('warn', 'dropped non-json stdout line: ' + line.slice(0, 80))
      return
    }
    if (frame === null || typeof frame !== 'object') {
      this._kill('stdout frame is not a json object')
      return
    }
    const pending = this._pending.get(frame.reqId)
    if (pending === undefined) {
      // 未知 reqId:前向兼容,忽略不崩(与 worker 同款纪律)
      this._log('debug', 'unpaired frame: ' + String(frame.type))
      return
    }
    this._pending.delete(frame.reqId)
    if (frame.type === 'error') {
      this._lastError = pending.snapshotControl ? 'snapshot_control_failed' : String(frame.error ?? 'unknown engine error')
      pending.reject(new SidecarError(this._lastError, pending.snapshotControl ? null : frame))
      if (frame.fatal === true) this._kill('fatal engine error')
    } else if (frame.type === 'cancelled') {
      // 引擎确认收到取消。常规路径下壳在 abort 那一刻就已经本地拒绝、并把
      // pending 摘掉了,所以这一帧多半会先走上面的「未知 reqId」分支被忽略。
      // 这里兜的是「壳没本地拒绝」的情形(例如将来引擎侧主动取消)。
      //
      // ⚠️ 不写 _lastError、不 noteSuccess、不 _kill:取消不是故障。
      pending.reject(new SidecarError('request cancelled by engine', frame, { cancelled: true }))
    } else {
      pending.resolve(frame)
    }
  }

  _onStderr(chunk) {
    // 环形缓冲尾部 20 行:诊断够用,不撑内存(worker 侧另有 64 行预算)
    for (const line of String(chunk).split('\n')) {
      if (line.trim() === '') continue
      this._stderrTail.push(line)
      if (this._stderrTail.length > 20) this._stderrTail.shift()
    }
  }

  _kill(reason) {
    this._lastError = reason
    try { this._child?.kill() } catch { /* 已死就算了 */ }
  }

  /** 进程死亡记账(error 与 exit 双入口,只记一次)。 */
  _onDead(err, code) {
    if (this._dead) return
    this._dead = true
    this._memorySnapshots.clear()
    const reason = err !== null
      ? 'spawn error: ' + String(err?.message ?? err)
      : 'worker exited (code ' + String(code) + ')'
    this._lastError = reason
    // 所有在途请求立刻失败:EOF 不是答案
    for (const [reqId, pending] of this._pending) {
      this._pending.delete(reqId)
      pending.reject(new SidecarError(reason))
    }
    this._child = null
    if (this._stopping) return
    this._log('warn', reason)
    this._fail(reason)
  }

  /** 失败记账:3 连败熔断,否则退避后自动重启。 */
  _fail(reason) {
    this._failures++
    if (this._failures >= this.failureLimit) {
      this._breakerOpen = true
      this._log('warn', 'circuit breaker OPEN after ' + this._failures + ' failures — ' + reason)
      if (this._revivalTimer === null) {
        this._revivalTimer = setInterval(() => { this._revive().catch(() => { }) }, this.revivalIntervalMs)
      }
    } else {
      this._restarts++
      this._restartTimer = setTimeout(() => {
        this._restartTimer = null
        this._restart().catch(() => { })
      }, this.restartBackoffMs)
    }
  }

  async _restart() {
    if (this._stopping || this._breakerOpen) return
    try {
      await this._startInternal()
      // 重启成功不清零失败数:连续失败以「最近一次成功」为界,
      // 只有真正跑通一单业务请求才值得原谅(noteSuccess)。
      this._log('info', 'worker restarted (pid=' + this._child?.pid + ')')
    } catch (err) {
      // 失败记账已由 _onDead 完成(进程死亡是唯一记账点),这里只留痕;
      // 下一次重启由 _fail 的退避调度继续,连败到上限自然熔断。
      this._log('warn', 'restart failed — ' + String(err?.message ?? err))
    }
  }

  /** 熔断复活探测:整链重来(spawn+握手),成功才合闸。 */
  async _revive() {
    if (this._stopping) {
      if (this._revivalTimer !== null) { clearInterval(this._revivalTimer); this._revivalTimer = null }
      return
    }
    try {
      // 探测期间不合闸:失败一次就再等下一周期,不给请求放行假希望
      await this._startInternal()
      this._failures = 0
      this._breakerOpen = false
      if (this._revivalTimer !== null) { clearInterval(this._revivalTimer); this._revivalTimer = null }
      this._log('info', 'circuit breaker CLOSED — worker revived (pid=' + this._child?.pid + ')')
    } catch (err) {
      this._lastError = 'revival probe failed: ' + String(err?.message ?? err)
    }
  }

  /** 一单业务请求跑通:失败计数清零(熔断语义 = 连续失败)。 */
  noteSuccess() {
    this._failures = 0
  }
}

function validSnapshotHandle(value) {
  return typeof value === 'string' && /^snapshot_[a-f0-9]{48}$/u.test(value)
}

function snapshotFingerprint(value) {
  return hashText(JSON.stringify([value.path, ...SNAPSHOT_RECEIPT_FIELDS.map(key => value.receipt[key])]))
}

function receiptMatches(actual, expected) {
  if (actual === null || typeof actual !== 'object') return false
  const fields = Object.keys(expected)
  return Object.keys(actual).length === fields.length
    && fields.every(field => Object.hasOwn(actual, field) && actual[field] === expected[field])
}

function validateSnapshotManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object') {
    return { ok: false, reason: SNAPSHOT_REASON.invalid }
  }
  try {
    const keys = Object.keys(manifest).sort().join(',')
    if (keys !== 'handle,kind,limits,path,protocol,receipt') {
      return { ok: false, reason: SNAPSHOT_REASON.invalid }
    }
    if (!validSnapshotHandle(manifest.handle)
      || manifest.protocol !== SNAPSHOT_PROTOCOL
      || !SNAPSHOT_KINDS.has(manifest.kind)
      || typeof manifest.path !== 'string'
      || manifest.path.length === 0 || manifest.path.length > 1024
      || /[\u0000-\u001f\u007f]/u.test(manifest.path)) {
      return { ok: false, reason: SNAPSHOT_REASON.invalid }
    }
    const limits = manifest.limits
    if (limits === null || typeof limits !== 'object'
      || Object.keys(limits).sort().join(',') !== 'rows,tables'
      || limits.rows !== SOURCE_EXPORT_LIMITS.maxRows
      || !Array.isArray(limits.tables)
      || JSON.stringify(limits.tables) !== JSON.stringify(SNAPSHOT_TABLES)) {
      return { ok: false, reason: SNAPSHOT_REASON.budget }
    }
    const receipt = manifest.receipt
    if (receipt === null || typeof receipt !== 'object'
      || Object.keys(receipt).sort().join(',') !== SNAPSHOT_RECEIPT_FIELDS.slice().sort().join(',')
      || receipt.protocol !== SNAPSHOT_PROTOCOL
      || receipt.kind !== manifest.kind) {
      return { ok: false, reason: SNAPSHOT_REASON.invalid }
    }
    for (const field of SNAPSHOT_RECEIPT_FIELDS.slice(2)) {
      if (typeof receipt[field] !== 'string' || !SNAPSHOT_HASH.test(receipt[field])
        || /^0{64}$/u.test(receipt[field])) {
        return {
          ok: false,
          reason: ['ownerHash', 'turnHash', 'attemptHash'].includes(field)
            ? SNAPSHOT_REASON.scope : SNAPSHOT_REASON.invalid
        }
      }
    }
    if (receipt.ownerHash === null || receipt.turnHash === null || receipt.attemptHash === null) {
      return { ok: false, reason: SNAPSHOT_REASON.scope }
    }
    return {
      ok: true,
      value: {
        protocol: manifest.protocol,
        kind: manifest.kind,
        handle: manifest.handle,
        path: manifest.path,
        limits: { rows: limits.rows, tables: [...limits.tables] },
        receipt: { ...receipt }
      }
    }
  } catch {
    return { ok: false, reason: SNAPSHOT_REASON.invalid }
  }
}
