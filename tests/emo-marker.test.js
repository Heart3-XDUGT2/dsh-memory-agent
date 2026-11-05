/**
 * `lib/emo-marker.js` 的电池(2026-10-05 拍板 1/2;2026-10-07 换 XML 语法)。
 *
 * 钉住四件事:
 *   ① **语法契约与 heart-tts 一致** —— `<emo type="…">…</emo>` / `<skip>…</skip>`,
 *      半角单引号与双引号都认、属性值前后可有空格、标签名大小写不敏感;
 *   ② **两种标签的语义不同** —— `<emo>` 只丢标签**留正文**,`<skip>` **连正文一起丢**;
 *   ③ **畸形原样保留**(宁可漏剥,不误删正文),但**未闭合的 `<skip>` 例外**
 *      (按"到文本末尾"处理 —— 标签绝不许显示给他看);
 *   ④ **接线真的在**(源码级守卫)—— 助手文本入口那一行必须真的调它,
 *      否则模块再对也没人用(这个包对"接线漂了"有前科:见 check-syntax 的注释)。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripEmoMarkers, hasEmoMarker } from '../lib/emo-marker.js'

test('emo:半角单双引号都认(与 heart-tts 同口径)', () => {
  assert.equal(stripEmoMarkers('<emo type="2">你好</emo>'), '你好')
  assert.equal(stripEmoMarkers("<emo type='2'>你好</emo>"), '你好')
})

test('emo:属性值前后可有空格;标签名大小写不敏感', () => {
  assert.equal(stripEmoMarkers('<emo type = "2">你好</emo>'), '你好')
  assert.equal(stripEmoMarkers('<emo type=" 2 ">你好</emo>'), '你好')
  assert.equal(stripEmoMarkers('<EMO TYPE="2">你好</EMO>'), '你好')
  assert.equal(stripEmoMarkers('<emo  type="2" >你好</emo >'), '你好', '开/闭标签内侧空格也认')
})

test('emo:只丢标签、留正文(句中/句尾/连着多个都剥干净)', () => {
  assert.equal(stripEmoMarkers('我明白了。<emo type="2">但这个我不能答应你。</emo>'),
    '我明白了。但这个我不能答应你。')
  assert.equal(stripEmoMarkers('但<emo type="2">这个</emo>不行'), '但这个不行')
  assert.equal(stripEmoMarkers('我明白了。<emo type="2">'), '我明白了。', '有开无闭:开标签照样剥(它本身不该显示)')
  assert.equal(stripEmoMarkers('<emo type="1">一</emo><emo type="2">二</emo><emo type="3">三</emo>'), '一二三')
  assert.equal(stripEmoMarkers('<emo type="强调·上扬">按名字写也认。</emo>'), '按名字写也认。')
})

test('skip:连正文一起去掉(那是"别读",文字渠道也不该显示)', () => {
  assert.equal(stripEmoMarkers('这段要读。<skip>这段是内部备注,别念。</skip>后面继续读。'),
    '这段要读。后面继续读。')
  assert.equal(stripEmoMarkers('<skip>整条都不该出现。</skip>'), '')
  assert.equal(stripEmoMarkers('前面<skip>a</skip>中间<skip>b</skip>后面'), '前面中间后面', '多个 skip 都吃掉')
})

test('skip 与 emo 混排:skip 先走,emo 只留正文', () => {
  assert.equal(stripEmoMarkers('<emo type="2"><skip>藏起来</skip>这句要读。</emo>'), '这句要读。')
  assert.equal(stripEmoMarkers('<skip><emo type="2">都藏</emo>也藏</skip>露出来的'),
    '露出来的', 'skip 里的 emo 标签连同正文一起没')
  assert.equal(stripEmoMarkers('<emo type="2">先开标签<skip>中间藏</skip>后收标签</emo>'),
    '先开标签后收标签')
})

test('skip:未闭合按「到文本末尾」处理(标签绝不许显示给他看)', () => {
  // 这不是"误删正文":被 <skip> 标住的内容本来就明说了不该显示。
  // 留一个 <skip> 在界面上才是直接违反硬约束 —— 两害相权取其轻。
  assert.equal(stripEmoMarkers('这段要读。<skip>后面这些都不要显示'), '这段要读。')
  assert.equal(stripEmoMarkers('<skip>', ''), '')
  assert.equal(stripEmoMarkers('普通文字<SKIP>大小写不敏感'), '普通文字')
})

test('emo:形状完整就剥(哪怕 type 缺了/写歪了)—— 不许留半截标签', () => {
  // 判据是**形状**不是 `type` 合法性:要求 type 会造出"开标签留着、闭标签剥掉"
  // 的半截状态,比两种极端都难看。type 必填是模型那边的契约,不是这里的判据。
  assert.equal(stripEmoMarkers('<emo>缺 type 的</emo>'), '缺 type 的')
  assert.equal(stripEmoMarkers('<emo type="">空值的</emo>'), '空值的')
  assert.equal(stripEmoMarkers('<emo type="2>引号没闭合</emo>'), '引号没闭合')
  assert.equal(stripEmoMarkers('<emo type="' + 'x'.repeat(60) + '">再长也认</emo>'), '再长也认')
})

test('emo:残留片段(标签被截断)不许动', () => {
  // 主包拿到的是整条消息,不做 delta 状态机;截断的片段不是标签。
  assert.equal(stripEmoMarkers('她说<emo type="2'), '她说<emo type="2')
  assert.equal(stripEmoMarkers('她说<em'), '她说<em')
  assert.equal(stripEmoMarkers('她说<'), '她说<')
  assert.equal(stripEmoMarkers('数学 a < b 且 c > d'), '数学 a < b 且 c > d', '普通尖括号不许动')
  assert.equal(stripEmoMarkers('普通<标签>文字'), '普通<标签>文字', '不是指令的尖括号不许动')
})

test('emo:只剥标签 —— emoji / 加粗 / 链接 / 正文一个字不动', () => {
  assert.equal(stripEmoMarkers('😀 **加粗** [链接](https://x.test) <emo type="2">走起</emo>'),
    '😀 **加粗** [链接](https://x.test) 走起')
  assert.equal(stripEmoMarkers('## 标题\n- 列表项'), '## 标题\n- 列表项')
  assert.equal(stripEmoMarkers('  两边空格保留  '), '  两边空格保留  ')
})

test('emo:输入形状再怪也不许抛(这条通道要吃她的任何输出)', () => {
  assert.equal(stripEmoMarkers(null), '')
  assert.equal(stripEmoMarkers(undefined), '')
  assert.equal(stripEmoMarkers(''), '')
  assert.equal(stripEmoMarkers(123), '123')
  assert.doesNotThrow(() => stripEmoMarkers({}))
})

test('emo:hasEmoMarker 只判不改,而且判据与 strip 天然一致', () => {
  assert.equal(hasEmoMarker('<emo type="2">你好</emo>'), true)
  assert.equal(hasEmoMarker('<skip>藏</skip>'), true, 'skip 也算"有东西要剥"')
  assert.equal(hasEmoMarker('你好'), false)
  assert.equal(hasEmoMarker(''), false)
  assert.equal(hasEmoMarker(null), false)
  assert.equal(hasEmoMarker('<emo>形状完整就算有</emo>'), true)
  assert.equal(hasEmoMarker('<标签>剥不动的就不算有</标签>'), false, '判据与 strip 一致')
  // 连调两次结果必须一致(旧实现要手动复位 g 正则的 lastIndex,这里不该有那个坑)
  assert.equal(hasEmoMarker('<emo type="2">x</emo>'), true)
  assert.equal(hasEmoMarker('<emo type="2">x</emo>'), true)
  // 判完不改文本:剥一次仍然剥得掉
  assert.equal(stripEmoMarkers('<emo type="2">x</emo>'), 'x')
})

test('接线守卫:助手文本入口那行真的调了 stripEmoMarkers(源码级)', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /import \{ stripEmoMarkers \} from '\.\/emo-marker\.js'/, 'import 必须在')
  assert.match(src, /stripEmoMarkers\(textOf\(msg\)\.trim\(\)\)/,
    'lib/index.js 的 assistant/message 分支必须对 textOf(msg) 剥一次(一处修三个消费者)')
})
