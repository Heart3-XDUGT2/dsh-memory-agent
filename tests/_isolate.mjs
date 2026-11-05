/**
 * dsh-echo — 套件级测试隔离(preload,2026-10-10)
 * ============================================================================
 * 用 `node --test --import ./tests/_isolate.mjs` 挂在**每个测试子进程**的启动点上,
 * 在任何测试文件被求值**之前**把 `DSH_HOME` 指到一个空的临时目录。
 *
 * 为什么值得单开一个件(而不是逐个测试文件加隔离):
 *   在此之前,"测试读真机配置"这件事靠**每个文件自觉** —— `tests/fixtures/test-home.js`
 *   的 `isolateTestHome()` 提供机制,但要不要调、什么时候调(必须在**动态** import
 *   任何库模块之前)全凭作者记得。150 个测试文件里只有 7 个设了隔离;
 *   剩下的 143 个只要**断言恰好碰到**出厂值,就会随真机 `state-defaults.json` /
 *   `config.json` 的内容而绿或红。
 *   现场(2026-10-10):把真机 `state-defaults.json` 的 `emotionVector` 从 null 改成
 *   `{affection: 6, dependency: 5}` 之后,`emotion.test.js` / `store.test.js` /
 *   `drift.test.js` 共 4 条断言当场变红 —— **不是代码坏了,是"测试依赖活文件"显形了**。
 *   这一层把它从"靠自觉"改成"靠兜底"。
 *
 * 为什么用 `DSH_HOME` 而**不是** `ECHO_DATA_DIR`:
 *   `lib/data-dir.js:102-105` 的优先级是 `ECHO_DATA_DIR` > `$DSH_HOME/echo` > `~/.dsh/echo`。
 *   设 `ECHO_DATA_DIR` 会**抢在** `test-home.js` 的隔离之前 ⇒ 那 7 个自己设 `DSH_HOME`
 *   的文件会拿到"CONFIG_PATH 没落在隔离 DSH_HOME 里" ⇒ `assertHomeIsolated()` 按设计
 *   **当场炸整片**(它是 2026-09-30 事故留下的守卫,见该文件头)。
 *   所以这里走**仓库已有的那套机制**(`DSH_HOME`),不引入第二套。
 *
 * 为什么不会盖掉自己设隔离的测试文件:
 *   本件在进程启动时设 env;测试文件在**模块顶层**再设自己的 ⇒ 后者覆盖前者。
 *   而 `lib/data-dir.js:125-129` 的目录冻结发生在**第一次调用** `resolveDataDir()` 时
 *   —— 那时两者都已经跑完 ⇒ **测试文件的值胜出**。实测:`isolateTestHome()` 的文件
 *   拿到自己的临时目录,没调的文件拿到本件的目录。**因此不需要任何显式豁免。**
 *
 * 为什么要存 `ECHO_TEST_REAL_DSH_HOME`:
 *   `scripts/live-config-guard.mjs` 的判据是"整套测试跑完,真实 `$DSH_HOME\echo\config.json`
 *   的 sha256 与 mtime 一个字节都不许变",而且它**主动拒绝在临时目录上工作**
 *   (`:49-56`,那属于"用临时目录糊弄这条守卫")。本件改了 `DSH_HOME` ⇒ 它必须还能
 *   知道**真** home 在哪,否则守卫会被迫拒绝、或在错误的文件上比对。
 *   所以这里把真值存根下来,守卫优先读存根 ⇒ **它盯的还是真路径,判据一个没丢。**
 *   (`looksTemp` 拒绝逻辑原样保留:存根被伪造成临时目录照样会被拒。)
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 存根:只在第一次设(重复 import / 守卫子套件重入时不覆盖已存的真值)。
// 空串是**合法**值,表示"真机用的是 ~/.dsh 默认值"(与 liveConfigPath 的口径一致)。
if (process.env.ECHO_TEST_REAL_DSH_HOME === undefined) {
  process.env.ECHO_TEST_REAL_DSH_HOME = String(process.env.DSH_HOME ?? '').trim()
}

const home = mkdtempSync(join(tmpdir(), 'echo-test-home-'))
// `config.json` 的父目录要存在(读它的人只 existsSync,不建目录 —— 同 test-home.js:40)
mkdirSync(join(home, 'echo'), { recursive: true })
process.env.DSH_HOME = home
