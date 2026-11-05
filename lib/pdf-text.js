import { fail, isFileTextError, textPrefix } from './file-text-errors.js'

// Text extraction never fetches font/CMap/wasm resources or opens their paths.
// Explicit factories also fence the library's main-thread resource fallbacks;
// useWorkerFetch:false by itself is not a general network prohibition.
class NoExternalResourceFactory {
  async fetch () { throw new Error('PDF_EXTERNAL_RESOURCE_DISABLED') }
}

function documentOptions (data) {
  return {
    data,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    cMapUrl: undefined,
    standardFontDataUrl: undefined,
    wasmUrl: undefined,
    CMapReaderFactory: NoExternalResourceFactory,
    StandardFontDataFactory: NoExternalResourceFactory,
    WasmFactory: NoExternalResourceFactory,
    maxImageSize: 0,
    stopAtErrors: true,
    verbosity: 0
  }
}

/** Extract sequential, bounded plain text from memory bytes only. */
export async function extractPdf (data, limits) {
  if (!(data instanceof Uint8Array)) fail('INVALID_INPUT')
  if (data.byteLength > limits.maxInputBytes) fail('FILE_TOO_LARGE')
  // Never transfer/detach a caller-owned or pooled backing buffer.
  const bytes = Uint8Array.from(data)
  let pdfjs
  try {
    // This module remains safe to import during the host's ordinary smoke
    // scan, before optional extraction dependencies are available.
    const { getResolvedPDFJS } = await import('unpdf')
    pdfjs = await getResolvedPDFJS()
  } catch {
    fail('PARSE_FAILED')
  }

  let loadingTask
  let document
  try {
    // Keep the loading task even when document admission rejects (e.g. a
    // password). The convenience proxy helper otherwise hides that handle.
    loadingTask = pdfjs.getDocument(documentOptions(bytes))
    document = await loadingTask.promise
    const pages = document.numPages
    if (!Number.isSafeInteger(pages) || pages < 1) fail('PDF_INVALID')
    if (pages > limits.maxPdfPages) fail('PDF_PAGE_LIMIT')

    let text = ''
    let pagesRead = 0
    let truncated = false
    let emptyPages = false
    for (let number = 1; number <= pages; number++) {
      let page
      let reader
      let completed = false
      let hasPageText = false
      let hasVisibleText = false
      let pendingLineBreak = false
      try {
        page = await document.getPage(number)
        reader = page.streamTextContent({
          includeMarkedContent: false,
          disableNormalization: false
        }).getReader()
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) {
            completed = true
            break
          }
          if (!Array.isArray(chunk.value?.items)) fail('PDF_INVALID')
          // unpdf 1.4's inlined worker can close a cancelled text controller a
          // second time. Finish draining this page without retaining its text
          // instead; the owning temporary worker still supplies the hard time
          // limit, and no subsequent page is requested after truncation.
          if (truncated) continue
          for (const item of chunk.value.items) {
            if (typeof item?.str !== 'string') continue
            const value = item.str.toWellFormed()
            if (value.length > 0) {
              hasVisibleText ||= value.trim().length > 0
              // Defer EOL until another actual text item: a terminal EOL is
              // not a partial page when the page body exactly fits the cap.
              const prefix = hasPageText
                ? (pendingLineBreak ? '\n' : '')
                : (text.length > 0 ? '\n\n' : '')
              const piece = prefix + value
              const remaining = Math.max(0, limits.maxTextChars - text.length)
              let retained = textPrefix(piece, remaining)
              if (retained.length < piece.length) {
                // Avoid a trailing fragment consisting only of a page/EOL
                // separator when no character of this item can be kept.
                if (retained.length <= prefix.length) retained = ''
                text += retained
                truncated = true
                break
              }
              text += retained
              hasPageText = true
              pendingLineBreak = false
            }
            if (item.hasEOL === true) pendingLineBreak = true
          }
        }
      } finally {
        if (reader) {
          if (!completed) {
            try { await reader.cancel() } catch {}
          }
          try { reader.releaseLock() } catch {}
        }
        try { page?.cleanup() } catch {}
      }
      if (truncated || !completed) break
      pagesRead++
      if (!hasVisibleText) emptyPages = true
    }

    if (!truncated && text.trim() === '') fail('NO_EXTRACTABLE_TEXT')
    const warnings = []
    if (emptyPages) warnings.push('PDF_EMPTY_PAGES')
    if (truncated) warnings.push('PDF_TEXT_TRUNCATED')
    return { text, truncated, warnings, pages, pagesRead }
  } catch (error) {
    if (isFileTextError(error)) throw error
    if (error?.name === 'PasswordException') fail('PDF_ENCRYPTED')
    fail('PDF_INVALID')
  } finally {
    try { await document?.cleanup() } catch {}
    try { await loadingTask?.destroy() } catch {}
  }
}
