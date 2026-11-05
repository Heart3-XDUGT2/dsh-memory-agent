/**
 * 033：直接图与引用图分开命名，只把实际成功提供的单图绑定到对应名称。
 * 仅用于含转发配图的消息；普通图片仍走原有批量通路。
 */
export async function prepareForwardImages (env, {
  collectImages, saveImageBlocks, describeImages, isStickerImage, attachments
}) {
  const direct = Array.isArray(env.images) ? env.images : []
  const quoted = Array.isArray(env.forwardContent?.images) ? env.forwardContent.images : []
  const refs = [...direct, ...quoted]
  const labels = refs.map((_ref, index) => index < direct.length
    ? '直接图片：图' + (index + 1)
    : '引用配图：图' + (index - direct.length + 1))
  const limits = attachments?.imageLimits ?? {}
  const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback
  const maxCount = Math.min(4, Math.floor(positive(limits.maxImagesPerMessage, 4)))
  const maxBytes = positive(limits.maxMessageImageBytes, 20 * 1024 * 1024)
  const blocks = [], problems = [], facts = []
  let bytes = 0, count = 0, loaded = 0, stickers = 0
  for (let index = 0; index < refs.length; index++) {
    const label = labels[index]
    if (loaded >= maxCount || bytes >= maxBytes) {
      facts.push(label + '：未提供（本次图像预算已用完）。')
      problems.push({ index, reason: '图像预算已用完' })
      continue
    }
    let result
    try {
      result = await collectImages([refs[index]], {
        limits, maxCount: 1, maxTotalBytes: Math.max(0, maxBytes - bytes)
      })
    } catch { result = null }
    if (!Array.isArray(result?.images) || result.images.length !== 1) {
      facts.push(label + '：未提供（未成功读取）。')
      problems.push({ index, reason: '图片未成功读取' })
      continue
    }
    const image = result.images[0]
    loaded += 1
    bytes += Math.max(0, Number(result.bytes) || image.data?.byteLength || 0)
    let saved
    try { saved = await saveImageBlocks(attachments, [image]) } catch { saved = null }
    if (!Array.isArray(saved) || saved.length !== 1 || saved[0]?.type !== 'image' || !saved[0].attachment) {
      facts.push(label + '：未提供（未取得可验证的附件）。')
      problems.push({ index, reason: '图片附件未成功提供' })
      continue
    }
    blocks.push({ type: 'text', text: '[' + label + '；紧随其后仅为这张图片。]' }, saved[0])
    facts.push(label + '：已作为紧邻该名称的图像块提供。')
    count += 1
    if (isStickerImage(image)) stickers += 1
  }
  const description = describeImages(count, problems, { stickers, noReply: false })
  return {
    blocks, count,
    text: [description, '[图片提供情况]', ...facts].filter(Boolean).join('\n')
  }
}
