/**
 * dsh-echo — 审查台静态页伺服(M6-a)
 * ============================================================
 * 前端队友的页面住在 web/ 目录,本模块把它伺服到 /echo/ 前缀:
 * 同源 → 页面里 fetch /api/echo/* 与 EventSource 直接可用,零 CORS
 * 零代理零第二个进程。
 *
 * 迭代循环质变:**每请求现读文件** —— 改 web/ → install(拷贝)→
 * 浏览器刷新,不用重启 dsh web(对比 client.js:改一个字也要重启 +
 * 硬刷新)。no-store 头保证刷新永远拿到最新文件。
 *
 * 安全:路径解析后必须仍在 web/ 内(穿越一律 404);decodeURIComponent
 * 在 resolve 之前 —— %2e%2e%2f 编码穿越与明文 ../ 同罪。
 */
import { readFile } from 'node:fs/promises'
import { join, resolve, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
}

/**
 * v0.11.1 修(M6-a 潜伏雷):审查台 webRoot 的唯一公式 —— 模块 URL
 * 上两级(= 包根)再进 web/。lib/index.js、smoke_web、装机自检三方
 * 共用,公式进电池:webRootOf('…/dsh-echo/lib/index.js') 必须落在
 * …/dsh-echo/web。当年 index.js 写成 dirname+'web' = lib/web(装机
 * 副本里不存在),/echo/ 从 M6-a 起 404 半个月没人发现 —— smoke 只
 * 测了显式传 rootDir 的纯函数,接线公式无人验。
 */
export function webRootOf (metaUrl) {
  return join(dirname(dirname(fileURLToPath(metaUrl))), 'web')
}

/**
 * 纯解析:webServer 前缀路由剥掉 /echo 后的路径 → web/ 内的绝对路径
 * + MIME。根路径 → index.html;穿越/无扩展名 → null(404)。
 * 纯函数,离线可测。
 */
export function resolveWebFile (rootDir, urlPath) {
  let rel = String(urlPath || '')
  try { rel = decodeURIComponent(rel) } catch { return null }
  if (rel === '' || rel === '/') rel = 'index.html'
  // 反斜杠/多斜杠归一;首部斜杠剥掉
  rel = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (rel === '') rel = 'index.html'
  // 穿越与盘符:任何 .. 段、绝对路径形态、盘符形态都拒绝
  if (/(^|\/)\.\.(\/|$)/.test(rel)) return null
  if (/^[a-zA-Z]:/.test(rel)) return null
  const dot = rel.lastIndexOf('.')
  if (dot === -1 || dot === rel.length - 1) return null // 无扩展名 → 404
  const ext = rel.slice(dot).toLowerCase()
  const mime = MIME[ext]
  if (mime === undefined) return null // 白名单外类型不伺服
  const abs = resolve(join(rootDir, rel))
  const rootAbs = resolve(rootDir)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return null
  return { absPath: abs, mime }
}

/**
 * 造一个前缀路由 handler(req, res)。每请求现读文件;ENOENT → 404;
 * 读失败 → 500(宿主对已发头的抛错另有处置,这里头未发,自己收尾)。
 */
export function createWebPageHandler ({ rootDir }) {
  return async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    // 前缀路由剥 /echo:pathname 去掉前缀,query 不进文件路径
    let pathname = '/'
    try { pathname = new URL(req.url || '/', 'http://echo.local').pathname } catch { }
    const prefix = '/echo'
    let rel = pathname
    if (rel === prefix || rel.startsWith(prefix + '/')) rel = rel.slice(prefix.length)
    const file = resolveWebFile(rootDir, rel)
    if (file === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    try {
      const body = await readFile(file.absPath)
      res.writeHead(200, {
        'content-type': file.mime,
        'cache-control': 'no-store', // 刷新永远拿最新 —— 迭代循环的根
        'x-echo-web': '1'
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    }
  }
}
