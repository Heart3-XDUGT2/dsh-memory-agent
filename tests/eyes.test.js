/**
 * 她的眼睛 —— `lib/eyes.js` 电池。
 *
 * 盯的是**最贵的那几个错**:
 *   · 抓不到图时**不许抛**(一轮对话不能因为一张图消失);
 *   · 不信声明、只信字节头(声明错了 = 一次 admission 失败,宿主会拒);
 *   · 上限真的要生效(单张、总字节、张数);
 *   · URL 是主路(QQ 的链接会过期 → 收到就抓),path/base64 是兜底。
 *
 * 一个字节都不出网:fetch 是注入的假货。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sniffMediaType, pickImageSource, loadImage, collectImages, describeImages, saveImageBlocks, inboundContent } from '../lib/eyes.js'

/** 最小 PNG/JPEG/GIF/WEBP 头(只够嗅探,不解码)。 */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 2, 3])
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 2, 3, 4, 5, 6])
const WEBP = Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBP'].map((c) => c.charCodeAt(0))))
const NOT_IMAGE = new Uint8Array(Buffer.from('<html>not an image at all</html>'))

/** 假 Response。 */
const res = (bytes, { status = 200, contentLength = null } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => (k.toLowerCase() === 'content-length' && contentLength !== null ? String(contentLength) : null) },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
})

test('只信字节头:四种图认得出来,别的认不出来', () => {
  assert.equal(sniffMediaType(PNG), 'image/png')
  assert.equal(sniffMediaType(JPEG), 'image/jpeg')
  assert.equal(sniffMediaType(GIF), 'image/gif')
  assert.equal(sniffMediaType(WEBP), 'image/webp')
  assert.equal(sniffMediaType(NOT_IMAGE), null)
  assert.equal(sniffMediaType(new Uint8Array(4)), null, '太短的一律不认')
})

test('来源优先级:URL 主路,file:// 与本地路径兜底,base64 最后', () => {
  assert.deepEqual(pickImageSource({ url: 'https://cdn.qq/moon.jpg', path: 'C:/x.jpg' }), { kind: 'url', value: 'https://cdn.qq/moon.jpg' })
  assert.equal(pickImageSource({ file: 'http://cdn.qq/a.png' }).kind, 'url')
  assert.equal(pickImageSource({ file: 'file:///C:/x/a.png' }).kind, 'path')
  assert.equal(pickImageSource({ path: 'C:/x/a.png' }).kind, 'path')
  assert.equal(pickImageSource({ data: 'AAAA' }).kind, 'data')
  assert.equal(pickImageSource({ name: 'x.jpg' }), null, '一条来源都没有 = 没得抓')
})

test('URL 抓下来 → 字节 + 类型 + 显示名(名字只留文件名)', async () => {
  const got = await loadImage(
    { url: 'https://cdn.qq/moon.jpg', name: 'C:\\Users\\x\\secret\\月亮.jpg' },
    { fetchImpl: async () => res(JPEG) }
  )
  assert.equal(got.ok, true)
  assert.equal(got.mediaType, 'image/jpeg')
  assert.equal(got.name, '月亮.jpg', '路径语义不给它(附件的 name 不是路径)')
  assert.equal(got.from, 'url')
  assert.equal(got.data.length, JPEG.length)
})

test('抓不到就是抓不到 —— 而且**永远不抛**(一轮对话不能因一张图消失)', async () => {
  const cases = [
    [{ url: 'https://cdn.qq/gone.jpg' }, async () => res(NOT_IMAGE, { status: 404 }), /HTTP 404/],
    [{ url: 'https://cdn.qq/big.jpg' }, async () => res(PNG, { contentLength: 99999999 }), /图太大/],
    [{ url: 'https://cdn.qq/html.jpg' }, async () => res(NOT_IMAGE), /不是一张我认得的图/],
    [{ url: 'https://cdn.qq/x.jpg' }, async () => { throw new Error('connect ECONNREFUSED') }, /抓取出错/],
    [{ url: 'https://cdn.qq/x.jpg' }, async () => res(new Uint8Array(0)), /空字节/],
    [{ name: 'x.jpg' }, async () => res(PNG), /没给 url\/path\/data/]
  ]
  for (const [one, fetchImpl, want] of cases) {
    const got = await loadImage(one, { fetchImpl })
    assert.equal(got.ok, false, String(one.url))
    assert.match(got.reason, want)
  }
  const noFetch = await loadImage({ url: 'https://x/y.jpg' }, { fetchImpl: null })
  assert.equal(noFetch.ok, false)
})

test('超时:慢的 CDN 不拖住这一轮', async () => {
  const hang = (url, opts) => new Promise((_, reject) => {
    opts?.signal?.addEventListener('abort', () => {
      const err = new Error('aborted'); err.name = 'AbortError'; reject(err)
    })
  })
  const got = await loadImage({ url: 'https://cdn.qq/slow.jpg' }, { fetchImpl: hang, timeoutMs: 30 })
  assert.equal(got.ok, false)
  assert.equal(got.reason, '抓取超时')
})

test('同机文件与 base64 也走得通(URL 之外的兜底)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'echo-eyes-'))
  try {
    const p = join(dir, 'moon.png')
    await writeFile(p, PNG)
    const fromPath = await loadImage({ path: p })
    assert.equal(fromPath.ok, true)
    assert.equal(fromPath.mediaType, 'image/png')
    assert.equal(fromPath.name, 'moon.png')
    const fromFile = await loadImage({ file: 'file:///' + p.replace(/\\/g, '/') })
    assert.equal(fromFile.ok, true)
    const fromData = await loadImage({ data: 'base64://' + Buffer.from(JPEG).toString('base64'), name: 'moon' })
    assert.equal(fromData.ok, true)
    assert.equal(fromData.mediaType, 'image/jpeg')
    assert.equal(fromData.name, 'moon.jpg', '没后缀就按类型补')
    const missing = await loadImage({ path: join(dir, 'nope.png') })
    assert.equal(missing.ok, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('一条消息的上限:张数 + 总字节,超了要说清是哪一张', async () => {
  const only = async (bytes) => ({ fetchImpl: async () => res(bytes) })
  const many = await collectImages([
    { url: 'https://x/1.png' }, { url: 'https://x/2.png' }, { url: 'https://x/3.png' },
    { url: 'https://x/4.png' }, { url: 'https://x/5.png' }
  ], { ...(await only(PNG)), limits: { maxImagesPerMessage: 4 } })
  assert.equal(many.images.length, 4)
  assert.equal(many.problems.length, 1)
  assert.match(many.problems[0].reason, /太多/)

  const budget = await collectImages([{ url: 'https://x/1.png' }, { url: 'https://x/2.png' }],
    { ...(await only(PNG)), maxTotalBytes: PNG.length + 1 })
  assert.equal(budget.images.length, 1)
  assert.match(budget.problems[0].reason, /加起来太大/)

  const mixed = await collectImages([{ url: 'https://x/ok.png' }, { url: 'https://x/gone.png' }], {
    fetchImpl: async (url) => (url.includes('gone') ? res(NOT_IMAGE, { status: 500 }) : res(PNG))
  })
  assert.equal(mixed.images.length, 1)
  assert.equal(mixed.problems.length, 1)
  assert.equal(mixed.bytes, PNG.length)
})

test('落库:字节 → 宿主的附件引用 → image block(服务不在要抛,让调用方去降级)', async () => {
  const seen = []
  const store = {
    saveImages: async (inputs) => inputs.map((i, idx) => {
      seen.push(i)
      return { id: 'att-' + idx, mediaType: i.mediaType, bytes: i.data.length }
    })
  }
  const one = { data: JPEG, mediaType: 'image/jpeg', name: '月亮.jpg' }
  const two = { data: PNG, mediaType: 'image/png', name: 'moon.png' }
  const blocks = await saveImageBlocks(store, [one, two])
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0], { type: 'image', attachment: { id: 'att-0', mediaType: 'image/jpeg', bytes: JPEG.length } })
  assert.equal(seen[0].mediaType, 'image/jpeg', '声明的类型要跟嗅探出来的一致(对不上就是一次 admission 失败)')
  assert.equal(seen[0].name, '月亮.jpg')
  assert.ok(seen[0].data instanceof Uint8Array)
  // 宿主返回单个引用(不是数组)也得吃
  const single = await saveImageBlocks({ saveImages: async () => ({ id: 'only' }) }, [one])
  assert.equal(single[0].attachment.id, 'only')
  // 服务不在 = 抛(调用方负责把「没看见」写进正文,而不是静默)
  await assert.rejects(() => saveImageBlocks(null, [one]), /attachments 服务/)
  await assert.rejects(() => saveImageBlocks({}, [one]), /attachments 服务/)
  // 没有图就不该碰服务
  assert.deepEqual(await saveImageBlocks(null, []), [])
})

test('注入内容:图在前、正文在后(正文离她最近)', () => {
  const blocks = [{ type: 'image', attachment: { id: 'a' } }]
  const content = inboundContent(blocks, '【QQ·私聊】阿岚说:看月亮')
  assert.equal(content.length, 2)
  assert.equal(content[0].type, 'image')
  assert.equal(content[1].type, 'text')
  assert.match(content[1].text, /看月亮/)
  assert.deepEqual(inboundContent([], '只有字'), [{ type: 'text', text: '只有字' }])
  assert.equal(inboundContent(blocks, undefined)[1].text, '', '没有正文也不能是 undefined(宿主校验无损 JSON)')
})

test('贴在她正文旁边的那一行:看见几张要说,没抓到的更要说', () => {
  assert.equal(describeImages(0, []), '')
  // ★ 2026-10-20：文案改了 —— 从"图就在下面,你看得到"变成"怎么用图"
  assert.match(describeImages(1, []), /他发来 1 张图/)
  const bad = describeImages(1, [{ index: 1, reason: '抓取超时' }])
  assert.match(bad, /有1张图没抓下来:抓取超时/)
  assert.match(bad, /别当自己看过了/)
  assert.match(describeImages(0, [{ index: 0, reason: '图太大(90000000 字节)' }]), /图太大/)
})

// ---- ★ 2026-10-20：提示语分岔（普通图 / 表情包）-----------------------------
//
// 他拍的措辞。原来只有"图就在下面,你看得到" —— 只说了"你看得见"，
// 没说怎么用 ⇒ 她按"看图说话"默认行为逐张描述，很生硬。

test('★ 普通图:明说"不逐张描述、不罗列画面细节"', () => {
  const line = describeImages(2, [])
  assert.match(line, /他发来 2 张图/, '要说几张')
  assert.match(line, /当聊天里看到的东西/, '要说"当聊天素材"')
  assert.match(line, /用你自己的话说一句/, '要给出"怎么说"')
  assert.match(line, /不要逐张描述/, '★ 必须明确禁止逐张描述')
  assert.match(line, /不要罗列画面细节/, '★ 必须明确禁止罗列细节')
  assert.ok(!line.includes('你看得到'), '旧的"你看得到"不该再出现')
})

test('★ 表情包:给她判断权（"看情况"），且不强制接', () => {
  const line = describeImages(1, [], { stickers: 1 })
  assert.match(line, /他发来 1 个表情包/, '要说是表情包')
  assert.match(line, /看情况/, '★ 关键词:给她判断权')
  assert.match(line, /有信息量/, '要说清"什么时候该接"')
  assert.match(line, /表达情绪/, '情绪/梗那一类')
  assert.match(line, /不用专门提这个表情包/, '★ 不强制提')
  // 表情包那句**不该**混进"逐张描述"那套话
  assert.ok(!line.includes('不要罗列画面细节'), '表情包不该用普通图那套说辞')
})

test('★ 图 + 表情包混着发 ⇒ 两句都要在，各说各的', () => {
  const line = describeImages(2, [], { stickers: 1 })
  assert.match(line, /他发来 1 张图/)
  assert.match(line, /他发来 1 个表情包/)
  assert.match(line, /不要逐张描述/)
  assert.match(line, /看情况/)
  // 顺序:普通图在前
  assert.ok(line.indexOf('张图') < line.indexOf('个表情包'))
})

test('★ stickers 参数防御:超范围/负数/非数字都夹回合理值', () => {
  // 超过 count ⇒ 全当表情包
  const over = describeImages(2, [], { stickers: 99 })
  assert.match(over, /他发来 2 个表情包/)
  assert.ok(!over.includes('张图'))
  // 负数 / NaN ⇒ 全当普通图
  assert.match(describeImages(2, [], { stickers: -5 }), /他发来 2 张图/)
  assert.match(describeImages(2, [], { stickers: 'x' }), /他发来 2 张图/)
})

test('★ 抓取失败那句仍然独立（表情包不影响它）', () => {
  const line = describeImages(1, [{ index: 1, reason: '超时' }], { stickers: 1 })
  assert.match(line, /个表情包/)
  assert.match(line, /没抓下来:超时/)
  assert.match(line, /别当自己看过了/)
})

// ---- ★ 2026-10-20（第二版）：单发图/表情 ⇒ "不用回" -------------------------
//
// 他拍的：「她应该能识别表情，但是不做回复」。
// 上一版把图片-only 做成"暂存、压根不注入" —— 那是**她根本看不到**，不叫识别。
// 现在：**图照样进上下文**（所以"能识别"），正文明说"不用回"（所以"不回复"）。

test('★ 单发表情包 ⇒ 用"单发+不用回"句式（不是逐张描述那套）', () => {
  const line = describeImages(1, [], { stickers: 1, noReply: true })
  assert.match(line, /他单发了个表情包/, '★ 照他给的原话')
  assert.match(line, /这条不用回/, '★ 关键:明说不用回')
  assert.match(line, /你自己心里有数就行/, '★ 不是不让她看，是让她心里有数')
  // 单发时不该再出现"看情况/接一下"那套 —— 那是"跟着话发"时的判断
  assert.ok(!line.includes('看情况'), '单发时不该再给她"接不接"的纠结')
  assert.ok(!line.includes('不要罗列画面细节'), '单发时不需要那套描述禁令')
})

test('★ 单发一张图 ⇒ 同样"不用回"', () => {
  const line = describeImages(1, [], { noReply: true })
  assert.match(line, /他单发了一张图/, '★ 单数用中文')
  assert.match(line, /这条不用回/)
  assert.ok(!line.includes('不要逐张描述'), '单发时不需要那套描述禁令')
})

test('★ 单发多张 ⇒ 数字 + 空格，别拼出"单发了3 张图"', () => {
  const line = describeImages(3, [], { noReply: true })
  assert.match(line, /他单发了 3 张图/, '要有空格')
  assert.ok(!line.includes('单发了3'), '不能夹生')
})

test('★ 单发 图+表情混着 ⇒ 两个都点名', () => {
  const line = describeImages(2, [], { stickers: 1, noReply: true })
  assert.match(line, /1 张图/)
  assert.match(line, /1 个表情包/)
  assert.match(line, /这条不用回/)
})

test('★ 图片 + 文字 ⇒ **不用回那句不该出现**（照常回）', () => {
  const withText = describeImages(1, [], {})                       // noReply 不传
  assert.ok(!withText.includes('不用回'), '★ 他带了字就得正常回')
  assert.match(withText, /不要逐张描述/)
  const stickerWithText = describeImages(1, [], { stickers: 1 })
  assert.ok(!stickerWithText.includes('不用回'))
  assert.match(stickerWithText, /看情况/)
})

test('★ 单发 + 抓取失败 ⇒ 两句都在（"不用回"不妨碍告诉她哪张没到手）', () => {
  const line = describeImages(1, [{ index: 1, reason: '超时' }], { stickers: 1, noReply: true })
  assert.match(line, /这条不用回/)
  assert.match(line, /没抓下来:超时/)
})
