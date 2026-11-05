/**
 * 情景检索测试(JS 侧,RT2/RT3/RT4)。
 *
 * 与 `python/tests/test_retrieve.py` 的 HitCascade / RetrieveAndRender 逐点镜像
 * (NOW=1700000000 基准行):同输入必同输出 —— 两套实现共用同一组公式,
 * 任何一边漂了,另一边的锚点就会喊出来。
 *
 * RT2(2026-09-27)换掉了旧的"五档命中分层":现在是
 * **正文(摘要+关键词)上的 BM25 idf 加权覆盖率**(见 lib/lexical.js)。
 * 旧档位只索引 keywords 字段(漏洞①),分数离散、同档内无法分辨命中几个词。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  rankMemories, segmentQuery, L0_ALWAYS_ON_LIMIT, CANDIDATE_LIMIT,
  W_REL, W_REC, W_EMO
} from '../lib/retrieve.js'
import {
  normalize, tokenize, uniqTerms, docText, buildIndex, termIdf,
  queryTotalIdf, docCoverage, charBigrams, jaccard, nearDupOf, STOPWORDS,
  BM25_K1, BM25_B, MIN_COVERAGE, DEDUPE_THRESHOLD, DEDUPE_MIN_CHARS,
  loadStopwords, stopwordsOf, resetStopwordsCache
} from '../lib/lexical.js'
import { renderMemoryList } from '../lib/context.js'

const NOW = 1700000000
const base = {
  memoryId: 1, keywords: [], summary: '', emotionScore: 5, timestamp: NOW - 3600,
  intrinsicValue: 50, halfLife: 24, recallCount: 0, lastRecalled: 0,
  layer: '', occurredAt: 0, learnedAt: NOW, temporalStatus: 'time_unknown',
  source: 'dsh', sourceLabel: '', actor: ''
}

// ---------------------------------------------------------------- 相关性

test('说法键(2026-09-30):写的时候给的说法,问的时候能撞上', () => {
  // 机制:docText = 摘要 + 关键词 + 说法键。下面是 gi7 那类"概念跳跃"的缩影 ——
  // 问法里的字面在记忆里一个字都不出现,只有写入时留的说法键撞得上。
  const row = {
    ...base, memoryId: 7,
    summary: '用户把 Echo 打造成心目中的样子',
    keywords: ['Echo', '目标'],
    augKeys: ['亲手做', '自己动手']
  }
  const q = '他为什么非要自己做这个东西'
  // 负控①:旋钮关掉(默认)⇒ 与老行为逐位一致,这条找不到
  assert.equal(rankMemories([row], q, 5, NOW).length, 0)
  // 负控②:旋钮开着但这条没有说法键 ⇒ 同样找不到
  assert.equal(rankMemories([{ ...row, augKeys: [] }], q, 5, NOW, { augKeys: true }).length, 0)
  const got = rankMemories([row], q, 5, NOW, { augKeys: true })
  assert.equal(got.length, 1)
  assert.equal(got[0].memoryId, 7)
})

test('说法键的三种来源都吃:数组 / JSON 字符串 / 脏值当空', () => {
  const q = '他为什么非要自己做这个东西'
  const mk = (augKeys) => ({ ...base, memoryId: 8, summary: '用户把 Echo 打造成心目中的样子', augKeys })
  assert.equal(docText(mk(['亲手做'])).includes('亲手做'), true)
  assert.equal(docText(mk('["亲手做"]')).includes('亲手做'), true)   // 库里存的就是这个形状
  assert.equal(docText(mk('不是 JSON')).includes('不是 JSON'), false) // 脏值不许进正文
  assert.equal(docText(mk(null)), docText({ ...base, memoryId: 8, summary: '用户把 Echo 打造成心目中的样子' }))
  // withAug=false(引擎默认那条)⇒ 库里有键也不加字面
  assert.equal(docText(mk(['亲手做']), false), docText(mk(null)))
  assert.equal(rankMemories([mk('["自己动手"]')], q, 5, NOW, { augKeys: true }).length, 1)
})

test('查询分段:保留 ≥2 字的段', () => {
  const segs = segmentQuery('我喜欢写代码,也喜欢你')
  assert.ok(segs.has('我喜欢写代码'))
  assert.ok(segs.has('也喜欢你'))
  assert.ok(!segs.has('我'))
})

test('正文才是索引,不只是 keywords 字段(漏洞①回归)', () => {
  // 旧行为:抽取器没把「新生」写进 keywords ⇒ 这条记忆**永远搜不到**。
  // 这是"信息不在索引里",不是"算法不够好"(索引正文严格更有信息)。
  const row = { ...base, memoryId: 1, keywords: ['大学'], summary: '用户就读于一所新工科大学,是西电大一新生' }
  const top = rankMemories([row], '新生', 6, NOW)
  assert.equal(top.length, 1, '摘要里明明有「新生」却检不出来 = 漏洞①')
  assert.ok(top[0].hits > 0)
  assert.equal(top[0].matched, true)
})

test('keywords 全空、只有摘要能对上也能检索(漏洞①的另一种形态)', () => {
  const row = { ...base, keywords: [], summary: '他说他喜欢猫,养了两只' }
  const top = rankMemories([row], '两只猫', 6, NOW)
  assert.equal(top.length, 1, '只有摘要能对上就检不出来 = 漏洞①')
})

test('单字查询「猫」必须能匹配正文里的「他喜欢猫」(漏洞①的边界)', () => {
  // 只产二字组合时,查询「猫」与文档「他喜欢猫」的边界二字(`猫吗`/`欢猫`)
  // 不同 ⇒ 0 命中,`echo_forget` 的「>10 拒绝」保护直接失效。
  const row = { ...base, memoryId: 1, keywords: [], summary: '他喜欢猫' }
  const top = rankMemories([row], '猫', 6, NOW)
  assert.equal(top.length, 1, '单字查询被词元层丢掉了')
  assert.equal(top[0].matched, true)
})

test('相关性是连续覆盖率,不是离散档位(短文档覆盖率更高)', () => {
  // 旧档位(1.0/0.7/0.5/0.3/0.4)同档内分不出"命中一个词"与"命中五个词"。
  const rows = [
    { ...base, memoryId: 1, keywords: [], summary: '章鱼小丸子' },
    { ...base, memoryId: 2, keywords: [], summary: '他提到章鱼小丸子很难买到,几乎几年才能吃一次' }
  ]
  const top = rankMemories(rows, '章鱼小丸子', 6, NOW)
  const covs = Object.fromEntries(top.map(t => [t.memoryId, t.hits]))
  assert.equal(top.length, 2)
  // 短文档(命中面占全文比例更高)覆盖率更高 —— 长度归一在起作用
  assert.ok(covs[1] > covs[2])
  assert.ok(covs[1] <= 1.0)
})

// ---------------------------------------------------------------- L0 语义

test('无命中且非 L0 → 出局;L0 豁免话题过滤', () => {
  const rows = [
    { ...base, memoryId: 1, keywords: ['完全无关'], summary: '无关的事' },
    { ...base, memoryId: 2, keywords: ['称呼'], summary: '他喜欢被叫阿岚', layer: 'L0', intrinsicValue: 90 }
  ]
  const top = rankMemories(rows, '今天天气怎么样', 6, NOW)
  assert.equal(top.length, 1)
  assert.equal(top[0].memoryId, 2)
  assert.equal(top[0].matched, false, '零命中的 L0 不该被标成命中')
  assert.equal(top[0].forced, true, '零命中的 L0 只能靠强制占位进池')
})

test('L0 强制占位但给常规结果留 2 席', () => {
  const rows = []
  for (let i = 1; i <= 8; i++) {
    rows.push({ ...base, memoryId: i, keywords: ['话题'], summary: '常规记忆' + i, layer: 'L0', intrinsicValue: i })
  }
  // 常规行情感分更高:在"剩余席位"的竞争中稳赢未占位的 L0(同命中同 R)
  rows.push({ ...base, memoryId: 11, keywords: ['话题'], summary: '常规命中A', emotionScore: 9 })
  rows.push({ ...base, memoryId: 12, keywords: ['话题'], summary: '常规命中B', emotionScore: 9 })
  rows.push({ ...base, memoryId: 13, keywords: ['话题'], summary: '常规命中C', emotionScore: 9 })
  const top = rankMemories(rows, '话题', 6, NOW)
  assert.equal(top.length, 6)
  const l0Count = top.filter(t => t.layer === 'L0').length
  assert.ok(l0Count <= L0_ALWAYS_ON_LIMIT)
  assert.equal(l0Count, 4) // min(8, 6-2) = 4:topK 才是这里的瓶颈
  // 常规结果至少 2 席
  assert.equal(top.filter(t => t.layer !== 'L0').length, 2)
})

test('强制占位上限 8 生效:topK=12 时 L0 占 min(8,10)=8 席(AstrBot 真值)', () => {
  const rows = []
  for (let i = 1; i <= 10; i++) {
    rows.push({ ...base, memoryId: i, keywords: ['话题'], summary: '核心' + i, layer: 'L0', intrinsicValue: i })
  }
  for (let i = 1; i <= 4; i++) {
    rows.push({ ...base, memoryId: 20 + i, keywords: ['话题'], summary: '常规' + i, emotionScore: 9 })
  }
  const top = rankMemories(rows, '话题', 12, NOW)
  assert.equal(top.filter(t => t.layer === 'L0').length, 8)
  assert.equal(top.length, 12)
})

// ---------------------------------------------------------------- 总分公式

test('总分 = 覆盖率×1.0 + R×0.15 + 情感×0.02,高情感记忆胜出', () => {
  // 相关性主导,情感只在相关性相当时把人**最在意**的那条顶上来
  // (RT2 起 R 从 40% 降到 15%)。
  const rows = [
    { ...base, memoryId: 1, keywords: ['猫'], summary: '他提到猫', emotionScore: 2 },
    { ...base, memoryId: 2, keywords: ['猫'], summary: '他为猫生病哭了', emotionScore: 9 }
  ]
  const top = rankMemories(rows, '猫', 2, NOW)
  assert.equal(top[0].memoryId, 2)
})

test('半衰期缺失时按内在价值现算 H0(降级路径)', () => {
  // RT2 附注:查询要能切出词元 —— 单个拉丁字母(旧版这里用 "x")在新词元
  // 层里被丢弃(长度 ≤1 且非数字),所以换成汉字查询。
  const row = { ...base, memoryId: 1, keywords: ['面'], summary: '面试', halfLife: 0, intrinsicValue: 100 }
  const top = rankMemories([row], '面试', 1, NOW)
  assert.ok(top[0].halfLife > 24 * 10)
})

test('空库返回空数组', () => {
  assert.deepEqual(rankMemories([], '什么', 6, NOW), [])
})

// ---------------------------------------------------------------- 漏洞②渲染

test('★ 漏洞②:零命中时渲染带标注 —— 「这些不是本轮相关材料」', () => {
  const rows = [{ ...base, memoryId: 1, keywords: ['中文'], summary: '她喜欢用中文思考。', layer: 'L0', intrinsicValue: 90 }]
  const top = rankMemories(rows, 'zzz-完全无关-zzz', 6, NOW)
  assert.equal(top.length, 1, 'L0 豁免该让它进池(设计不变)')
  assert.equal(top[0].matched, false)
  const text = renderMemoryList(top)
  assert.ok(text.includes('没有命中任何记忆'), '零命中没标注 = 漏洞②还在')
  assert.ok(text.includes('不要拿它们回答眼前的问题'))
})

test('有命中时**不加**标注 —— 标注本身是噪声,只在必要时出现', () => {
  const rows = [{ ...base, memoryId: 1, keywords: ['校园跑'], summary: '用户校园跑要跑3km。' }]
  const top = rankMemories(rows, '今天校园跑跑完了', 6, NOW)
  assert.ok(top.some(it => it.matched))
  assert.ok(!renderMemoryList(top).includes('没有命中任何记忆'))
})

test('★ 漏洞②-b:有命中时,没命中的常在场记忆要**逐条**标出来', () => {
  // 只靠块级横幅太脆:测台实测 19 条寒暄负控里 17 条仍会被判 matched=True
  // (短查询覆盖率非 0 即 1),那 17 轮 L0 就会混在"相关材料"里不作声。
  const rows = [
    { ...base, memoryId: 1, keywords: ['校园跑'], summary: '用户校园跑要跑3km。' },
    { ...base, memoryId: 2, keywords: ['中文'], summary: '她喜欢用中文思考。', layer: 'L0', intrinsicValue: 90 }
  ]
  const top = rankMemories(rows, '今天校园跑跑完了', 6, NOW)
  assert.ok(top.some(it => it.matched), '前提:得有一条真命中')
  const text = renderMemoryList(top)
  assert.ok(!text.includes('没有命中任何记忆'), '有命中就不该出块级横幅')
  assert.ok(text.includes('(常在场,不是本轮相关)'), 'L0 没命中却没逐条标 = 漏洞②-b')
})

test('不带 matched 字段的老调用方:不逐条标(别把所有行都标上)', () => {
  const text = renderMemoryList([{ summary: '她喜欢用中文思考。' }])
  assert.ok(!text.includes('(常在场,不是本轮相关)'))
})

// ---------------------------------------------------------------- 漏洞③去冗余

test('★ 漏洞③:近重复只占一个席位(注入用途)', () => {
  // ⚠️ 已知局限:阈值 0.55 只抓得住**措辞几乎相同**的那种。
  const rows = [
    { ...base, memoryId: 1, keywords: ['章鱼小丸子'], summary: '他提到章鱼小丸子很难买到,几乎几年才能吃一次。' },
    { ...base, memoryId: 2, keywords: ['章鱼小丸子'], summary: '他提到章鱼小丸子很难买到,几乎几年才能吃上一次。' }
  ]
  const top = rankMemories(rows, '章鱼小丸子', 6, NOW)
  assert.equal(top.length, 1, '近重复的同一事实占了两个席位 = 漏洞③')
  assert.equal(top[0].memoryId, 1, '留下的该是分最高的那条')
})

test('★ 去冗余不许碰枚举用途:dedupe:false 不折叠', () => {
  // `memory_forget` 的「>10 拒绝」保护是数匹配条数的,折叠近重复会让 11 条
  // 近似记忆变成 1 条、保护直接失效(forget["ok"] 从 False 翻成 True)。
  const rows = []
  for (let i = 0; i < 11; i++) {
    rows.push({ ...base, memoryId: i + 1, keywords: ['猫'], summary: '用户说他的第' + i + '只猫很可爱' })
  }
  const enumTop = rankMemories(rows.map(r => ({ ...r })), '猫', 20, NOW, { dedupe: false })
  assert.equal(enumTop.length, 11, '枚举用途被折叠了 = forget 的保护会失效')
  const inj = rankMemories(rows.map(r => ({ ...r })), '猫', 20, NOW)
  assert.ok(inj.length < 11, '注入用途没有折叠近重复 = 漏洞③还在')
})

test('强制占位的 L0 受保护:近重复抑制不会把它丢掉', () => {
  const rows = [
    { ...base, memoryId: 1, keywords: [], summary: '他喜欢被叫阿岚', layer: 'L0', intrinsicValue: 90 },
    { ...base, memoryId: 2, keywords: [], summary: '他喜欢被叫阿岚', layer: 'L0', intrinsicValue: 90 }
  ]
  const top = rankMemories(rows, 'zzz-完全无关-zzz', 6, NOW)
  assert.equal(top.length, 2, '两条都该靠强制占位进池(近重复抑制只吃常规结果)')
  assert.ok(top.every(it => it.forced === true))
})

// ---------------------------------------------------------------- 词元层

test('词元层:CJK 单字与二字都产出,2~16 字段另保留整串', () => {
  assert.deepEqual(uniqTerms('章鱼小丸子'),
    ['章', '鱼', '小', '丸', '子', '章鱼', '鱼小', '小丸', '丸子', '章鱼小丸子'])
  // 单字必须产(边界二字匹配不上的那条回归);停用词「他」被滤掉
  assert.deepEqual(tokenize('他喜欢猫'), ['喜', '欢', '猫', '他喜', '喜欢', '欢猫', '他喜欢猫'])
})

test('词元层:Latin 长度>1 或纯数字才收;停用词按表过滤', () => {
  // CJK 段先产、Latin 段后产(与 Python 的 findall 顺序一致)
  assert.deepEqual(uniqTerms('39度'), ['度', '39'])
  assert.deepEqual(uniqTerms('ABＣ 3km'), ['abc', '3km'])
  assert.deepEqual(uniqTerms('a x'), [])
  // 「为」与「为什么」「为什」都在停用词表里,但单字「什」「么」不在 ⇒ 留下
  assert.deepEqual(uniqTerms('为什么'), ['什', '么'])
  // 「为什」必须收:「为什么你不主动关怀我」靠它才不会被一堆虚词带偏
  assert.deepEqual(uniqTerms('为什么你不主动关怀我'),
    ['什', '么', '主', '动', '关', '怀', '么你', '你不', '不主', '主动', '动关', '关怀', '怀我',
      '为什么你不主动关怀我'])
})

test('normalize:NFKC 折叠全角/兼容字符 + 小写', () => {
  assert.equal(normalize('ＡＢＣ３ｋｍ'), 'abc3km')
  assert.equal(normalize(null), '')
  assert.equal(normalize(undefined), '')
})

test('docText = 摘要 + 关键词;脏数据不炸', () => {
  assert.equal(docText({ summary: '他喜欢猫', keywords: ['猫', '', 7, null] }), '他喜欢猫 猫')
  assert.equal(docText({ summary: '', keywords: 'not-an-array' }), '')
  assert.equal(docText({}), '')
})

// ---------------------------------------------------------------- BM25 原语

test('BM25 常数与停用词表与 Python 侧一致(差分锚点)', () => {
  assert.equal(BM25_K1, 1.2)
  assert.equal(BM25_B, 0.75)
  assert.equal(MIN_COVERAGE, 0.10)
  assert.equal(DEDUPE_THRESHOLD, 0.55)
  assert.equal(DEDUPE_MIN_CHARS, 12)
  assert.equal(W_REL, 1.0)
  assert.equal(W_REC, 0.15)
  assert.equal(W_EMO, 0.02)
  assert.equal(L0_ALWAYS_ON_LIMIT, 8)
  assert.equal(CANDIDATE_LIMIT, 500)
  assert.equal(STOPWORDS.size, 133)
  assert.ok(STOPWORDS.has('为什') && STOPWORDS.has('什么') && STOPWORDS.has('为什么'))
  assert.ok(!STOPWORDS.has('猫') && !STOPWORDS.has('面试'))
})

// ------------------------------------------------- P1b 模块7:停用词的数据读点

test('P1b:停用词 —— 数据文件没填 ⇒ 就用**语言默认表**(同一张表,行为不变)', (t) => {
  resetStopwordsCache()
  const fromData = loadStopwords()
  if (fromData.length === 0) {
    assert.equal(stopwordsOf(), STOPWORDS, '空 ⇒ 回语言默认表(不是"没有停用词")')
  } else {
    t.diagnostic('本机 lexicon.json 填了 ' + fromData.length + ' 个 stopwords:跳过"回默认表"这条')
    assert.deepEqual([...stopwordsOf()].sort(), [...new Set(fromData)].sort(), '填了就以数据为准')
  }
  // 语言默认表本身还在(表是语言事实,不是个人数据 —— 文档 row 12 允许留程序)
  assert.equal(STOPWORDS.size, 133)
})

test('P1b:loadStopwords —— 缺文件/坏文件/脏条目降级成空表,永不抛', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-stop-'))
  try {
    const p = join(dir, 'lexicon.json')
    assert.deepEqual(loadStopwords(p), [])
    assert.deepEqual(loadStopwords(null), [])
    writeFileSync(p, '{坏', 'utf8')
    assert.deepEqual(loadStopwords(p), [])
    writeFileSync(p, JSON.stringify({ stopwords: [' 啊 ', '', 7, null, '嗯'] }), 'utf8')
    assert.deepEqual(loadStopwords(p), ['啊', '嗯'], '去空白、丢非字符串')
    writeFileSync(p, JSON.stringify({ stopwords: '不是数组' }), 'utf8')
    assert.deepEqual(loadStopwords(p), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P1b:stopwordsOf 按 mtime+size 失效 —— 改了文件落盘即生效,且 tokenize 真的照它滤', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-stop-cache-'))
  try {
    const p = join(dir, 'lexicon.json')
    // 数据文件里放一个自定义停用词:「猫」(默认表里没有它)
    writeFileSync(p, JSON.stringify({ stopwords: ['猫'] }), 'utf8')
    resetStopwordsCache()
    const first = stopwordsOf(p)
    assert.equal(first.has('猫'), true, '数据文件里的词生效')
    assert.equal(first.has('为什'), false, '数据表**覆盖**默认表(不是并集)')
    // 改文件 ⇒ 自动失效(不靠手动 reset)
    writeFileSync(p, JSON.stringify({ stopwords: ['猫', '狗'] }), 'utf8')
    assert.equal(stopwordsOf(p).has('狗'), true, 'size 变了要重读')

    // tokenize 真的接上了这张表:源码接线 + 真路径下的行为(默认表 ⇒ 「猫」必须留着,
    // 因为单字必须产,否则查询「猫」匹配不到文档「他喜欢猫」)
    assert.equal(tokenize('他喜欢猫').includes('猫'), true, '默认表下「猫」要留着')
    const src = readFileSync(new URL('../lib/lexical.js', import.meta.url), 'utf8')
    assert.ok(src.includes('const sw = stopwordsOf()'), 'tokenize 必须走 stopwordsOf 的读点')
    assert.ok(!/STOPWORDS\.has\(/.test(src.replace(/stopwordsCache[^\n]*\n/g, '')), '不该再有直接查 STOPWORDS 的漏网')
  } finally {
    resetStopwordsCache()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildIndex:df 按文档内去重计数;avgdl 是平均长度', () => {
  const idx = buildIndex([['a', 'a', 'b'], ['b', 'c']])
  assert.equal(idx.n, 2)
  assert.equal(idx.df.get('a'), 1)
  assert.equal(idx.df.get('b'), 2)
  assert.equal(idx.df.get('c'), 1)
  assert.equal(idx.df.get('nope'), undefined)
  assert.equal(idx.avgdl, 2.5)
  assert.deepEqual(idx.len, [3, 2])
  assert.equal(buildIndex([]).avgdl, 0)
})

test('BM25:termIdf 同 df 同值;queryTotalIdf 只累加 df>0( OOV 不进分母)', () => {
  const idx = buildIndex([['章鱼', '丸子'], ['章鱼'], ['猫']])
  // df=2, n=3 → log(1 + (3-2+0.5)/(2+0.5))
  assert.equal(termIdf(idx, '章鱼'), Math.log(1 + (3 - 2 + 0.5) / (2 + 0.5)))
  assert.equal(termIdf(idx, '量子'), Math.log(1 + (3 - 0 + 0.5) / (0 + 0.5)))
  assert.equal(queryTotalIdf(idx, ['章鱼', '量子', '丸子']), termIdf(idx, '章鱼') + termIdf(idx, '丸子'))
  assert.equal(queryTotalIdf(idx, ['量子']), 0, '库里没有的词不该进分母')
})

test('docCoverage:全命中单文档时=1;空查询/空语料=0;avgdl=0 不除零', () => {
  const docs = [tokenize('他喜欢猫')]
  const idx = buildIndex(docs)
  assert.equal(docCoverage(idx, docs[0], uniqTerms('猫')), 1.0)
  assert.equal(docCoverage(idx, docs[0], []), 0.0)
  assert.equal(docCoverage(buildIndex([]), [], uniqTerms('猫')), 0.0)
  // avgdl=0(只有空文档)时 norm 取 1,分母为 0 直接 0
  const empty = buildIndex([[]])
  assert.equal(docCoverage(empty, [], uniqTerms('猫'), 0), 0.0)
})

// ---------------------------------------------------------------- 近重复原语

test('charBigrams/jaccard:去空白取二字;单字符退化成自身', () => {
  assert.deepEqual([...charBigrams('ab')], ['ab'])
  assert.deepEqual([...charBigrams('a')], ['a'])
  assert.deepEqual([...charBigrams('')], [])
  assert.deepEqual([...charBigrams('a b')].sort(), ['ab'])
  assert.equal(jaccard(new Set(['a']), new Set()), 0)
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1)
})

test('nearDupOf:短于 12 字(去空白后)一律不参与判重', () => {
  // 「常规命中A」与「常规命中B」只差一个字,J 就达 0.6(≥ 阈值),
  // 于是三条互不相同的事实会被当成一条互相吃掉 —— 短串判重必须关掉。
  assert.equal(nearDupOf('常规命中A', ['常规命中B']), false)
  assert.equal(jaccard(charBigrams('常规命中A'), charBigrams('常规命中B')), 0.6)
  assert.equal(nearDupOf('他提到章鱼小丸子很难买到,几乎几年才能吃上一次。',
    ['他提到章鱼小丸子很难买到,几乎几年才能吃一次。']), true)
  assert.equal(nearDupOf('', []), false)
})

// ---------------------------------------------------------------- 差分锚点

test('★ 差分锚点:NOW 基准行与 Python 侧逐点对表(rank/hits/matched/total)', () => {
  const rows = [
    { ...base, memoryId: 1, keywords: ['大学'], summary: '用户就读于一所新工科大学,是西电大一新生' },
    { ...base, memoryId: 2, keywords: [], summary: '他提到章鱼小丸子很难买到,几乎几年才能吃一次', emotionScore: 8 },
    { ...base, memoryId: 3, keywords: ['称呼'], summary: '他喜欢被叫阿岚', layer: 'L0', intrinsicValue: 90 },
    { ...base, memoryId: 4, keywords: [], summary: '他喜欢猫' }
  ]
  // 期望值来自 python/engine/retrieve.py 在同 fixture 上的实测输出。
  const expect = {
    章鱼小丸子: [
      { memoryId: 3, hits: 0.0, matched: false, total: 0.244, forced: true },
      { memoryId: 2, hits: 0.8346, matched: true, total: 1.1386, forced: false }
    ],
    猫: [
      { memoryId: 3, hits: 0.0, matched: false, total: 0.244, forced: true },
      { memoryId: 4, hits: 1.0, matched: true, total: 1.244, forced: false }
    ],
    新生: [
      { memoryId: 3, hits: 0.0, matched: false, total: 0.244, forced: true },
      { memoryId: 1, hits: 0.9364, matched: true, total: 1.1804, forced: false }
    ],
    他喜欢猫: [
      // L0 这条自己也算命中(它含「喜欢」),但入选靠的是强制占位 ⇒ forced
      { memoryId: 3, hits: 0.5045, matched: true, total: 0.7485, forced: true },
      { memoryId: 4, hits: 1.0, matched: true, total: 1.244, forced: false }
    ]
  }
  for (const [q, exp] of Object.entries(expect)) {
    const top = rankMemories(rows.map(r => ({ ...r })), q, 6, NOW)
    assert.deepEqual(top.map(it => ({
      memoryId: it.memoryId, hits: it.hits, matched: it.matched, total: it.total, forced: it.forced
    })), exp, '查询「' + q + '」与 Python 侧对不上')
    for (const it of top) {
      assert.equal(it.rNow, 0.96)
      assert.equal(it.halfLife, 24.0)
      assert.equal(it.ageDays, (NOW - (NOW - 3600)) / 86400)
    }
  }
})

test('★ 差分锚点:词元 / BM25 统计与 Python 侧逐点对表', () => {
  const rows = [
    { ...base, memoryId: 1, keywords: ['大学'], summary: '用户就读于一所新工科大学,是西电大一新生' },
    { ...base, memoryId: 2, keywords: [], summary: '他提到章鱼小丸子很难买到,几乎几年才能吃一次', emotionScore: 8 },
    { ...base, memoryId: 3, keywords: ['称呼'], summary: '他喜欢被叫阿岚', layer: 'L0', intrinsicValue: 90 },
    { ...base, memoryId: 4, keywords: [], summary: '他喜欢猫' }
  ]
  const docs = rows.map(r => tokenize(docText(r)))
  const idx = buildIndex(docs)
  assert.equal(idx.n, 4)
  assert.equal(idx.avgdl, 24.25)
  assert.deepEqual(idx.len, [38, 36, 16, 7])
  assert.equal(idx.df.get('他喜'), 2)
  assert.equal(idx.df.get('子'), 1)
  assert.ok(Math.abs(termIdf(idx, '章鱼') - 1.2039728043259361) < 1e-12)
  assert.ok(Math.abs(termIdf(idx, '量子') - 2.302585092994046) < 1e-12)
  const qt = uniqTerms('章鱼小丸子')
  assert.ok(Math.abs(queryTotalIdf(idx, qt) - 10.835755238933425) < 1e-12)
  assert.ok(Math.abs(docCoverage(idx, docs[1], qt) - 0.8345717637856863) < 1e-12)
  assert.equal(docCoverage(idx, docs[0], qt), 0.0)
  assert.equal(docCoverage(idx, docs[3], uniqTerms('猫')), 1.0)
  // 单字查询的覆盖率锚点
  assert.equal(docCoverage(idx, tokenize('他喜欢猫'), uniqTerms('猫')), 1.0)
  assert.ok(Math.abs(jaccard(
    charBigrams('他提到章鱼小丸子很难买到,几乎几年才能吃一次'),
    charBigrams('他提到章鱼小丸子很难买到,几乎几年才能吃上 一次')) - 0.8695652173913043) < 1e-12)
})
