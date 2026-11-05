#!/usr/bin/env node
/**
 * dsh-echo — 审查台静态页伺服冒烟(M6-a)
 * ============================================================
 * 不依赖 dsh web:临时起一个 http server 挂上 createWebPageHandler,
 * 断言页面可达 / MIME 正确 / 穿越被拒。队友改完 web/ 也能拿它自检。
 */
import { createServer, request } from 'node:http'
import { createWebPageHandler, webRootOf } from '../lib/webpage.js'

// v0.11.1:rootDir 不再手拼 —— 与 lib/index.js 同源(webRootOf),
// 冒烟测的就是装机接线的真公式(当年手拼对了,接线错了,冒烟
// 全绿也发现不了)。
const root = webRootOf(import.meta.url)

const server = createServer(createWebPageHandler({ rootDir: root }))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = 'http://127.0.0.1:' + port

let failed = 0
const check = (name, ok) => {
  console.log((ok ? '  ok ' : '  FAIL ') + name)
  if (!ok) failed += 1
}

// ① 首页可达,HTML,no-store
{
  const res = await fetch(base + '/echo/')
  const text = await res.text()
  check('GET /echo/ → 200 html', res.status === 200 && res.headers.get('content-type').startsWith('text/html'))
  check('no-store(刷新拿最新)', res.headers.get('cache-control') === 'no-store')
  check('页面标题在场', text.includes('Echo 审查台'))
}
// ② 静态资产 MIME
{
  const res = await fetch(base + '/echo/app.js')
  check('GET /echo/app.js → javascript', res.status === 200 && res.headers.get('content-type').startsWith('text/javascript'))
}
// ③ 404:不存在
{
  const res = await fetch(base + '/echo/nope.txt')
  check('不存在 → 404', res.status === 404)
}
// ④ 穿越:原始路径绕过 URL 归一(fetch 会归一,用 http.request 发原始串)
{
  const code = await new Promise((resolve) => {
    const r = request({ host: '127.0.0.1', port, path: '/echo/../package.json', method: 'GET' }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    r.on('error', () => resolve(-1))
    r.end()
  })
  check('穿越 /echo/../package.json → 404', code === 404)
}

server.close()
console.log(failed === 0 ? '\nsmoke_web: 全绿' : '\nsmoke_web: ' + failed + ' 项失败')
process.exit(failed === 0 ? 0 : 1)
