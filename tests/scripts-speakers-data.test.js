/**
 * P3-c:两份**漏网脚本**的说话人名单也改成"现读数据文件"。
 *
 * 名单(用户/阿岚/她/Echo/助手)原来**硬编码在七处**:python 侧三处
 * (`graph_gate.py` / `l0_tier.py`)、JS 侧两处(`lib/store.js` / `lib/memory-read-tools.js`,
 * P1b 已收)、加上这两份**报表脚本**——`scripts/graph-baseline.mjs` 与
 * `scripts/memory-tools-proto.mjs`(设计 §1.1 第 23 行点名的第六、第七处)。
 * 前五处搬进 `names.json` 后,这两处还在各写一份 ⇒ 同一份名单七个人维护。
 *
 * 现在:两处都 `loadNames().speakers`(`lib/names.js` 是 JS 侧唯一读点,与
 * `lib/memory-read-tools.js:79` 同一条路)。**空 ⇒ 空集合**(中性,不猜,不回落旧硬编码),
 * 退化时会往 stderr 说一句 —— 这条诊断正是下面"行为级"钉子的观测点:
 * 名单有 ⇒ 不吭声;名单没有 ⇒ 吭声(证明它真的在读文件,而不是把旧表藏在代码里)。
 *
 * ⚠️ 夹具的 JSON **必须用 node 的 fs 写**:PowerShell 的 `Set-Content -Encoding utf8`
 * 会带 BOM(`ef bb bf`),`JSON.parse` 当场抛 ⇒ 名字读成空、测试假绿/假红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SCRIPTS = ['scripts/graph-baseline.mjs', 'scripts/memory-tools-proto.mjs']
const LEGACY_LIST = /SPEAKERS = \[/

const srcOf = (rel) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8')

/** 跑一个脚本(库路径**故意指向一个不存在的临时文件**:不进真库、不写任何东西)。 */
function runScript (rel, dataDir, dbPath) {
  try {
    const out = execFileSync(process.execPath, [join(REPO, rel), '--db', dbPath],
      { encoding: 'utf8', env: { ...process.env, ECHO_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out, err: '' }
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') }
  }
}

/** 造一个临时数据目录;`names` 给了就写一份 names.json(不给 = 空目录)。 */
function tempDataDir (names) {
  const dir = mkdtempSync(join(tmpdir(), 'echo-script-names-'))
  if (names) writeFileSync(join(dir, 'names.json'), JSON.stringify({ schemaRev: 1, speakers: names }), 'utf8')
  return dir
}

test('① 源码:两份脚本都不许再有内置名单,只许走 names.js 那一个读点', () => {
  for (const rel of SCRIPTS) {
    const src = srcOf(rel)
    assert.ok(src.includes("from '../lib/names.js'"), rel + ' 必须共用 names.js 读点')
    assert.ok(src.includes('loadNames().speakers'), rel + ' 要现读 speakers')
    assert.equal(LEGACY_LIST.test(src), false, rel + ' 不许再有硬编码的 SPEAKERS 名单')
    for (const name of ['用户', '阿岚', 'Echo', '助手']) {
      assert.equal(new RegExp("'" + name + "'").test(src), false, rel + ' 里还有内置真名:' + name)
    }
  }
  // 名单要在**开库之前**读:库不在时也得看得见"名单读没读到"(退化不许静默),
  // 顺带证明它是纯配置读点、与库无关。(比的是**代码**,注释里提到那句诊断不算。)
  const base = srcOf('scripts/graph-baseline.mjs')
  assert.ok(base.indexOf('loadNames()') < base.indexOf("console.error('库不存在"),
    'graph-baseline 的名单读取要排在开库检查之前')
})

test('② 行为:名单在文件里就照文件算,文件没有就退化成空(且说一声)', () => {
  const withNames = tempDataDir(['甲', '乙'])
  const withoutNames = tempDataDir()
  const noDb = join(tmpdir(), 'echo-script-names-no-such.db')
  try {
    for (const rel of SCRIPTS) {
      // 库不存在 ⇒ 两条都退非 0(那是**库**的事,与本改动无关);我们要看的是 stderr 那句诊断。
      const has = runScript(rel, withNames, noDb)
      assert.ok(has.err.includes('库不存在'), rel + ' 应当因库不存在而收手:' + has.err)
      assert.equal(has.err.includes('没有 speakers'), false,
        rel + ' names.json 里有名单就不该退缩(说明它真的读了文件)')

      const none = runScript(rel, withoutNames, noDb)
      assert.ok(none.err.includes('库不存在'), rel + ' 应当因库不存在而收手')
      assert.ok(none.err.includes('没有 speakers'),
        rel + ' 名单缺失要退化成空集合并说一声(不回落旧硬编码):' + none.err)
    }
  } finally {
    rmSync(withNames, { recursive: true, force: true })
    rmSync(withoutNames, { recursive: true, force: true })
  }
})
