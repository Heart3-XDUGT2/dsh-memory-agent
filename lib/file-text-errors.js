const messages = Object.freeze({
  INVALID_INPUT: ['文件输入无效。', '请重新发送有效文件。'],
  UNSUPPORTED_FORMAT: ['暂不支持这种文件格式。', '请使用 TXT、Markdown、文字型 PDF 或 DOCX。'],
  FORMAT_MISMATCH: ['文件类型与内容不匹配。', '请重新导出为对应格式后发送。'],
  FILE_TOO_LARGE: ['文件超过本次读取大小上限。', '请拆分或缩小文件。'],
  INVALID_ENCODING: ['文件不是可读取的 UTF-8 文本。', '请转为 UTF-8 后重新发送。'],
  BINARY_TEXT: ['文件包含二进制内容，不能作为文字读取。', '请发送对应的受支持文档格式。'],
  PDF_ENCRYPTED: ['PDF 需要密码或无法解密。', '请发送已解锁的副本。'],
  PDF_INVALID: ['PDF 内容损坏或无法解析。', '请重新导出 PDF 后发送。'],
  PDF_PAGE_LIMIT: ['PDF 页数超过本次读取上限。', '请拆分文档后重新发送。'],
  NO_EXTRACTABLE_TEXT: ['未能提取到文字。', '文件可能是扫描件、空白或文字编码无法提取；可补充文字版。'],
  DOCX_INVALID: ['DOCX 内容损坏或结构不受支持。', '请重新导出 DOCX 后发送。'],
  DOCX_ENCRYPTED: ['文档可能已加密，或使用不支持的 Office 复合结构，不能读取。', '请发送已解锁的标准 DOCX 或导出文字版。'],
  DOCX_MACRO: ['不读取包含宏的文档。', '请导出不含宏的 DOCX 副本。'],
  ZIP_ENTRY_LIMIT: ['文档内部项目数量超过上限。', '请简化或拆分文档。'],
  ZIP_EXPANDED_LIMIT: ['文档解压内容超过上限。', '请缩小或拆分文档。'],
  XML_BYTE_LIMIT: ['文档文字结构超过大小上限。', '请拆分文档。'],
  XML_DEPTH_LIMIT: ['文档文字结构过深。', '请重新导出较简单的文档。'],
  XML_UNSAFE: ['文档包含不接受的 XML 结构。', '请导出不含外部实体或特殊声明的副本。'],
  BUSY: ['文件读取队列已满。', '请稍后重试。'],
  ABORTED: ['本次文件读取已取消。', '需要时可重新读取。'],
  TIMEOUT: ['文件读取超过时间上限。', '请缩小或拆分文档后重试。'],
  CLOSED: ['文件读取服务已关闭。', '请稍后重新发送文件。'],
  PARSE_FAILED: ['文件暂时无法读取。', '请重新导出文件后重试。']
})

export class FileTextError extends Error {
  constructor (code) {
    const known = Object.hasOwn(messages, code) ? code : 'PARSE_FAILED'
    super(known)
    this.name = 'FileTextError'
    this.code = known
  }
}

export function fail (code) { throw new FileTextError(code) }
export function isFileTextError (error) { return error instanceof FileTextError }
export function failure (code) {
  const known = Object.hasOwn(messages, code) ? code : 'PARSE_FAILED'
  return { ok: false, code: known, reason: messages[known][0], hint: messages[known][1] }
}

export function textPrefix (value, maxLength) {
  let end = Math.max(0, Math.min(value.length, maxLength))
  if (end > 0 && end < value.length) {
    const last = value.charCodeAt(end - 1)
    const next = value.charCodeAt(end)
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
  }
  return value.slice(0, end)
}
