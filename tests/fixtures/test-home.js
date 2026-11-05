/**
 * 测试专用的 `DSH_HOME` 隔离(2026-09-30 修「测试读真机配置」)。
 *
 * 为什么值得单开一个件:真机 `~/.dsh/echo/config.json` 里
 * `settings.proactiveScoring.enabled` 是**活的**(用户 2026-09-30 批准开闸收数据)。
 * 而 `lib/heartbeat.js` 的两处配置在**壳没注入 getter** 时会回落到 `readSettings()`
 * (纯 fs,不是宿主包)—— 于是"没注入 getter"的用例会读**真机配置**:打分器一开,
 * 本来该判 `sent` 的一拍被判成 `no-topic`,heartbeat / care-beats 一次红 20 条
 * (与 P4a 无关,HEAD `fbbd486` 纯净 worktree 失败集逐条相同)。
 *
 * 修法(两层,都在这两个件里):
 *   ① **隔离地板**:受影响的用例在建 heartbeat **之前**把 `DSH_HOME` 指到临时目录,
 *      之后**动态** import 库模块 —— 用例从此读不到真机配置,拿到的是出厂默认值;
 *   ② **显式意图**:受影响的 heartbeat 构造器默认**显式**注入 `getProactiveScoring`
 *      (打分器关着),不靠 ① 之外的那条回落。
 *
 * ⚠️ 顺序是硬约束:`lib/toggle.js` 的 `CONFIG_PATH` 与 `lib/persona.js` 的 `DATA_DIR`
 * 都是**模块级常量**,首次 import 时按当时的 `DSH_HOME` 定死。静态 `import` 先于
 * 本文件的调用执行 —— 谁要是把 `../lib/toggle.js` 挪回文件顶部的静态 import,
 * CONFIG_PATH 就又指向真机了(toggle.test.js 顶部那段疤,2026-09-26 真踩过)。
 * 所以配套一个 `assertHomeIsolated()`:**当场红整片**,绝不静默读真机配置。
 *
 * `ECHO_TEST_DSH_HOME`(只读这个环境变量,生产代码不读它):指到一个**预先种好
 * `config.json`** 的临时目录 —— 专门用来实跑「真机配置 enabled=true / false」
 * 两种情形,验证隔离真的成立(种子在临时目录里,一个字节都不写回真 config)。
 * 不设它 = 每次现造一个空临时目录(无 config.json ⇒ 出厂默认)。
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 把 `DSH_HOME` 指到临时目录(空目录或 `ECHO_TEST_DSH_HOME` 指的种子目录),返回它。
 * ⚠️ 必须在**动态** import 任何库模块**之前**调用。
 */
export function isolateTestHome () {
  const forced = String(process.env.ECHO_TEST_DSH_HOME ?? '').trim()
  const home = forced || mkdtempSync(join(tmpdir(), 'echo-test-home-'))
  // config.json 的父目录要存在(读它的人只 existsSync,不建目录)
  mkdirSync(join(home, 'echo'), { recursive: true })
  process.env.DSH_HOME = home
  return home
}

/**
 * 隔离自检:`CONFIG_PATH` 必须落在隔离后的 `DSH_HOME` 里。
 *
 * 静默的假绿比红着更糟 —— 顺序一破,用例会悄悄开始读真机配置(而且真机上
 * enabled=true 时它**不一定红**,只是判据漂了)。所以这里错了就炸整片。
 */
export function assertHomeIsolated (configPath) {
  const home = String(process.env.DSH_HOME ?? '')
  if (home === '' || typeof configPath !== 'string' || !configPath.startsWith(home)) {
    throw new Error(
      '测试的 CONFIG_PATH 没落在隔离的 DSH_HOME 里 —— 它会读真机配置:' + configPath
      + '\n  DSH_HOME=' + (home === '' ? '(空)' : home)
      + '\n  多半是库模块被**静态** import 了(静态导入先于 isolateTestHome() 执行)。'
    )
  }
}
