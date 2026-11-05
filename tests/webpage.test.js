/**
 * v0.7.0 「审查台静态页伺服」(M6-a)离线电池:
 * 纯解析函数 + handler(假 req/res),不碰宿主不碰网络。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveWebFile, createWebPageHandler, webRootOf } from '../lib/webpage.js'

function webRoot () {
  const d = mkdtempSync(join(tmpdir(), 'echo-web-'))
  writeFileSync(join(d, 'index.html'), '<!DOCTYPE html><title>Echo</title>')
  writeFileSync(join(d, 'app.js'), "console.log('ok')")
  writeFileSync(join(d, 'style.css'), 'body{}')
  return d
}

test('webRootOf:包根的 web,不是 lib/web(M6-a 潜伏雷的回归门)', () => {
  // 装机位真实形状:lib/index.js 的模块 URL → webRoot 必须落在
  // 包根 web/。当年公式错成 lib/web,装机副本 /echo/ 404 半个月。
  const url = 'file:///C:/Users/x/.dsh/profiles/web/node_modules/dsh-echo/lib/index.js'
  const root = webRootOf(url).replaceAll('\\', '/')
  assert.equal(root, 'C:/Users/x/.dsh/profiles/web/node_modules/dsh-echo/web')
  // 仓库位同款:scripts/ 下的调用者也取到包根 web/
  const root2 = webRootOf('file:///C:/repo/dsh-echo/scripts/smoke_web.mjs').replaceAll('\\', '/')
  assert.equal(root2, 'C:/repo/dsh-echo/web')
})

test('resolveWebFile:根路径 → index.html,MIME 白名单', () => {
  const d = webRoot()
  try {
    const idx = resolveWebFile(d, '')
    assert.equal(idx.absPath, join(d, 'index.html'))
    assert.equal(idx.mime, 'text/html; charset=utf-8')
    assert.equal(resolveWebFile(d, '/').absPath, join(d, 'index.html'))
    const js = resolveWebFile(d, '/app.js')
    assert.equal(js.mime, 'text/javascript; charset=utf-8')
    const css = resolveWebFile(d, 'style.css')
    assert.equal(css.mime, 'text/css; charset=utf-8')
    // 大小写扩展名归一
    assert.equal(resolveWebFile(d, '/APP.JS')?.mime, 'text/javascript; charset=utf-8')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('resolveWebFile:穿越一律拒绝(明文/编码/盘符)', () => {
  const d = webRoot()
  try {
    assert.equal(resolveWebFile(d, '/../secret.txt'), null)
    assert.equal(resolveWebFile(d, '/../../etc/passwd'), null)
    assert.equal(resolveWebFile(d, '/sub/../../escape.js'), null)
    // %2e%2e%2f 编码穿越:decode 在 resolve 之前,与明文同罪
    assert.equal(resolveWebFile(d, '/%2e%2e%2fsecret.txt'), null)
    assert.equal(resolveWebFile(d, '/..%5csecret.txt'), null)
    // 盘符形态
    assert.equal(resolveWebFile(d, 'C:/Windows/system32'), null)
    // 无扩展名 / 白名单外类型 → 404
    assert.equal(resolveWebFile(d, '/noext'), null)
    assert.equal(resolveWebFile(d, '/evil.exe'), null)
    // 坏 UTF-8 编码 → null 不炸
    assert.equal(resolveWebFile(d, '/%ff%fe'), null)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

/** 假 res:收集状态/头/体。 */
function fakeRes () {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead (s, h) { this.status = s; this.headers = h },
    end (b) { this.body = b === undefined ? '' : String(b) }
  }
}

const fakeReq = (url, method = 'GET') => ({ url, method })

test('handler:200 + no-store + 正确 MIME;404;405', async () => {
  const d = webRoot()
  try {
    const handler = createWebPageHandler({ rootDir: d })
    // /echo/ → index.html,刷新永远拿最新(no-store)
    const r1 = fakeRes()
    await handler(fakeReq('/echo/'), r1)
    assert.equal(r1.status, 200)
    assert.equal(r1.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(r1.headers['cache-control'], 'no-store')
    assert.ok(r1.body.includes('<title>Echo</title>'))
    // /echo/app.js → JS MIME;query 不进文件路径
    const r2 = fakeRes()
    await handler(fakeReq('/echo/app.js?v=123'), r2)
    assert.equal(r2.status, 200)
    assert.equal(r2.headers['content-type'], 'text/javascript; charset=utf-8')
    // 穿越 → 404(前缀剥掉后是 ../)
    const r3 = fakeRes()
    await handler(fakeReq('/echo/../package.json'), r3)
    assert.equal(r3.status, 404)
    // 不存在的文件 → 404
    const r4 = fakeRes()
    await handler(fakeReq('/echo/missing.css'), r4)
    assert.equal(r4.status, 404)
    // 非 GET/HEAD → 405
    const r5 = fakeRes()
    await handler(fakeReq('/echo/', 'POST'), r5)
    assert.equal(r5.status, 405)
    // HEAD → 200 无体
    const r6 = fakeRes()
    await handler(fakeReq('/echo/', 'HEAD'), r6)
    assert.equal(r6.status, 200)
    assert.equal(r6.body, '')
  } finally { rmSync(d, { recursive: true, force: true }) }
})
