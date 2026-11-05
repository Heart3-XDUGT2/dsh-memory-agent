/**
 * 一次性只读小工具:把记忆架构的**事实**打到屏幕上(给"队友问答"用)。
 * 不写库、不改配置。用法:node scripts/arch-facts.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const dbPath = process.env.DSH_ECHO_DB ?? join(homedir(), '.dsh', 'echo', 'echo.db')
if (!existsSync(dbPath)) {
  console.log('找不到库:' + dbPath)
  process.exit(1)
}
const db = new DatabaseSync(dbPath, { readOnly: true })
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name)
console.log('【存储】' + dbPath)
console.log('  引擎 = SQLite(node:sqlite / python sqlite3 同一文件两个写者)')
console.log('  表(' + tables.length + '):' + tables.join(', '))
const counts = [
  ['episodic_memory', '情景记忆'],
  ['graph_nodes', '图谱节点'],
  ['graph_edges', '图谱边'],
  ['pending_threads', '悬置话题'],
  ['audit_logs', '审计行'],
  ['conversation_log', '对话回放'],
  ['diary', '日记页']
]
const parts = []
for (const [t, label] of counts) {
  try {
    const n = db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n
    parts.push(label + ' ' + n)
  } catch { /* 表不在就跳过 */ }
}
console.log('  现有数据:' + parts.join(' · '))
// 有没有任何一列叫 embedding / vector(直接回答"用没用 embedding")
const cols = []
for (const t of tables) {
  for (const c of db.prepare('PRAGMA table_info(' + t + ')').all()) {
    if (/embed|vector|vec_|dim/i.test(String(c.name))) cols.push(t + '.' + c.name)
  }
}
console.log('【向量列】' + (cols.length === 0 ? '全库没有任何 embedding/vector 列' : cols.join(', ')))
db.close()
