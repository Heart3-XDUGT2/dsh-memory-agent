/**
 * P1b 模块1 的"会写盘"那半边:loadPersona / savePersona 的语义。
 *
 * ★ 为什么单独一个文件(而且 env 设在任何 import 之前):
 *   路径在**进程内第一次问到就定死**(P1a 的不变量),所以要把家指到临时目录,
 *   必须在这个进程里**任何 import 之前**设好 env。这与 tests/toggle.test.js
 *   是同一个姿势 —— 2026-09-26 我真把测试值写进过他的真实配置,那次的教训。
 *   下面还有一道隔离闸:路径不在临时目录里就当场炸整片。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'echo-persona-io-'))
process.env.ECHO_DATA_DIR = HOME

const {
  loadPersona, savePersona, classifyPersonaFile, legacyPersonaDefaults,
  PERSONA_PATH, LEGACY_PERSONA_PATH, PERSONA_MAX_CHARS
} = await import('../lib/persona.js')

// ★ 隔离闸:人格/史料路径必须落在临时目录里,否则一个字节都不许写
for (const p of [PERSONA_PATH, LEGACY_PERSONA_PATH]) {
  assert.ok(
    p.startsWith(tmpdir()),
    '测试路径跑到临时目录之外了,它会改到他的真实人格文件:' + p
  )
}

const write = (obj) => writeFileSync(
  PERSONA_PATH,
  typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2),
  'utf8'
)
const raw = () => readFileSync(PERSONA_PATH, 'utf8')

after(() => rmSync(HOME, { recursive: true, force: true }))

test('隔离闸:人格与史料路径都指着临时家', () => {
  assert.equal(PERSONA_PATH, join(HOME, 'persona.json'))
  assert.equal(LEGACY_PERSONA_PATH, join(HOME, 'persona-legacy-defaults.json'))
})

test('文件不在 ⇒ 不注入,而且**不写盘**(读人格不再是"顺手写个出厂底稿")', async () => {
  if (existsSync(PERSONA_PATH)) rmSync(PERSONA_PATH)
  const r = await loadPersona()
  assert.equal(r.prefix, '')
  assert.equal(r.suffix, '')
  assert.equal(r.customized, false)
  assert.equal(existsSync(PERSONA_PATH), false, 'P1b:缺文件不许再写一个出厂底稿')
})

test('空 persona.json ⇒ 不注入:空就是空,不回落出厂文本', async () => {
  write({ schemaRev: 1, prefix: '', suffix: '', edited: false, savedAt: null })
  const r = await loadPersona()
  assert.equal(r.prefix, '', '空人格不许被出厂文本顶上(P1b 的核心改动)')
  assert.equal(r.suffix, '')
})

test('损坏文件 ⇒ 不注入,且盘上字节一动不动(宁可这次不注入,不许清空他写的字)', async () => {
  const broken = '{"prefix": "他的话", "suffix": '
  write(broken)
  const r = await loadPersona()
  assert.equal(r.prefix, '')
  assert.equal(r.suffix, '')
  assert.equal(raw(), broken, '损坏文件不许被覆盖')
})

test('他编辑过的文本 ⇒ 原样尊重,customized=true,文件被动=false', async () => {
  const mine = {
    prefix: '我的前段', suffix: '我的尾段', edited: true, defaultsRev: 3, savedAt: '2026-10-01T00:00:00.000Z'
  }
  const before = JSON.stringify(mine, null, 2)
  write(mine)
  const r = await loadPersona()
  assert.deepEqual(
    { prefix: r.prefix, suffix: r.suffix, customized: r.customized },
    { prefix: '我的前段', suffix: '我的尾段', customized: true }
  )
  assert.equal(r.legacyDefault, undefined, '他写的文本不该被当成旧默认')
  assert.equal(raw(), before, '他的字一个字节都不许改')
})

test('旧默认副本(rev 落后)⇒ 文本一字不动,只补 legacyDefault:true', async () => {
  const old = {
    prefix: '前段', suffix: '旧尾段', edited: false, defaultsRev: 1, savedAt: '2026-09-23T00:00:00.000Z'
  }
  write(old)
  const r = await loadPersona()
  assert.equal(classifyPersonaFile(old), 'stale')
  assert.equal(r.prefix, '前段')
  assert.equal(r.suffix, '旧尾段', '旧默认的文本必须留着 —— 不静默清空')
  assert.equal(r.legacyDefault, true, '要能标出来"这是插件写的旧默认"')
  const after2 = JSON.parse(raw())
  assert.equal(after2.prefix, old.prefix, '文本没动')
  assert.equal(after2.suffix, old.suffix, '文本没动')
  assert.equal(after2.legacyDefault, true, '标记落了盘')
  assert.equal(after2.edited, false, 'edited 不许被顺手改成 true(他并没有编辑过)')
  assert.equal(after2.savedAt, old.savedAt, '旧的时间戳也别抹掉')
})

test('旧默认副本(无 rev 标记,靠史料文本命中)⇒ 同样只标记不覆盖', async () => {
  writeFileSync(LEGACY_PERSONA_PATH, JSON.stringify({
    schemaRev: 1,
    finalDefaultsRev: 3,
    finalDefault: { prefix: '前段', suffix: '今版尾段' },
    staleDefaults: [{ rev: 0, prefix: '前段', suffix: '旧尾段 0' }]
  }, null, 2), 'utf8')
  try {
    const legacy = legacyPersonaDefaults()
    assert.equal(legacy.staleDefaults.length, 1, '合成史料已被读到(没被缓存成陈值)')
    const file = { prefix: '前段', suffix: '旧尾段 0', savedAt: '2026-09-23T00:00:00.000Z' }
    write(file)
    assert.equal(classifyPersonaFile(file), 'stale', '文本命中史料 = 旧默认副本')
    const r = await loadPersona()
    assert.equal(r.legacyDefault, true)
    assert.equal(JSON.parse(raw()).suffix, '旧尾段 0', '只标记,不覆盖')
  } finally { rmSync(LEGACY_PERSONA_PATH, { force: true }) }
})

test('savePersona:坏请求(缺字段)直接拒;空串是合法语义(不注入)', async () => {
  await assert.rejects(() => savePersona(undefined, 'x'), /必须是字符串/)
  await assert.rejects(() => savePersona('x', null), /必须是字符串/)
  await assert.rejects(() => savePersona(123, 'x'), /必须是字符串/)
  const saved = await savePersona('', '')
  assert.deepEqual(
    { prefix: saved.prefix, suffix: saved.suffix, edited: saved.edited },
    { prefix: '', suffix: '', edited: true }
  )
  const back = await loadPersona()
  assert.equal(back.prefix, '', '他把面板清空 = 不注入,不该被出厂文本顶回来')
  assert.equal(back.suffix, '')
})

test('savePersona:超长仍被硬上限截断;前后空白被修掉', async () => {
  const saved = await savePersona('   ' + 'x'.repeat(9000) + '   ', 'y'.repeat(9000))
  assert.equal(saved.prefix.length, PERSONA_MAX_CHARS)
  assert.equal(saved.suffix.length, PERSONA_MAX_CHARS)
  const back = await loadPersona()
  assert.equal(back.prefix.length, PERSONA_MAX_CHARS)
  assert.equal(back.suffix.length, PERSONA_MAX_CHARS)
})

test('P2 §6.3 末行:人格落盘走唯一写路径(有备份 / 带 schemaRev / 原子)', async () => {
  const before = raw()
  const saved = await savePersona('前段·P2', '后段·P2')
  assert.equal(saved.prefix, '前段·P2')
  // ① 落盘内容带 schemaRev(以前 savePersona 不带 —— P2 起统一形状)
  const onDisk = JSON.parse(raw())
  assert.equal(onDisk.schemaRev, 1)
  assert.equal(onDisk.prefix, '前段·P2')
  assert.equal(onDisk.edited, true)
  // ② 写之前的内容进了 backup/(唯一写路径的时序:先备份再写)
  const bdir = join(HOME, 'backup')
  assert.ok(existsSync(bdir), 'P2 起每次人格落盘都要留一份备份')
  const baks = readdirSync(bdir).filter((f) => f.startsWith('persona.json.'))
  assert.ok(baks.length >= 1, 'backup/ 里该有 persona.json.<ts>.bak')
  const newest = baks.sort().at(-1)
  assert.equal(readFileSync(join(bdir, newest), 'utf8'), before, '备份必须是被覆盖前的旧内容')
  // ③ 不留 tmp 残渣(原子写的自证)
  assert.equal(readdirSync(HOME).filter((f) => f.includes('.tmp-')).length, 0)
})
