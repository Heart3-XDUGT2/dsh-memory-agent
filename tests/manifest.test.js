/**
 * v0.18.4 — 装机契约的防回归闸(2026-09-26 现场)。
 *
 * 那次 DSH **整个起不来**,根因不是插件逻辑,而是包元数据 / 装机方式:
 *   ① 装机器只登记 `dsh.profile.bundles`、不登记 dependency ⇒
 *      他 wipe node_modules + `dsh plugin install` 之后文件没了、登记还在
 *      ⇒ loader 抛 `cannot resolve profile bundle "dsh-echo"` ⇒ dsh web 起不来。
 *   ② `files:` 里漏了 `web/` ⇒ 走 npm pack / pnpm 装出来的副本没有审查台,
 *      `/echo/` 直接 404(复制装机时看不出来,因为脚本是显式拷 web/ 的)。
 *   ③ npm 上有个同名的 `dsh-echo@0.0.1` 占位包;`dsh plugin add dsh-echo`
 *      (裸名)装的是它 —— 它当然没有 `dsh.bundle`,于是 CLI 警告
 *      「declares no dsh.bundle」。**别用裸名装本插件。**
 *
 * 这四条都属于"包元数据写错就拦住宿主启动"的类别,代码测试照不到,所以单独
 * 钉在这里:读真实的 package.json / cordis.patch.yml / lib/client.js 断言。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

test('装机契约:dsh.bundle.patch 声明了,而且文件真在', () => {
  const rel = pkg.dsh?.bundle?.patch
  // 两代形态(2026-10-02 实测):0.1.5 的 loader 只吃**字符串**(数组当场炸 path.join);
  // 0.2.0 才收一串。生成器按世代自摆形态(scripts/install-preset.mjs),「这一代该是
  // 哪种形态」由 scripts/check-preset-patch.mjs 的世代门钉 —— 这里只钉两代共同的
  // 契约:声明了 + 点名的每个文件都真在。
  const list = typeof rel === 'string' ? [rel] : (Array.isArray(rel) ? rel : null)
  assert.ok(list !== null && list.length > 0 && list.every((f) => typeof f === 'string'),
    'profile loader 找不到 dsh.bundle.patch 会直接抛 declares no dsh.bundle')
  for (const f of list) {
    assert.ok(existsSync(new URL(f.replace(/^\.\//, ''), root)), f + ' 不存在')
  }
})

test('装机契约:bundle patch 的 loader entry 用的是**包名**', () => {
  const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8')
  assert.ok(patch.includes('name: ' + pkg.name),
    'entry 名必须是包名(作用域包也要带 scope)—— 社区插件真踩过:用了不带 scope 的短名,'
    + 'loader 抛 failed to import loader entry')
})

test('装机契约:客户端 bundle 注册的 id === 包名', () => {
  const rel = pkg.exports?.['./client']
  assert.equal(typeof rel, 'string', 'exports["./client"] 缺席 ⇒ 宿主不知道客户端模块在哪')
  const client = readFileSync(new URL(rel.replace(/^\.\//, ''), root), 'utf8')
  assert.ok(client.includes('__ModuleLoader__.load'),
    '客户端模块必须走 window.__ModuleLoader__.load')
  // 宿主按图里的行 id(= 包名)找工厂:id 不一致就抛
  // `bundle ... loaded without registering "<包名>" via __ModuleLoader__.load`
  assert.ok(client.includes('id: "' + pkg.name + '"') || client.includes('"id": "' + pkg.name + '"'),
    'client.js 注册的 id 必须与包名逐字一致')
})

test('装机契约:files 要装全(web/ 是审查台,漏了 /echo/ 就 404)', () => {
  const files = pkg.files ?? []
  // v0.42.0:运行时真正要的只有 worker.py + engine/ —— 原来写的是整目录 `python/`,
  // 那会把 `python/tests`(12 个测试文件 + 假数据)一起打进 tgz。改成精确条目,
  // 并**钉住"测试不许进包"**,否则随手改回整目录没人拦。
  for (const needed of ['lib/', 'web/', 'python/worker.py', 'python/engine/', 'cordis.patch.yml']) {
    assert.ok(files.includes(needed), 'files 里缺 ' + needed)
  }
  assert.ok(!files.includes('python/'), 'files 用整目录 python/ 会把 python/tests 一起打包')
  assert.ok(!files.some((f) => f.startsWith('python/tests')), 'python/tests 不许进包')
})

test('装机契约:运行时 @deepseek-ai/* 由宿主提供,不写进 dependencies', () => {
  const deps = Object.keys(pkg.dependencies ?? {})
  const host = deps.filter((d) => d.startsWith('@deepseek-ai/'))
  assert.deepEqual(host, [],
    '写成 dependencies 会让 profile 的 pnpm install 去 npm 找 —— 那边只有 0.0.1-rc.1 这种版本,'
    + '声明的任何真实版本都装不上,整包安装失败(afaccess 同样一个都不声明)')
})

test('装机契约:装机器同时登记 bundles 与 dependency(缺后者会被 pnpm 清成悬空)', () => {
  const src = readFileSync(new URL('scripts/install.mjs', root), 'utf8')
  assert.ok(src.includes('dsh.profile.bundles'), '要登记 bundle 层')
  assert.ok(src.includes('dependencies[sourcePackage.name]'),
    '也要登记 dependency(指向本地 tgz),否则 wipe node_modules 后 dsh web 起不来')
  assert.ok(src.includes('npm'), '分发包靠 npm pack 生成')
  assert.ok(src.includes('--doctor'), '--doctor 要能把"登记在、文件没了"这种拦截启动的状态报出来')
})
