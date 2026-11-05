/**
 * 一次性可行性探针:队友那套「SQLite + FTS5 + sqlite-vec + 外部模型 embedding」在
 * **这台机器、我们这套代码**上到底能不能落地。只读/只用内存库,不碰真库。
 *
 * 逐条回答:
 *   ① Node 24 的 node:sqlite 能不能加载扩展(loadExtension)?
 *   ② 它有没有编译进 FTS5?能不能建 fts5 虚表?
 *   ③ FTS5 对**中文**表现如何(默认 unicode61 / trigram 各试一遍)?
 *   ④ Python 侧能不能加载扩展?有没有装 sqlite-vec?
 *   ⑤ 本机有没有任何 embedding 模型运行时(ollama / sentence-transformers / openai key)?
 */
import { DatabaseSync } from 'node:sqlite'

const say = (s) => console.log(s)
say('【① node:sqlite 的扩展能力】')
try {
  const db = new DatabaseSync(':memory:')
  const hasEnable = typeof db.enableLoadExtension === 'function'
  const hasLoad = typeof db.loadExtension === 'function'
  say('  enableLoadExtension = ' + hasEnable + ' · loadExtension = ' + hasLoad)
  if (hasEnable) { try { db.enableLoadExtension(true); say('  enableLoadExtension(true) = 成功') } catch (e) { say('  enableLoadExtension(true) = 失败:' + e.message) } }

  say('【② FTS5 在不在(编译选项)】')
  try {
    db.exec('CREATE VIRTUAL TABLE t1 USING fts5(body)')
    db.exec("INSERT INTO t1(body) VALUES ('本地数据库做相似搜索')")
    const r = db.prepare("SELECT body FROM t1 WHERE t1 MATCH '相似'").all()
    say('  fts5 可建表 = 是 · 中文默认分词器匹配「相似」= ' + (r.length > 0 ? '命中' : '未命中(0 行)'))
  } catch (e) { say('  fts5 可建表 = 否 —— ' + e.message) }

  say('【③ FTS5 + trigram 分词器对中文(若可用)】')
  try {
    db.exec("CREATE VIRTUAL TABLE t2 USING fts5(body, tokenize='trigram')")
    db.exec("INSERT INTO t2(body) VALUES ('本地数据库做相似搜索')")
    for (const q of ['相似搜索', '数据库', '搜索']) {
      const r = db.prepare('SELECT body FROM t2 WHERE t2 MATCH ?').all(q)
      say('  查「' + q + '」→ ' + (r.length > 0 ? '命中' : '未命中'))
    }
  } catch (e) { say('  trigram 分词器 = 不可用 —— ' + e.message) }

  say('【编译选项里的相关项】')
  const opts = db.prepare('PRAGMA compile_options').all().map((r) => String(Object.values(r)[0]))
  say('  ' + opts.filter((o) => /FTS|JSON|ENABLE|THREADSAFE/i.test(o)).join(' · '))
  db.close()
} catch (e) { say('  node:sqlite 不可用:' + e.message) }
