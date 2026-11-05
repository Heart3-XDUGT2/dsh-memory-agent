/**
 * profile.json 的唯一读点(P1d)。
 *
 * 端点的降级形状就钉在这里:**没填 ⇒ 中性角色词**(用户 / 助手),绝不留真名;
 * 坏文件 / 缺文件 ⇒ 空画像,永不抛。面板只认 `GET /api/echo/profile` 这一个出口。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadProfile, publicProfile, EMPTY_PROFILE } from '../lib/profile.js'

const withTmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-profile-'))
  try { return fn(join(dir, 'profile.json'), dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('P1d:loadProfile —— 缺文件/坏文件/脏值逐字段降级,永不抛', () => {
  withTmp((p) => {
    assert.deepEqual(loadProfile(p), EMPTY_PROFILE, '缺文件 ⇒ 空画像')
    assert.deepEqual(loadProfile(null), EMPTY_PROFILE)
    writeFileSync(p, '{坏', 'utf8')
    assert.deepEqual(loadProfile(p), EMPTY_PROFILE, '坏 JSON ⇒ 空画像')
    writeFileSync(p, '[1,2]', 'utf8')
    assert.deepEqual(loadProfile(p), EMPTY_PROFILE, '不是对象 ⇒ 空画像')
    writeFileSync(p, JSON.stringify({ userName: 42, userAliases: '不是数组', nicknameStrict: '真' }), 'utf8')
    const v = loadProfile(p)
    assert.equal(v.userName, '', '非字符串 ⇒ 空串')
    assert.deepEqual(v.userAliases, [])
    assert.equal(v.nicknameStrict, null, '非布尔 ⇒ null')
    writeFileSync(p, JSON.stringify({
      userName: ' 阿岚 ', userAliases: [' 他 ', '阿岚', '', 7], agentName: 'Echo', locale: 'zh-CN'
    }), 'utf8')
    const n = loadProfile(p)
    assert.equal(n.userName, '阿岚', 'trim')
    assert.deepEqual(n.userAliases, ['他', '阿岚'], '去空白 / 丢非字符串 / 去重')
    assert.equal(n.agentName, 'Echo')
  })
})

test('P1d:publicProfile —— 没填就发中性角色词(代码里不许留真名)', () => {
  withTmp((p) => {
    const dflt = publicProfile(p)
    assert.equal(dflt.userName, '用户', '没填时面板显示「用户」')
    assert.equal(dflt.agentName, '助手')
    assert.equal(dflt.agentSelfRef, '助手')
    assert.deepEqual(dflt.userAliases, [], '没填 ⇒ 空数组(前端据此退化正则/人称集合)')
    assert.equal(dflt.locale, 'zh-CN')
    // P2 §6.2 ④(2026-10-05):索引前缀 / 兜底称呼也进数据;没填 ⇒ 前缀空(面板用「对」)、兜底中性
    assert.equal(dflt.uiIndexPrefix, '', '没填 ⇒ 空(面板自己用默认「对」)')
    assert.equal(dflt.fallbackAddress, '用户', '没填 ⇒ 中性「用户」,不留真名')

    writeFileSync(p, JSON.stringify({
      userName: '阿岚', userAliases: ['他'], agentName: 'Echo', agentSelfRef: 'Echo',
      agentAliases: ['小e'], locale: 'zh-CN', timezone: 'Asia/Shanghai',
      uiIndexPrefix: '对', fallbackAddress: '喂'
    }), 'utf8')
    assert.deepEqual(publicProfile(p), {
      userName: '阿岚', userAliases: ['他'], agentName: 'Echo', agentSelfRef: 'Echo',
      agentAliases: ['小e'], uiIndexPrefix: '对', fallbackAddress: '喂',
      locale: 'zh-CN', timezone: 'Asia/Shanghai'
    }, '填了就用填的(逐字段覆盖兜底);agentAliases 是识别层,一起发出去')
  })
})

test('P1d:端点接线 —— /api/echo/profile 只读一个出口;前端不许读文件', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes("path: '/api/echo/profile'"), '端点必须注册')
  assert.ok(src.includes("if (req.method !== 'GET')"), '只许 GET')
  assert.ok(/json\(res, 200, publicProfile\(\)\)/.test(src), '回包 = publicProfile()(唯一读点)')
  assert.ok(src.includes("from './profile.js'"), 'index.js 必须用唯一读点')
  // 面板侧:app.js 必须走这个端点取称呼(P1d 的正面要求 —— 不写死、不读文件)。
  // audit-view.js 的 actor 兜底由 P1d 那批一起收口,这里只钉"出口只有一个"。
  const web = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8')
  assert.ok(web.includes('/api/echo/profile'), 'app.js 必须从 /api/echo/profile 取称呼')
  const profileSrc = readFileSync(new URL('../lib/profile.js', import.meta.url), 'utf8')
  // 只看代码(注释里会提到"阿岚"这种旧硬编码,那是说明文字,不是兜底值)
  const codeOnly = profileSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(!/['"]阿岚['"]/.test(codeOnly), '读点里不许有真名(兜底只能是中性角色词)')
})
