/** Normalize legacy role words in generated memory/graph text at injection time. */
const escape = value => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

export function rewriteGeneratedRoleText (text, { userName = '', agentName = '' } = {}) {
  let out = String(text ?? '')
  const owner = String(userName || '').trim()
  const agent = String(agentName || '').trim()
  if (owner === '' && agent === '') return out

  // Historical extract summaries sometimes treated the owner's configured name
  // as Echo's name: "用户向<owner>..." / "舍不得<owner>". Fix only these
  // generated-role patterns; quoted user text is never passed through here.
  if (owner !== '' && agent !== '') {
    const o = escape(owner)
    out = out.replace(new RegExp(`用户(?=(?:向|对|给|告诉|觉得|担心|舍不得)${o})`, 'gu'), '主人')
    out = out.replace(new RegExp(`(?<=(?:向|对|给|告诉|觉得|担心|舍不得|请|和|与))${o}`, 'gu'), agent)
    out = out.replace(new RegExp(`用户(?=(?:向|对|给|告诉|觉得|担心|舍不得|请))`, 'gu'), '主人')
    out = out.replace(new RegExp(`用户(?=的(?:QQ号|称呼|学校|专业|兴趣|问题))`, 'gu'), '主人')
  }

  // Graph role slot: "用户" is the owner role, not a second person.
  out = out.replace(/(^|[\n])(\d+\.\s*)?(?:\[核心\]\s*)?用户(?=-\[)/gu,
    (_match, prefix, number = '') => prefix + String(number || '') + '主人' + (owner ? `（${owner}）` : ''))
  if (owner !== '') {
    out = out.replace(new RegExp(`主人（${escape(owner)}）-\\[称呼\\]->\\s*${escape(owner)}`, 'gu'),
      `主人（${owner}）的称呼是${owner}`)
  }
  out = out.replace(/(^|[\n。；])用户(?=\s*的)/gu, '$1主人' + (owner ? `（${owner}）` : ''))
  return out
}
