/**
 * BOM 闸(`scripts/check-bom.mjs`)的护栏 —— 2026-09-30 P4b 那一批补的。
 *
 * 为什么值得一条电池:这道闸的判据是「全仓文本文件**一个都不许**带 BOM」,
 * 而仓库里偏偏有一个**草稿区** `.scratch/`(gitignore 了:检索实验的 dump、
 * 论文 HTML、真库快照,还有临时写出来的 BOM / UTF-16 样本)。它里面的字节
 * 不是交付物,却会让 `npm run check` 红成一片 —— 于是闸自己给自己放行这一处。
 *
 * 两条用例:
 *   ① 源码形状 + **真仓跑一次**:夹具只落在 `.scratch/` 里(跑完删掉),闸必须 exit 0;
 *   ② **合成小仓**:把脚本复制一份到临时目录搭一个迷你仓,证明闸**仍有牙齿**
 *      —— 同一份 BOM 字节放在跳过区外,照样 exit 1 并点名那个文件。
 *      (①证明"放行",②证明"只放了这一处",两条加起来才是完整结论。)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const SCRIPT = fileURLToPath(new URL('../scripts/check-bom.mjs', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 跑一遍闸:`{code, out, err}`(非 0 退出在 `execFileSync` 里是抛,照仓库习惯接住)。 */
function runGate (script) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script], { encoding: 'utf8' }), err: '' }
  } catch (e) {
    return { code: Number(e.status), out: String(e.stdout || ''), err: String(e.stderr || '') }
  }
}

const UTF8_BOM = Buffer.from([0xEF, 0xBB, 0xBF])
const UTF16_BOM = Buffer.from([0xFF, 0xFE])
const withBom = (bytes, text) => Buffer.concat([bytes, Buffer.from(text, bytes === UTF16_BOM ? 'utf16le' : 'utf8')])

test('真仓:`.scratch/` 下的 BOM / UTF-16 样本不让闸红(exit 0,而且真的打了「过」)', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  assert.match(src, /SKIP_DIRS = new Set\(\[[^\]]*'\.scratch'/,
    '闸自己要先放行草稿区(先看源码形状,免得下面那条只是巧合)')

  const scratch = join(REPO_ROOT, '.scratch')
  const bomFile = join(scratch, 'tmp-bom-fixture.js')
  const utf16File = join(scratch, 'tmp-utf16-fixture.md')
  mkdirSync(scratch, { recursive: true })
  try {
    writeFileSync(bomFile, withBom(UTF8_BOM, '// 带 BOM 的样本(草稿区,不是交付物)\n'))
    writeFileSync(utf16File, withBom(UTF16_BOM, '# 带 UTF-16 BOM 的样本\n'))
    const r = runGate(SCRIPT)
    assert.equal(r.code, 0, '草稿区里的字节不是交付物 ⇒ 闸必须 exit 0:' + r.out + r.err)
    assert.match(r.out, /BOM 闸:过/, '而且要真的把「过」那行打出来(不是靠提前退出混过去)')
  } finally {
    rmSync(bomFile, { force: true })
    rmSync(utf16File, { force: true })
    // 夹具删完,自己建的空目录也一起收掉 —— 只在**确实为空**时删(草稿区里
    // 平时可能有别人的东西,空了才说明这个目录是本用例刚建的)。
    try {
      if (readdirSync(scratch).length === 0) rmdirSync(scratch)
    } catch { /* 目录已被别人收掉 / 不可读 ⇒ 不管 */ }
  }
})

test('合成小仓:跳过区**外**的 BOM 照样红(只放行了 `.scratch`,没有把闸关掉)', () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-check-bom-'))
  const scripts = join(root, 'scripts')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(join(root, '.scratch'), { recursive: true })
  copyFileSync(SCRIPT, join(scripts, 'check-bom.mjs')) // ROOT = 脚本上一级 ⇒ 这个临时目录就是"全仓"
  const script = join(scripts, 'check-bom.mjs')
  try {
    writeFileSync(join(root, '.scratch', 'bom-sample.js'), withBom(UTF8_BOM, '// 草稿区样品\n'))
    assert.equal(runGate(script).code, 0, '先确认:只有草稿区里那份 ⇒ 过')

    const offender = join(root, '交付物.js')
    writeFileSync(offender, withBom(UTF8_BOM, '// 这份在跳过区外\n'))
    const red = runGate(script)
    assert.equal(red.code, 1, '跳过区外的 BOM 必须红(闸的牙齿还在)' + red.out + red.err)
    assert.match(red.err, /交付物\.js/, '而且要**点名**那个文件:' + red.err)
    assert.match(red.err, /UTF-8 BOM/, '连 BOM 类型一起报出来')

    rmSync(offender, { force: true })
    assert.equal(runGate(script).code, 0, '删掉它 ⇒ 又回绿(判据就是字节,不是别的)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
