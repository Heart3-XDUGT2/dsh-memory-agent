/** 037-C2审计：只用内存，不加载产品/store或真实库。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQQSendAudit } from '../lib/qq-send-audit.js'

function rig () {
  const rows = [], session = { id: 'synthetic-audit-session' }, agent = {}
  agent.session = session
  const audit = createQQSendAudit({ writeAudit: row => rows.push(row), id: () => 'unique-row' })
  return { rows, session, agent, audit }
}
const value = { ok: true, state: 'confirmed', code: 'CONFIRMED',
  ref: 'private-directory/report.txt', name: 'report.txt', bytes: 32,
  file_id: 'private-id', rawText: 'private-text', data: 'private-base64', path: 'private-path' }

test('037-C2审计：换轮后只写原native轮trace，且只投影安全文件信息', () => {
  const h = rig()
  h.audit.noteClaim({ agent: h.agent, turn: 1 }, { hasQuery: true, turnTrace: 'first-trace' })
  const context = h.audit.capture({ session: h.session, turn: 1 })
  h.audit.noteClaim({ agent: h.agent, turn: 2 }, { hasQuery: true, turnTrace: 'later-trace' })
  h.audit.record({ context, value })
  assert.equal(h.rows.length, 1)
  const row = h.rows[0], detail = JSON.parse(row.stageDetail)
  assert.equal(row.turnTraceCaptured, true)
  assert.equal(row.stage, 'qq_file_send')
  assert.equal(row.toolCall, 'echo_qq_file_send')
  assert.equal(detail.turnTrace, 'first-trace')
  assert.equal(detail.sourceTurn, 1)
  assert.deepEqual({ name: detail.name, bytes: detail.bytes, state: detail.state, code: detail.code },
    { name: 'report.txt', bytes: 32, state: 'confirmed', code: 'CONFIRMED' })
  assert.doesNotMatch(JSON.stringify(row), /private-|later-trace|ref|data|file_id|rawText|path/)
  h.audit.record({ context, value })
  assert.equal(h.rows.length, 1)
})

test('037-C2审计：无trace的本轮固定为空，不借用相同sid较早或较晚轮次', () => {
  const h = rig()
  h.audit.noteClaim({ agent: h.agent, turn: 1 }, { hasQuery: true, turnTrace: 'old-trace' })
  h.audit.noteClaim({ agent: h.agent, turn: 2 }, { hasQuery: false, turnTrace: 'old-trace' })
  const context = h.audit.capture({ session: h.session, turn: 2 })
  h.audit.noteClaim({ agent: h.agent, turn: 3 }, { hasQuery: true, turnTrace: 'new-trace' })
  h.audit.record({ context, value })
  assert.equal(JSON.parse(h.rows[0].stageDetail).turnTrace, '')
  const other = h.audit.capture({ session: { id: h.session.id }, turn: 3 })
  h.audit.record({ context: other, value })
  assert.equal(JSON.parse(h.rows[1].stageDetail).turnTrace, '')
})

test('037-C2审计：同一native轮的空输入保留已捕获trace，伪上下文拒绝', () => {
  const h = rig()
  h.audit.noteClaim({ agent: h.agent, turn: 1 }, { hasQuery: true, turnTrace: 'same-turn-trace' })
  h.audit.noteClaim({ agent: h.agent, turn: 1 }, { hasQuery: false, turnTrace: 'ignored-trace' })
  const context = h.audit.capture({ session: h.session, turn: 1 })
  assert.equal(context.turnTrace, 'same-turn-trace')
  assert.equal(Object.isFrozen(context), true)
  h.audit.record({ context: { ...context }, value })
  assert.equal(h.rows.length, 0)
  h.audit.record({ context, value })
  assert.equal(h.rows.length, 1)
})

test('037-C2审计：观察异常不影响业务，未知码和不安全叶名不落入证据', () => {
  const h = rig(), context = h.audit.capture({ session: h.session, turn: 1 })
  h.audit.record({ context, value: { state: 'unknown', code: 'PRIVATE_ERROR',
    name: 'C:\\private\\secret', bytes: 9, error: 'private-error' } })
  const detail = JSON.parse(h.rows[0].stageDetail)
  assert.equal(detail.code, 'UNCONFIRMED')
  assert.equal(Object.hasOwn(detail, 'name'), false)
  assert.doesNotMatch(JSON.stringify(h.rows), /PRIVATE_ERROR|secret|private-error/)
  const broken = createQQSendAudit({ writeAudit: () => { throw Error('synthetic') } })
  assert.doesNotThrow(() => broken.record({
    context: broken.capture({ session: h.session, turn: 1 }), value
  }))
})
