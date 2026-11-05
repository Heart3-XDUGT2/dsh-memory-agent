/**
 * 真加载冒烟 —— 把插件**真的 apply 一遍**,专抓"只有真加载才炸"的那类错。
 *
 * 为什么非要它(2026-09-28 夜,他一句「重启报错了」):
 *   `Cannot access 'retrievalLedger' before initialization`(TDZ)——
 *   我在同一个函数里把 `ledger:` 传给 `createEngine(...)`,而 `const retrievalLedger`
 *   声明在后面。`node --check` 说"语法没问题",868 条单测全绿,**插件却在宿主里
 *   加载即炸,整个 dsh web 起不来**。
 *   教训:`node --check` 只看得懂语法;**"先声明后使用"是运行期的事,必须在真加载里撞。**
 *
 * 本脚本不连宿主、不碰库、不发消息:用一个**全许可的替身 ctx**(任何属性都能拿到、
 * 任何调用都返回替身、能 await)把 `apply()` 跑一遍,只关心**有没有抛**。
 * 判断标准:抛出的错里若含 `before initialization` / `is not defined` / `is not a function`
 * 之类 ⇒ 这就是加载期缺陷,直接红着退出。
 */
// ⚠️ Windows 上别用 pathToFileURL(url.pathname):那会拼出 `file:///C:/C:/…`(实测撞过)。
// 直接用 URL 的 href,交给 Node 自己解析。
const URL_INDEX = new URL('../lib/index.js', import.meta.url)

/** 全许可替身:任何属性都拿得到,任何调用都返回它自己,且能被 await。 */
function stub (label = 'ctx') {
  const fn = function () { return proxy }
  const proxy = new Proxy(fn, {
    get (_t, key) {
      if (key === 'then') return undefined // 别被当成 thenable
      if (key === 'toString') return () => '[' + label + ']'
      if (key === Symbol.toPrimitive) return () => '[' + label + ']'
      return stub(label + '.' + String(key))
    },
    apply () { return proxy },
    construct () { return proxy },
    has () { return true }
  })
  return proxy
}

const mod = await import(URL_INDEX.href)
if (typeof mod.apply !== 'function') {
  console.error('[加载冒烟] lib/index.js 没有导出 apply —— 插件形状不对')
  process.exit(1)
}

try {
  const r = mod.apply(stub(), (mod.default && mod.default.config) || {})
  if (r && typeof r.then === 'function') await r
  console.log('[加载冒烟] 插件 apply() 跑通(替身 ctx)—— 加载期没有炸')
  process.exit(0)  // apply 会起定时器,不主动退出门会一直挂着(实测卡过 300s)
} catch (err) {
  const msg = String((err && err.message) || err)
  console.error('[加载冒烟] apply() 抛了:' + msg)
  if (err && err.stack) console.error(String(err.stack).split('\n').slice(0, 4).join('\n'))
  process.exit(1)
}
