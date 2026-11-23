/** Pure batch scheduling state for memory consolidation. No timers or I/O. */
export const CONSOLIDATION_DEFAULTS = Object.freeze({
  time: '22:00', catchUp: true, maxMemories: 100, maxHops: 2,
  maxNeighbors: 24, maxTokens: 8000, timeoutMs: 300000, maxRetries: 3, retryDelayMs: 60000
})
export function localDateParts (now = new Date(), timeZone = 'Asia/Shanghai') {
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) throw Error('invalid_now')
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour), minute: Number(parts.minute),
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  }
}
export function batchIdFor (date) {
  if (!/^\d{4}-\d\d-\d\d$/u.test(String(date))) throw Error('invalid_date')
  return `memory-consolidation-${date}`
}
function addDays (date, days) {
  const [y, m, d] = date.split('-').map(Number)
  const value = new Date(Date.UTC(y, m - 1, d + days))
  return value.toISOString().slice(0, 10)
}
export function consolidationBatch (now = new Date(), settings = {}, timeZone = 'Asia/Shanghai') {
  const local = localDateParts(now, timeZone)
  const time = { value: CONSOLIDATION_DEFAULTS.time, hour: 22, minute: 0 }
  return {
    batchId: batchIdFor(local.date), date: local.date, time: time.value,
    scheduledMinutes: time.hour * 60 + time.minute, localMinutes: local.minutes,
    timeZone
  }
}
export function consolidationState ({ now = new Date(), settings = {}, record = null, timeZone = 'Asia/Shanghai' } = {}) {
  const catchUp = settings.catchUp !== false
  const maxRetries = Number.isSafeInteger(settings.maxRetries) ? settings.maxRetries : CONSOLIDATION_DEFAULTS.maxRetries
  const retryDelayMs = Number.isFinite(Number(settings.retryDelayMs))
    ? Math.max(0, Number(settings.retryDelayMs)) : CONSOLIDATION_DEFAULTS.retryDelayMs
  const batch = consolidationBatch(now, settings, timeZone)
  const current = record && record.batchId === batch.batchId ? record : null
  const attempts = Number.isSafeInteger(current?.attempts) ? Math.max(0, current.attempts) : 0
  const status = String(current?.status ?? '')
  const nextDate = addDays(batch.date, 1)
  const next = { batchId: batchIdFor(nextDate), date: nextDate, time: batch.time, timeZone }
  const base = { catchUp, batch, attempts, maxRetries, retryDelayMs, next }
  if (status === 'success' || status === 'committed') return { ...base, state: 'completed', canRun: false, reason: 'already-completed' }
  if (status === 'running') return { ...base, state: 'running', canRun: false, reason: 'already-running' }
  if (status === 'failed' && attempts >= maxRetries) {
    return { ...base, state: 'next-window', canRun: false, reason: 'retry-exhausted' }
  }
  if (status === 'failed' && current?.lastAttemptAt) {
    const retryAt = new Date(current.lastAttemptAt).getTime() + retryDelayMs
    if (Number.isFinite(retryAt) && new Date(now).getTime() < retryAt) {
      return { ...base, state: 'retry-wait', canRun: false, retryAt: new Date(retryAt).toISOString(), reason: 'retry-delay' }
    }
    return { ...base, state: 'retry-ready', canRun: true, retryAt: new Date(retryAt).toISOString(), reason: 'retry-allowed' }
  }
  if (batch.localMinutes < batch.scheduledMinutes) return { ...base, state: 'scheduled', canRun: false, reason: 'before-scheduled-time' }
  if (catchUp) return { ...base, state: 'catch-up', canRun: true, reason: 'missed-or-due' }
  return { ...base, state: 'missed', canRun: false, reason: 'catch-up-disabled' }
}
