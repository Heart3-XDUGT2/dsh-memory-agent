/**
 * P2 · B1:数据 API(§6.3 第 2~7 条)的**整张状态码表**。
 *
 * 判定逻辑全是纯函数(`lib/data-write.js` 的 `handleDataRequest`),所以这里拿临时目录
 * 就能把 200/400/403/404/405/500 逐条跑穿 —— 不需要起宿主。
 * 前端与真机验收走 `docs/CONFIG_CENTER_CURL.md` 的 curl 清单。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import {
  buildExportBundle, handleDataRequest, importBundle
} from '../lib/data-write.js'
import { DATA_FILES, emptyTemplate } from '../lib/data-schema.js'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

function withDir (fn) {
  const dir = mkdtempSync(join(tmpdir(), 'echo-dataapi-'))
  assert.ok(dir.startsWith(tmpdir()), '测试目录必须在临时目录里:' + dir)
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// 便捷:一次请求
const ask = (dir, method, url, { body = null, allowed = true } = {}) =>
  handleDataRequest({ method, url, body, allowed, dir, now: '2026-10-05T08:00:00.000Z' })

const goodProfile = (userName = '某人') => ({ ...emptyTemplate('profile.json'), userName })

test('路径与白名单:echo.db / 未知文件 / 多级路径 ⇒ 404;不认识的前缀也 404', () => {
  withDir((dir) => {
    for (const url of [
      '/api/echo/data/echo.db',
      '/api/echo/data/nope.json',
      '/api/echo/data/profile.json/extra/deep',
      '/api/echo/other/thing'
    ]) {
      const r = ask(dir, 'GET', url)
      assert.equal(r.status, 404, url)
    }
    assert.equal(ask(dir, 'GET', '/api/echo/data/backup').status, 405, 'backup 只认 POST')
    assert.equal(ask(dir, 'GET', '/api/echo/data/export', { allowed: false }).status, 200, '导出是只读,不需要写保护')
    assert.deepEqual(readdirSync(dir), [], '被拒的请求不许留下任何文件')
  })
})

test('GET:正常文件回 value 不带 raw;坏文件回 raw(才修得动);?raw=1 强制回原文', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(goodProfile(), null, 2), 'utf8')
    const ok = ask(dir, 'GET', '/api/echo/data/profile.json')
    assert.equal(ok.status, 200)
    assert.equal(ok.payload.file, 'profile.json')
    assert.equal(ok.payload.exists, true)
    assert.equal(ok.payload.value.userName, '某人')
    assert.equal('raw' in ok.payload, false, '好文件不塞第二遍原文')
    assert.ok(ok.payload.template !== undefined, '回包要带空模板(⑧ 页重建/新装用)')

    const forced = ask(dir, 'GET', '/api/echo/data/profile.json?raw=1')
    assert.equal(typeof forced.payload.raw, 'string')
    assert.equal(forced.payload.raw, readFileSync(join(dir, 'profile.json'), 'utf8'))
    assert.equal(forced.payload.unreadable, undefined, '能读出来就别乱标 unreadable')

    // 坏 JSON ⇒ 200 + value:null + raw + parseError(用户 2026-10-05 明确的 raw 语义)
    writeFileSync(join(dir, 'lexicon.json'), '{ 这不是 JSON', 'utf8')
    const broken = ask(dir, 'GET', '/api/echo/data/lexicon.json')
    assert.equal(broken.status, 200)
    assert.equal(broken.payload.value, null)
    assert.equal(broken.payload.unreadable, true)
    assert.equal(broken.payload.raw, '{ 这不是 JSON')
    assert.ok(broken.payload.parseError.length > 0)

    // 文件不在 ⇒ 200 exists:false(不是 404 —— 404 只留给白名单外);回包带空模板给 ⑧ 页重建用
    const none = ask(dir, 'GET', '/api/echo/data/names.json')
    assert.equal(none.status, 200)
    assert.deepEqual(
      { ...none.payload, template: undefined },
      { file: 'names.json', exists: false, value: null, bytes: 0, template: undefined }
    )
    assert.equal(none.payload.template.schemaRev, 1, '回包要带该文件的空模板')
    assert.ok(Array.isArray(none.payload.template.speakers), 'names.json 模板形状要对')
  })
})

test('PUT:没有写保护 ⇒ 403,且文件一字不动(连备份都不产生)', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(goodProfile('旧的'), null, 2), 'utf8')
    const before = readFileSync(join(dir, 'profile.json'), 'utf8')
    const r = ask(dir, 'PUT', '/api/echo/data/profile.json', { body: goodProfile('新的'), allowed: false })
    assert.equal(r.status, 403)
    assert.equal(readFileSync(join(dir, 'profile.json'), 'utf8'), before)
    assert.equal(existsSync(join(dir, 'backup')), false)
  })
})

test('PUT:坏内容 ⇒ 400 + 明细,文件不变、无备份;坏 JSON body ⇒ 400', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(goodProfile('旧的'), null, 2), 'utf8')
    const before = readFileSync(join(dir, 'profile.json'), 'utf8')
    const r = ask(dir, 'PUT', '/api/echo/data/profile.json', { body: { schemaRev: 'x' } })
    assert.equal(r.status, 400)
    assert.ok(r.payload.errors.length > 0)
    assert.equal(readFileSync(join(dir, 'profile.json'), 'utf8'), before)
    assert.equal(existsSync(join(dir, 'backup')), false, '校验不过 ⇒ 不该有备份')

    assert.equal(ask(dir, 'PUT', '/api/echo/data/profile.json', { body: null }).status, 400, 'body 解析失败')
    assert.equal(ask(dir, 'PUT', '/api/echo/data/profile.json', { body: ['数组不行'] }).status, 400)
  })
})

test('PUT:好内容 ⇒ 200 + 备份(旧内容)+ effective;落盘是完整替换', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(goodProfile('旧的'), null, 2), 'utf8')
    const oldText = readFileSync(join(dir, 'profile.json'), 'utf8')
    const r = ask(dir, 'PUT', '/api/echo/data/profile.json', { body: goodProfile('新的') })
    assert.equal(r.status, 200)
    assert.equal(r.payload.ok, true)
    assert.equal(r.payload.effective, 'now')
    assert.equal(r.payload.savedAt, '2026-10-05T08:00:00.000Z')
    assert.ok(r.payload.backupPath.includes('backup'), r.payload.backupPath)
    assert.equal(readFileSync(r.payload.backupPath, 'utf8'), oldText, '备份 = 写之前的旧内容')
    assert.equal(JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')).userName, '新的')

    // 名字不对的文件名(大小写/空格)也算白名单外
    assert.equal(ask(dir, 'PUT', '/api/echo/data/Profile.json', { body: goodProfile() }).status, 404)
  })
})

test('validate ⇒ 200 且不落盘;方法不对 ⇒ 405', () => {
  withDir((dir) => {
    const r = ask(dir, 'POST', '/api/echo/data/persona.json/validate', { body: { schemaRev: 1, prefix: 'x', suffix: '' } })
    assert.equal(r.status, 200)
    assert.equal(r.payload.ok, true)
    assert.equal(r.payload.file, 'persona.json')
    assert.equal(existsSync(join(dir, 'persona.json')), false, '干跑不许落盘')

    const bad = ask(dir, 'POST', '/api/echo/data/persona.json/validate', { body: { schemaRev: 0 } })
    assert.equal(bad.status, 200)
    assert.equal(bad.payload.ok, false)
    assert.equal(ask(dir, 'GET', '/api/echo/data/persona.json/validate').status, 405)
    assert.equal(ask(dir, 'POST', '/api/echo/data/echo.db/validate', { body: {} }).status, 404)
  })
})

test('backup:要写保护;指定一个文件 / 全部;白名单外 ⇒ 404', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(goodProfile(), null, 2), 'utf8')
    assert.equal(ask(dir, 'POST', '/api/echo/data/backup', { body: {}, allowed: false }).status, 403)

    const one = ask(dir, 'POST', '/api/echo/data/backup', { body: { file: 'profile.json' } })
    assert.equal(one.status, 200)
    assert.equal(one.payload.ok, true)
    assert.ok(one.payload.path.includes('backup'))
    assert.equal(one.payload.files.length, 1)
    assert.equal(one.payload.files[0].backedUp, true)

    const all = ask(dir, 'POST', '/api/echo/data/backup', { body: {} })
    assert.equal(all.status, 200)
    assert.equal(all.payload.files.length, DATA_FILES.length, '不指定就备份全部 8 个')
    assert.equal(all.payload.path, '', '多个文件时 path 为空,明细在 files[]')
    assert.equal(ask(dir, 'POST', '/api/echo/data/backup', { body: { file: 'echo.db' } }).status, 404)
  })
})

test('export:只含白名单文件、列出缺的、结构上不含 echo.db', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(goodProfile(), null, 2), 'utf8')
    writeFileSync(join(dir, 'lexicon.json'), '{ 坏', 'utf8')   // 读不出来的进 missing
    const r = ask(dir, 'GET', '/api/echo/data/export')
    assert.equal(r.status, 200)
    const b = r.payload
    assert.equal(b.program, 'echo')
    assert.equal(b.schemaRev, 1)
    assert.deepEqual(Object.keys(b.files), ['profile.json'])
    assert.equal(b.files['profile.json'].userName, '某人')
    for (const f of DATA_FILES) {
      if (f !== 'profile.json') assert.ok(b.missing.includes(f), f + ' 该进 missing')
    }
    const names = [...Object.keys(b.files), ...b.missing]
    assert.ok(!names.includes('echo.db'), 'echo.db 永远不进导出')
    assert.ok(!names.includes('config.json') || b.missing.includes('config.json'))
    assert.equal(JSON.stringify(b).includes('echo.db'), false)
  })
})

test('import:白名单外 / 不过校验 / 空包 ⇒ 整包不落盘(文件一个字节都不变)', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(goodProfile('旧的'), null, 2), 'utf8')
    const before = readFileSync(join(dir, 'profile.json'), 'utf8')

    const outside = ask(dir, 'POST', '/api/echo/data/import', { body: { confirm: true, bundle: { files: { 'echo.db': {}, 'profile.json': goodProfile('新的') } } } })
    assert.equal(outside.status, 404)
    assert.ok(outside.payload.errors.some((e) => /echo\.db/.test(e)))
    assert.equal(readFileSync(join(dir, 'profile.json'), 'utf8'), before, '有越界文件 ⇒ 连别的文件也不许写')

    const invalid = ask(dir, 'POST', '/api/echo/data/import', { body: { confirm: true, bundle: { files: { 'profile.json': { schemaRev: 'x' } } } } })
    assert.equal(invalid.status, 400)
    assert.equal(readFileSync(join(dir, 'profile.json'), 'utf8'), before)

    assert.equal(ask(dir, 'POST', '/api/echo/data/import', { body: { confirm: true, bundle: { files: {} } } }).status, 400)
    assert.equal(ask(dir, 'POST', '/api/echo/data/import', { body: { bundle: { files: { 'profile.json': goodProfile() } } } }).status, 400, '缺 confirm')
    assert.equal(ask(dir, 'POST', '/api/echo/data/import', { body: { confirm: true, bundle: '不是对象' } }).status, 400)
    assert.equal(existsSync(join(dir, 'backup')), false, '整包被拒 ⇒ 不该产生备份')
  })
})

test('import:好包 ⇒ 先备份后覆盖,回备份明细;无写保护 ⇒ 403', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(goodProfile('旧的'), null, 2), 'utf8')
    const oldText = readFileSync(join(dir, 'profile.json'), 'utf8')
    assert.equal(ask(dir, 'POST', '/api/echo/data/import', { body: { confirm: true, bundle: { files: { 'profile.json': goodProfile('新的') } } }, allowed: false }).status, 403)

    const r = ask(dir, 'POST', '/api/echo/data/import', {
      body: { confirm: true, bundle: { files: { 'profile.json': goodProfile('新的'), 'names.json': emptyTemplate('names.json') } } }
    })
    assert.equal(r.status, 200)
    assert.deepEqual(r.payload.imported.map((x) => x.file).sort(), ['names.json', 'profile.json'])
    assert.equal(r.payload.backups.length, 1, '只有本来就存在的文件才需要备份')
    assert.equal(r.payload.backups[0].file, 'profile.json')
    assert.equal(readFileSync(r.payload.backups[0].path, 'utf8'), oldText, '备份必须是被覆盖前的旧内容')
    assert.equal(JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')).userName, '新的')
  })
})

test('导出 → 导入 一轮回:内容不变(整包搬运不丢字段)', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(goodProfile('他'), null, 2), 'utf8')
    writeFileSync(join(dir, 'names.json'), JSON.stringify({ ...emptyTemplate('names.json'), speakers: ['用户'] }, null, 2), 'utf8')
    const bundle = buildExportBundle({ dir })
    const back = importBundle(bundle, { dir })
    assert.equal(back.ok, true)
    assert.equal(JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8')).userName, '他')
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'names.json'), 'utf8')).speakers, ['用户'])
  })
})

test('backups 清单(⑧ 页):只读、只列不删、倒序、可过滤、不泄露路径', () => {
  withDir((dir) => {
    assert.deepEqual(ask(dir, 'GET', '/api/echo/data/backups').payload, { ok: true, count: 0, files: [] })
    writeFileSync(join(dir, 'profile.json'), JSON.stringify(goodProfile(), null, 2), 'utf8')
    assert.equal(ask(dir, 'PUT', '/api/echo/data/profile.json', { body: goodProfile('新的') }).status, 200)

    const r = ask(dir, 'GET', '/api/echo/data/backups')
    assert.equal(r.payload.ok, true)
    assert.equal(r.payload.count, 1)
    const row = r.payload.files[0]
    assert.equal(row.file, 'profile.json', '认得出来是哪个文件的备份')
    assert.ok(row.name.startsWith('profile.json.'))
    assert.ok(row.bytes > 0)
    assert.ok(typeof row.mtime === 'string' && row.mtime.includes('T'), 'mtime 是 ISO 串')
    assert.ok(!row.name.includes(':') && !row.name.includes('\\') && !row.name.includes('/'),
      '回包不许泄露文件系统路径(视图只该看到文件名)')

    assert.equal(ask(dir, 'GET', '/api/echo/data/backups?file=names.json').payload.count, 0)
    assert.equal(ask(dir, 'GET', '/api/echo/data/backups?file=profile.json').payload.count, 1)
    assert.equal(ask(dir, 'GET', '/api/echo/data/backups?limit=1').payload.count, 1)

    // 只读:POST 不认;而且**根本没有删除路由**(⑧ 页"只列不删"是硬纪律)
    assert.equal(ask(dir, 'POST', '/api/echo/data/backups', { body: {} }).status, 405)
    assert.equal(ask(dir, 'DELETE', '/api/echo/data/backups').status, 405)
    assert.equal(ask(dir, 'DELETE', '/api/echo/data/backup').status, 405)
    assert.equal(ask(dir, 'POST', '/api/echo/data/backup/delete', { body: {} }).status, 404)
    assert.equal(existsSync(join(dir, 'backup')), true, '备份还在')
    assert.equal(readdirSync(join(dir, 'backup')).length, 1)
  })
})

test('接线(源码扫描):前缀路由、写保护、判定在 data-write.js;路由里不许自己落盘', () => {  const src = readFileSync(join(REPO, 'lib', 'index.js'), 'utf8')
  assert.ok(/path: '\/api\/echo\/data'/.test(src), '缺 /api/echo/data 路由')
  const at = src.indexOf("path: '/api/echo/data'")
  const block = src.slice(Math.max(0, at - 600), at + 900)   // kind 在 path 之前,窗口往前开
  // 先剥注释再扫:注释里提到 echo.db / writeFileSync 是说明文字,不算代码
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n]*$/gm, '')
  assert.ok(/kind: 'prefix'/.test(code), 'data 路由必须是前缀路由(要接 :file)')
  assert.ok(/handleDataRequest\(/.test(code), '判定必须交给 lib/data-write.js')
  assert.ok(/writeAllowed\(req\)/.test(code), '写保护必须在端点层过一遍')
  assert.ok(!/writeFileSync|renameSync|backupDataFile\(/.test(code), '端点层不许自己落盘(时序只在 data-write.js 里)')
  assert.ok(!/echo\.db/.test(code), '端点层不该出现 echo.db(白名单判定在判定层)')
})
