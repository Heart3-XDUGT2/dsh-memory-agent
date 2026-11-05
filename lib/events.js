/**
 * dsh-echo — SSE 半推通道(M3-c)
 * ============================================================
 * 审计流的真推送。先例:dsh-client-hmr 的 /plugins/events 事件流
 * (handler 同步写头即返回,连接由 res.on('close') 收尾;宿主压缩层
 * 明确保全 SSE 不动它)。
 *
 * 设计:服务端 3s 查审计增量(「半推」)—— 审计表是壳拥有的唯一
 * 事件日志,extract / 基线反思 / 心跳关怀三条写入路都过它,不用给
 * 每条写路径挂事件发射器,表即真相。推「有新行」信号而非行内容:
 * 行由客户端拉(审计卡已有 fresh 高亮与裁剪逻辑,不重复实现)。
 *
 * 游标 = 连接时的最新时间戳:不重放历史(历史由 /api/echo/audit
 * 自己拉);断线由浏览器 EventSource 内建自动重连,轮询兜底不变。
 */
export function createEchoEvents ({ store, intervalMs = 3000 }) {
  const connections = new Set()

  function readMaxAuditTs () {
    try {
      const row = store.db.prepare('SELECT MAX(timestamp) AS m FROM audit_logs').get()
      return Number(row?.m) || 0
    } catch {
      return 0
    }
  }

  /** 一个连接:写头 + 注释行 + 增量游标定时器。 */
  function attach (res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    res.write(': connected\n\n')
    let cursor = readMaxAuditTs()
    const timer = setInterval(() => {
      try {
        const rows = store.db.prepare(
          'SELECT timestamp FROM audit_logs WHERE timestamp > ?'
          + ' ORDER BY timestamp ASC LIMIT 50'
        ).all(cursor)
        if (rows.length > 0) {
          cursor = Number(rows[rows.length - 1].timestamp) || cursor
          res.write('event: audit\ndata: '
            + JSON.stringify({ upTo: cursor, count: rows.length }) + '\n\n')
        }
      } catch {
        // 库暂不可读(关库竞态等):下轮再试,连接不陪葬
      }
    }, intervalMs)
    if (typeof timer.unref === 'function') timer.unref()
    const entry = { res, timer }
    connections.add(entry)
    res.on('close', () => {
      clearInterval(timer)
      connections.delete(entry)
    })
  }

  /** 插件卸载:拆路由外的另一半 —— 销毁所有活连接(close 会清定时器)。 */
  function dispose () {
    for (const c of connections) {
      clearInterval(c.timer)
      try { c.res.destroy?.() } catch { }
    }
    connections.clear()
  }

  return { attach, dispose }
}
