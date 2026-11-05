import path from 'node:path'

export class QQSendArtifactError extends Error {
  constructor (code) { super(code); this.name = 'QQSendArtifactError'; this.code = code }
}
const SAFE_CODES = new Set([
  'UNSUPPORTED_FILESYSTEM', 'INVALID_PATH', 'OUTSIDE_OUTPUT', 'SENSITIVE_PATH',
  'LINK_REFUSED', 'NOT_FILE', 'NOT_FOUND', 'EMPTY_FILE', 'TOO_LARGE',
  'SOURCE_CHANGED', 'ABORTED', 'REVOKED', 'INVALID_GRANT', 'STALE_SCOPE',
  'CAPACITY', 'BUSY', 'INVALID_PRESENT', 'UNKNOWN_REF', 'AMBIGUOUS_REF',
  'REF_CONFLICT', 'ALREADY_TAKEN', 'CLOSED', 'TIMEOUT', 'UNAVAILABLE'
])
export function artifactFailure (code) {
  return { ok: false, code: SAFE_CODES.has(code) ? code : 'UNAVAILABLE', reason: '文件暂不可发送。' }
}
export function filesystemIdentity (fs) { return fs?.[Symbol.for('cordis.original')] ?? fs }
const fail = code => { throw new QQSendArtifactError(code) }
const object = value => value !== null && typeof value === 'object'
const token = value => typeof value === 'string' && value.length > 0
const sensitive = /^(?:\.env(?:\..*)?|\.ssh|\.dsh|\.aws|\.azure|\.git|\.gnupg|\.npmrc|\.netrc|credentials?(?:\..*)?|id_(?:rsa|ed25519)(?:\..*)?|secrets?(?:\..*)?)$/iu

export function createQQSendFilesystem (fs, { cwd, relativeRoot, maxFileBytes = 8 * 1024 * 1024 } = {}) {
  for (const name of ['resolve', 'processPath', 'contains', 'lstat', 'stat', 'readBytes']) {
    if (typeof fs?.[name] !== 'function') fail('UNSUPPORTED_FILESYSTEM')
  }
  if (!token(cwd) || !token(relativeRoot) || !Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 8 * 1024 * 1024) fail('UNSUPPORTED_FILESYSTEM')
  const descriptors = new WeakMap()
  const guard = (options = {}) => {
    if (options.signal?.aborted) fail('ABORTED')
    if (options.check && options.check() !== true) fail('REVOKED')
  }
  const call = async (options, name, ...args) => {
    guard(options)
    try {
      const result = await fs[name](...args)
      guard(options)
      return result
    } catch (error) {
      guard(options)
      if (error instanceof QQSendArtifactError) throw error
      if (error?.code === 'FS_ABORTED') fail('ABORTED')
      if (error?.code === 'FS_TOO_LARGE') fail('SOURCE_CHANGED')
      if (['ENOENT', 'ENOTDIR', 'FS_NOT_FOUND'].includes(error?.code)) fail('NOT_FOUND')
      fail('UNAVAILABLE')
    }
  }
  const target = async (p, options) => {
    const result = await call(options, 'resolve', p, { cwd, signal: options?.signal })
    if (!object(result) || !token(result.targetKey)) fail('UNSUPPORTED_FILESYSTEM')
    return result
  }
  const canonical = async (t, options) => {
    const result = await call(options, 'processPath', t)
    if (!token(result)) fail('UNSUPPORTED_FILESYSTEM')
    return result
  }
  const info = (value, expected) => {
    if (!value) fail('NOT_FOUND')
    if (value.type === 'symlink') fail('LINK_REFUSED')
    if (value.type !== expected) fail('NOT_FILE')
    if (!token(value.version)) fail('UNSUPPORTED_FILESYSTEM')
    return value
  }
  async function workspace (options = {}) {
    guard(options)
    const base = await target(cwd, options)
    const absolute = await canonical(base, options)
    const style = /^[a-z]:[\\/]/iu.test(absolute) ? 'win32' : absolute.startsWith('/') ? 'posix' : null
    if (!style) fail('UNSUPPORTED_FILESYSTEM')
    const p = path[style]
    if (!p.isAbsolute(cwd) || p.normalize(cwd) !== p.normalize(absolute)) fail('LINK_REFUSED')
    if (p.isAbsolute(relativeRoot) || /[\\/:]/u.test(relativeRoot) || relativeRoot === '.' || relativeRoot === '..') fail('INVALID_PATH')
    info(await call(options, 'lstat', cwd, { cwd }, options.signal), 'directory')
    return { style, fsIdentity: filesystemIdentity(fs), base, absolute, output: p.join(absolute, relativeRoot) }
  }
  function lexical (value, w) {
    if (!token(value) || value.length > 2048 || /[\p{Cc}\p{Cf}]/u.test(value) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) || value.startsWith('\\\\') || value.startsWith('//')) fail('INVALID_PATH')
    const p = path[w.style]
    const segments = value.split(/[\\/]/u)
    if (segments.some(s => s === '.' || s === '..')) fail('INVALID_PATH')
    if (w.style === 'posix' && /[\\:]/u.test(value)) fail('INVALID_PATH')
    const tail = w.style === 'win32' ? value.replace(/^[a-z]:[\\/]/iu, '') : value
    if (/[<>:"|?*]/u.test(tail)) fail('INVALID_PATH')
    const absolute = p.resolve(w.absolute, value)
    const relative = p.relative(w.output, absolute)
    if (!relative || relative === '..' || relative.startsWith(`..${p.sep}`) || p.isAbsolute(relative)) fail('OUTSIDE_OUTPUT')
    const parts = relative.split(p.sep)
    if (parts.some(s => !s || /[. ]$/u.test(s) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(s))) fail('INVALID_PATH')
    if (parts.some(s => /session-[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.test(s))) fail('INVALID_PATH')
    if (parts.some(s => sensitive.test(s))) fail('SENSITIVE_PATH')
    return { absolute, parts, ref: parts.join('/'), name: parts.at(-1) }
  }
  async function scan (value, options) {
    const w = await workspace(options)
    const p = path[w.style]
    const file = lexical(value, w)
    const chain = []
    let current = w.absolute
    let output
    for (const [i, part] of [relativeRoot, ...file.parts].entries()) {
      current = p.join(current, part)
      const last = i === file.parts.length
      const entry = info(await call(options, 'lstat', current, { cwd }, options?.signal), last ? 'file' : 'directory')
      const resolved = await target(current, options)
      if (p.normalize(await canonical(resolved, options)) !== p.normalize(current)) fail('LINK_REFUSED')
      if (await call(options, 'contains', w.base, resolved) !== true) fail('OUTSIDE_OUTPUT')
      if (i === 0) output = resolved
      if (await call(options, 'contains', output, resolved) !== true) fail('OUTSIDE_OUTPUT')
      const actual = info(await call(options, 'stat', resolved, options?.signal), last ? 'file' : 'directory')
      if (actual.version !== entry.version) fail('SOURCE_CHANGED')
      chain.push({ key: resolved.targetKey, type: entry.type })
      if (last) {
        if (!Number.isSafeInteger(actual.size) || actual.size < 0) fail('UNSUPPORTED_FILESYSTEM')
        if (actual.size === 0) fail('EMPTY_FILE')
        if (actual.size > maxFileBytes) fail('TOO_LARGE')
        return { ...file, target: resolved, version: actual.version, size: actual.size, chain, baseKey: w.base.targetKey }
      }
    }
  }
  async function inspect (value, options = {}) {
    const record = await scan(value, options)
    const descriptor = Object.freeze({ ref: record.ref, name: record.name, size: record.size })
    descriptors.set(descriptor, record)
    return descriptor
  }
  async function verify (descriptor, options = {}) {
    guard(options)
    const before = descriptors.get(descriptor)
    if (!before) fail('INVALID_PATH')
    let after
    try { after = await scan(before.absolute, options) } catch (error) {
      if (['ABORTED', 'REVOKED', 'UNSUPPORTED_FILESYSTEM', 'UNAVAILABLE'].includes(error.code)) throw error
      fail('SOURCE_CHANGED')
    }
    if (before.baseKey !== after.baseKey || before.version !== after.version || before.size !== after.size ||
      before.chain.length !== after.chain.length || before.chain.some((v, i) => v.key !== after.chain[i].key || v.type !== after.chain[i].type)) fail('SOURCE_CHANGED')
  }
  async function readSnapshot (descriptor, options = {}) {
    await verify(descriptor, options)
    const before = descriptors.get(descriptor)
    // Logical cancellation is checked by call() before/after this bounded read.
    // Do not forward its signal: Node 22's host provider can open a ReadStream
    // with an already-aborted signal after stat and leave a Windows file locked.
    // The registry keeps its reservation/slot until this provider promise exits.
    const data = await call(options, 'readBytes', before.target, undefined, before.size)
    if (!(data instanceof Uint8Array) || !(data.buffer instanceof ArrayBuffer) || data.buffer.resizable === true || data.length !== before.size) fail('SOURCE_CHANGED')
    // Copy before any further await; the provider cannot mutate the frozen bytes later.
    const snapshot = new Uint8Array(data)
    await verify(descriptor, options)
    guard(options)
    return snapshot
  }
  return { workspace, inspect, verify, readSnapshot }
}
