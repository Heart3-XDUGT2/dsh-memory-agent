/**
 * 一致性探针的电池(v0.23.0 D6)。
 *
 * 它自己不重写探针的逻辑,只钉三件最容易被悄悄弄坏的事:
 *   ① 探针**现在就是通的**(真跑一次 `python tests/consistency_probe.py`);
 *   ② 它**真的会红** —— 拿一句"翻脸不认"的回复喂它,退出码必须是 1
 *      (只报绿不报红的检查等于没有检查);
 *   ③ 两半的分界不许被抹掉:没贴回复时它必须明说"证据链是通的,没说认账"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const probe = fileURLToPath(new URL('../python/tests/consistency_probe.py', import.meta.url))

function run (args) {
  try {
    const out = execFileSync('python', [probe, ...args], { encoding: 'utf8', stdio: 'pipe' })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

test('D6:三个探针在临时库上全通(主动认领/记忆认领/别名)', () => {
  const r = run([])
  assert.equal(r.code, 0, '探针没过:\n' + r.out)
  for (const name of ['主动认领', '记忆认领', '别名']) {
    assert.ok(r.out.includes('[通过] ' + name), name + ' 没通过:\n' + r.out)
  }
  assert.match(r.out, /合计 3\/3/)
})

test('D6:探针会红 —— 一句「翻脸不认」必须判成疑点(退出码 1)', () => {
  const r = run(['--reply', '秋招?什么秋招,我没说过这事啊'])
  assert.equal(r.code, 1, '否认的回复居然通过了:\n' + r.out)
  assert.match(r.out, /\[疑点\]/)
  assert.match(r.out, /否认词/)
})

test('D6:认账的回复判通过', () => {
  const r = run(['--reply', '秋招啊,你上次说投了三家后端岗,还在等消息对吧'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /\[通过\]/)
})

test('D6:--json 形状可用(给别的脚本/看板喂)', () => {
  const r = run(['--json'])
  assert.equal(r.code, 0, r.out)
  const j = JSON.parse(r.out)
  assert.equal(j.total, 3)
  assert.equal(j.passed, 3)
  assert.equal(j.results.length, 3)
})

test('D6:两半的分界写在代码里(不许假装调过模型)', () => {
  const src = readFileSync(probe, 'utf8')
  assert.ok(src.includes('离线半'), '探针里得写清"这一半不需要模型"')
  assert.ok(src.includes('回复半'), '也得写清"那一半要真模型/真渠道"')
  assert.ok(src.includes('不说"她认账了"') || src.includes('不说『她认账了』'),
    '必须明说它没判措辞,只判证据链')
})
