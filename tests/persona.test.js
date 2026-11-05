/**
 * v0.5.4 「防漂移三件套」+ v0.6.1 「声音纪律战斗版 / 默认值迁移」
 * 人格资产测试:纯常量与纯函数断言,**不碰真实数据目录**
 * (loadPersona/savePersona 会写盘 —— 那半边在 tests/persona-io.test.js,
 *  单独一个进程、一份临时家)。
 *
 * ★ P1b(2026-10-05)换主语:程序里不再有人格文本 —— 原来吃 DEFAULT_PERSONA
 *   文本的断言一律改成查**史料**(persona-legacy-defaults.json)。
 *   文本断言一条没删:那几段人格只是从代码搬进了数据目录,人还得看着它们
 *   别被改坏。史料不在本机时(换机 / 清过数据目录),这几条会明确降级成
 *   "只验降级形状",并在 t.diagnostic 里说清 —— 不留安静的绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_PERSONA, PERSONA_MAX_CHARS, DEFAULTS_REV, KNOWN_STALE_SUFFIXES,
  classifyPersonaFile, legacyPersonaDefaults, knownStaleSuffixes
} from '../lib/persona.js'
import { loadNeedles } from '../lib/name-lint.js'

const legacy = legacyPersonaDefaults()
const legacyReady = legacy.finalDefault.prefix.length > 0 && legacy.finalDefault.suffix.length > 0

/** 史料在 ⇒ 照原文查文本;不在 ⇒ 只验降级形状,并留一句话说明。 */
function ifLegacy (t, fn) {
  if (legacyReady) { fn(); return }
  assert.deepEqual(legacy.staleDefaults, [], '史料缺失时不该有半份冻着的旧文本')
  assert.equal(legacy.finalDefaultsRev, DEFAULTS_REV, '史料缺失时 rev 号应回落程序常量')
  t.diagnostic('史料 persona-legacy-defaults.json 不在本机:本条只验了降级形状,没验文本')
}

/**
 * 合成史料 fixture:文本命中/rev 判定都是**纯逻辑**,用合成文本验,
 * 不依赖本机档案(否则换台机器就红)。
 */
const FIX = {
  finalDefaultsRev: 3,
  finalDefault: { prefix: '前段', suffix: '今版尾段' },
  staleDefaults: [
    { rev: 0, prefix: '前段', suffix: '旧尾段 0' },
    { rev: 1, prefix: '前段', suffix: '旧尾段 1 —— 最锋利' },
    { rev: 2, prefix: '前段', suffix: '旧尾段 2' }
  ]
}

// ── P1b:程序里没有人格文本 ──────────────────────────────────────────────

test('程序里没有人格文本:DEFAULT_PERSONA 是空串、冻结表是空、源码里扫不到那几段', () => {
  assert.equal(DEFAULT_PERSONA.prefix, '', 'P1b:出厂人格 = 空(空 = 不注入,不是"回落出厂文本")')
  assert.equal(DEFAULT_PERSONA.suffix, '')
  assert.equal(KNOWN_STALE_SUFFIXES.length, 0, '程序里不再内嵌冻结的旧默认文本')
  const src = readFileSync(new URL('../lib/persona.js', import.meta.url), 'utf8')
  for (const needle of ['两条铁律', '防漂移', '最锋利', '你是 Echo', '不能弄反']) {
    assert.ok(!src.includes(needle), '源码里还留着人格文本:' + needle + '(数据与程序分离 P1b)')
  }
  // 真称呼也不许进源码 —— 针从数据目录现读(仓里不写死真值;口径与全仓闸同一处:
  // lib/name-lint.js 的 buildNeedles,所以「用户」「助手」这类角色槽不会误伤)
  for (const n of loadNeedles()) {
    assert.ok(!src.includes(n.needle), '源码里还留着他的称呼:' + n.needle + '(数据与程序分离 P1b)')
  }
})

test('史料:出厂文本非空且在硬上限内,冻结的三份也都在', (t) => {
  ifLegacy(t, () => {
    assert.ok(legacy.finalDefault.prefix.length > 50)
    assert.ok(legacy.finalDefault.suffix.length > 50)
    assert.ok(legacy.finalDefault.prefix.length <= PERSONA_MAX_CHARS)
    assert.ok(legacy.finalDefault.suffix.length <= PERSONA_MAX_CHARS)
    assert.equal(legacy.finalDefaultsRev, DEFAULTS_REV)
    assert.equal(legacy.staleDefaults.length, 3, 'rev0 / rev1 / rev2 都冻在史料里')
    assert.deepEqual(legacy.staleDefaults.map((d) => d.rev), [0, 1, 2], '三份史料的 rev 号要有序')
  })
})

test('防漂移三件套(M4-a):自检条款 + 两全尾句 + 冲突优先级都在末位提醒区', (t) => {
  ifLegacy(t, () => {
    const s = legacy.finalDefault.suffix
    // ① maid 自检条款:通用客服腔 = 出戏信号
    assert.ok(s.includes('【防漂移】'))
    assert.ok(s.includes('自检'))
    assert.ok(s.includes('很高兴为您服务'))
    // ② cosplay 两全尾句:人设不是干活的障碍,两全才是本事
    assert.ok(s.includes('人设不是干活的障碍'))
    assert.ok(s.includes('两全'))
    // ③ roleplay 冲突优先级:直接指令 > 铁律 > 说话习惯,但开口的永远是 Echo
    assert.ok(s.includes('冲突优先级'))
    assert.ok(s.includes('直接指令 > 两条铁律 > 说话习惯'))
    assert.ok(s.includes('永远叫 Echo'))
    // 位置纪律:防漂移段在铁律与说话方式之后(末位 = 最强提醒位)
    assert.ok(s.indexOf('【防漂移】') > s.indexOf('【Echo 的说话方式】'))
  })
})

test('声音纪律战斗版(v0.6.1):QQ v8.10.0 六件套逐条在场', (t) => {
  ifLegacy(t, () => {
    const s = legacy.finalDefault.suffix
    // 紧预算(LIFEBENCH:短指令在顺从区,宽区间被贴上限写)
    assert.ok(s.includes('1~2句,一般不超过40字'))
    // 镜像规则
    assert.ok(s.includes('镜像规则'))
    // 语域示例(示例打败规则 —— 只学长度与语域,不抄内容)
    assert.ok(s.includes('你的说话样子(参考长度与语域,别抄内容)'))
    assert.ok(s.includes('「你猜。」'))
    // 反填空条款
    assert.ok(s.includes('不许用废话填满沉默'))
    // 草稿冰山化
    assert.ok(s.includes('草稿是你的内心戏'))
    // 减压条款
    assert.ok(s.includes('只对眼前这句话反应'))
    // 接地修复(不认识的称呼先问,不装认识不断然否认)
    assert.ok(s.includes('先问清楚,不许假装认识'))
    // 干活豁免仍在(战斗版不砍手艺)
    assert.ok(s.includes('干活和讲技术时另说'))
  })
})

test('两条铁律原样在场(追加不重写)', (t) => {
  ifLegacy(t, () => {
    const s = legacy.finalDefault.suffix
    assert.ok(s.includes('【Echo 的两条铁律】'))
    assert.ok(s.includes('唯一不能拿来开玩笑的事'))
    const p = legacy.finalDefault.prefix
    assert.ok(p.includes('你是 Echo'))
    // 史料里的出厂文本本该带**他的称呼** —— 真值现读,仓里不写死(针来源 = profile.json)
    const owner = loadNeedles()
    if (owner.length > 0) {
      assert.ok(owner.some((n) => p.includes(n.needle)),
        '史料 prefix 里该有他的称呼(现读 profile:' + owner.map((n) => n.needle).join('/') + ')')
    } else {
      t.diagnostic('读不到 profile 的别名 ⇒ 这条只验了别的三句')
    }
    assert.ok(p.includes('编码 agent'))
  })
})

// ── v0.6.1 默认值迁移:认旧默认,用户文本永不覆盖 ─────────────────────────

test('classifyPersonaFile:edited=true 永远是用户文本', () => {
  assert.equal(classifyPersonaFile({ prefix: 'x', suffix: 'y', edited: true }, FIX), 'user')
  // 即使带着旧修订号,编辑过就是他的
  assert.equal(classifyPersonaFile({ prefix: '前段', suffix: '随便改的', edited: true, defaultsRev: 1 }, FIX), 'user')
})

test('classifyPersonaFile:defaultsRev 判当前/落后', () => {
  assert.equal(classifyPersonaFile({ defaultsRev: DEFAULTS_REV }, FIX), 'current')
  assert.equal(classifyPersonaFile({ defaultsRev: 1 }, FIX), 'stale')
  assert.equal(classifyPersonaFile(null, FIX), 'user')
})

test('classifyPersonaFile:legacy 无标记文件按文本命中判旧默认', () => {
  // 文本命中史料里的旧后缀 ⇒ 插件写的旧默认副本
  assert.equal(classifyPersonaFile({ prefix: '前段', suffix: '旧尾段 0' }, FIX), 'stale')
  assert.equal(classifyPersonaFile({ prefix: '前段', suffix: '旧尾段 1 —— 最锋利' }, FIX), 'stale')
  // 不命中任何已知默认 = 他改过:宁可漏升级,绝不覆盖
  assert.equal(classifyPersonaFile({ prefix: '我的前段', suffix: '我的尾段' }, FIX), 'user')
  // 前段对但尾段被改过一个字 → user
  assert.equal(classifyPersonaFile({ prefix: '前段', suffix: '旧尾段 2。' }, FIX), 'user')
  // 前段不对(哪怕尾段一模一样)→ user
  assert.equal(classifyPersonaFile({ prefix: '别人的前段', suffix: '旧尾段 2' }, FIX), 'user')
})

// ── v9.0.0(2026-09-26 当晚):他问「为什么她这个人格还是很偏离我给的要求呢?很冷硬」──
// 量出来的现场(见 docs/VOICE_BASELINE_2026-09-26.md):她发出去的 21 句里
// 「～/嘛/啦/呀」出现率 **0%**、「主人」10% —— 而前段明写「句尾常带～嘛啦呀」。
// 病因是**尾部的示例压过了头部的形容**:四条例句全冷,还有一句「最锋利」。
// 这几条钉的就是那三处改动,谁改回去都要红(P1b 起主语是史料,不是程序常量)。

test('v9.0.0 默认后缀改暖:删「最锋利」、例句冷热各半、签名写进独立一条', (t) => {
  assert.equal(DEFAULTS_REV, 3, '默认人格停在 rev 3(P1b 起不再写默认)')
  ifLegacy(t, () => {
    const s = legacy.finalDefault.suffix
    // ① 「最锋利」那句:一句通用要求,把他的真心话也一起削了(铁律里锋利只给恶意挑衅)
    assert.ok(!s.includes('最锋利'), '「说出口的只是最锋利的一两句」必须走干净')
    assert.ok(s.includes('最想让他听见'), '改成以他为主语的取向')
    assert.ok(s.includes('锋利留给恶意挑衅'), '和铁律对齐,不再打架')
    // ② 例句:**示例决定语域,形容词不决定** —— 两句冷、两句暖
    assert.ok(s.includes('……知道啦'), '暖例句之一(P3-e:不再钉私人称呼)')
    assert.ok(s.includes('嗯,我在的,刚在想你。'), '暖例句之二')
    assert.ok(s.includes('……哼,知道了。') && s.includes('你猜。'), '冷的留着:短和拽还是她的底色')
    // ③ 签名:把语气词与称呼写成每句都适用的一条底线
    assert.ok(s.includes('语气底线'), '签名条款要在')
    assert.ok(s.includes('叫他的时候叫「'), '签名条款里明写该怎么叫(实测 10%)——P3-e:具体称呼由他的数据给,程序不钉')
    assert.ok(s.includes('冷硬不是你的样子'), '把「别冷」写明')
  })
})

test('v9.0.0 迁移:rev 2 的旧后缀被认出是「旧默认」,他改过的一律不动', (t) => {
  assert.equal(knownStaleSuffixes(FIX).length, 3, 'rev0 / rev1 / rev2 都冻着')
  assert.equal(knownStaleSuffixes(FIX)[2], '旧尾段 2')
  assert.ok(knownStaleSuffixes(FIX)[1].includes('最锋利'), '第 3 份冻的确实是旧的 rev2 文本')
  // 没编辑过的 rev2 装机会被判 stale(该被认出来)
  assert.equal(classifyPersonaFile({ prefix: '前段', suffix: knownStaleSuffixes(FIX)[2], defaultsRev: 2 }, FIX), 'stale')
  // 他编辑过的文件永远是 user —— 插件不许覆盖他写的字
  assert.equal(
    classifyPersonaFile({ prefix: '前段', suffix: knownStaleSuffixes(FIX)[2], defaultsRev: 2, edited: true }, FIX),
    'user'
  )
  ifLegacy(t, () => {
    assert.equal(knownStaleSuffixes(legacy).length, 3, '本机史料里也是三份')
    assert.ok(knownStaleSuffixes(legacy)[2].includes('最锋利'), '史料里的第 3 份确实是 rev2 文本')
    assert.notEqual(knownStaleSuffixes(legacy)[2], legacy.finalDefault.suffix, '冻结的旧文本 ≠ 现在的出厂文本')
    assert.equal(
      classifyPersonaFile({ prefix: legacy.finalDefault.prefix, suffix: legacy.staleDefaults[2].suffix }, legacy),
      'stale'
    )
  })
})

// ── 史料缺失/损坏:一律降级,不许抛 ───────────────────────────────────────

test('史料缺失或损坏 ⇒ 空史料降级:认得出版本号,认不出文本,永不抛', () => {
  const gone = legacyPersonaDefaults(join(tmpdir(), 'echo-根本没有这个文件-' + Date.now() + '.json'))
  assert.deepEqual(gone, {
    finalDefaultsRev: DEFAULTS_REV,
    finalDefault: { prefix: '', suffix: '' },
    staleDefaults: []
  })
  const dir = mkdtempSync(join(tmpdir(), 'echo-persona-legacy-'))
  try {
    const badPath = join(dir, 'persona-legacy-defaults.json')
    writeFileSync(badPath, '{这不是 JSON', 'utf8')
    assert.deepEqual(legacyPersonaDefaults(badPath).staleDefaults, [], '坏史料 = 没有史料')
    writeFileSync(badPath, '"字符串也能解析,但不是史料"', 'utf8')
    assert.deepEqual(legacyPersonaDefaults(badPath).staleDefaults, [], '形状不对也当没有史料')
  } finally { rmSync(dir, { recursive: true, force: true }) }
  // 没有史料的时候,rev 号仍按程序常量判 —— 判定不许跟着环境乱变
  assert.equal(classifyPersonaFile({ defaultsRev: 1 }, {}), 'stale')
  assert.equal(classifyPersonaFile({ defaultsRev: DEFAULTS_REV }, {}), 'current')
  assert.equal(classifyPersonaFile({ prefix: 'p', suffix: 's' }, {}), 'user')
})
