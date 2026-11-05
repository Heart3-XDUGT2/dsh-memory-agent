/** 033：当前真实QQ轮次内的只读转发分页工具。 */
import { parseRelayContent, renderRelayContent, isForwardLabel } from './relay-content.js'
import { createQQReadOrigin } from './qq-read-origin.js'

const NAME = 'echo_qq_forward_read'
const integer = value => Number.isSafeInteger(value) && value >= 0
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const FAILURE_TEXT = {
  disabled: '当前不能读取QQ转发。',
  'invalid-arguments': '请使用当前聊天中显示的转发名称和有效页码。',
  'unproven-origin': '无法确认这是当前QQ聊天的读取请求。',
  unavailable: '转发读取服务当前不可用。',
  expired: '这份转发已失效，请重新发送。',
  'invalid-response': '未能取得可验证的转发页面。',
  canceled: '本次读取已取消。',
  'stale-turn': '来源或轮次已变化，本次读取结果未提供。'
}
const failure = reason => ({ ok: false, reason })

function definition (execute) {
  return {
    name: NAME,
    description: '继续读取当前QQ聊天已经收到的合并转发。使用消息显示的完整转发名称和页码；只返回原作者引文，图片不会随本次工具结果提供。',
    parameters: {
      ref: { type: 'string', description: '当前聊天显示的完整转发名称', required: true },
      page: { type: 'number', description: '要读取的页码，从1开始', required: true }
    },
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true }, reason: { type: 'string' },
          ref: { type: 'string' }, page: { type: 'number' }, totalPages: { type: 'number' },
          hasMore: { type: 'boolean' }, text: { type: 'string' }, imageCount: { type: 'number' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value?.ok === true
        ? String(value.text || '') : (FAILURE_TEXT[value?.reason] || FAILURE_TEXT['unproven-origin']) }]
    },
    execute
  }
}


/** 原有转发schema、呈现及失败行为保留，来源证明与文件固定域共享。 */
export function createForwardReader (options = {}) {
  const origin = createQQReadOrigin({ ...options, domain: 'forward' })
  async function execute (args, exec) {
    if (!object(args) || Object.keys(args).some(name => !['ref', 'page'].includes(name))
      || !isForwardLabel(args.ref) || !integer(args.page) || args.page < 1 || args.page > 256) return failure('invalid-arguments')
    return origin.run(args, exec, async ({ service: channel, ref, label, source }) => {
      const entry = { ref, label }
      const result = await channel.readForward({ ref, page: args.page, source })
      if (result?.ok !== true) return failure(result?.reason === 'not-found' ? 'expired' : 'unavailable')
      const forward = parseRelayContent({ forwardContent: result.forwardContent }).forwardContent
      if (!forward || forward.ref !== entry.ref || forward.label !== entry.label || forward.page !== args.page) return failure('invalid-response')
      const imageCount = forward.images.length
      let text = renderRelayContent({ forwardContent: forward })
      if (imageCount) text += '\n本页含' + imageCount + '张图片；未向本次工具结果提供图片，本次未读。'
      return { ok: true, ref: entry.label, page: forward.page, totalPages: forward.totalPages,
        hasMore: forward.hasMore, text, imageCount }
    })
  }
  return Object.freeze({ bind: origin.bind, observeClaim: origin.observeClaim,
    observeSessionEvent: origin.observeSessionEvent, toolDefinition: () => definition(execute), dispose: origin.dispose })
}
