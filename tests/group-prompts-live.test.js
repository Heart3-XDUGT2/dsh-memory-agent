/**
 * ★ 群聊三句提示词「改完不用重启」—— 2026-10-19
 * ==================================================================
 * 他拍的甲方案里有一条硬要求：**改 config 后不重启也能生效**。
 *
 * 这条不是"我觉得应该能"，而是可验证的：
 *   `relay.js` 的 `groupPrompt()` 每次调用都走 `readSettings()`，
 *   而 `readSettings()` **每次现读磁盘**（`toggle.js:1219` 的
 *   `existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(...)) : {}`），
 *   没有模块级缓存。
 *
 * 验证手法：把 `ECHO_DATA_DIR` 指到临时目录（`lib/data-dir.js:102` 认它），
 * **不重启进程、不重新 import**，只改那个 config.json，再看渲染结果变没变。
 *
 * ⚠️ 用独立文件是有意为之：`ECHO_DATA_DIR` 必须在**第一次 import** 之前设好，
 *   所以这里全程用动态 `import()`，且这个文件不 import 别的业务模块。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'echo-gp-'))
process.env.ECHO_DATA_DIR = DIR

/** 写 config.json（settings 段）。 */
function writeCfg (settings) {
  writeFileSync(join(DIR, 'config.json'), JSON.stringify({ settings }, null, 2), 'utf8')
}

/** 一条群聊信封（裸对象即可 —— renderInboundText 只读字段）。 */
const masterEnv = {
  platform: 'qq', chatId: '1', chatType: 'group', senderId: '2',
  senderName: '阿岚', senderId2: '2', isMaster: true, text: '在吗',
  historyDigest: '', msgId: 'm1'
}

test('★ 改 config.json 后**不重启/不重新 import**，渲染立刻跟着变', async () => {
  mkdirSync(DIR, { recursive: true })

  // ── 第一次：空配置 ⇒ 用内置默认
  writeCfg({})
  const { renderInboundText, GROUP_PROMPT_DEFAULTS } = await import('../lib/relay.js')
  const first = renderInboundText(masterEnv)
  assert.ok(first.includes(GROUP_PROMPT_DEFAULTS.masterHint.trim()),
    '空配置该用默认主人提示')

  // ── 第二次：改文件（**同一个进程、同一个模块实例**）⇒ 立刻用新的
  writeCfg({ groupChatPrompts: { masterHint: '这是老王，随便聊' } })
  const second = renderInboundText(masterEnv)
  assert.ok(second.includes('[这是老王，随便聊]'),
    '★ 改完 config 应当立刻生效（live read），实际没变 —— 说明某处缓存了配置')
  assert.equal(second.includes(GROUP_PROMPT_DEFAULTS.masterHint.trim()), false,
    '★ 用了新值就不该再出现旧的默认句')

  // ── 第三次：清空 ⇒ 回默认（证明是"现读"，不是"读一次就记住"）
  writeCfg({ groupChatPrompts: { masterHint: '' } })
  const third = renderInboundText(masterEnv)
  assert.ok(third.includes(GROUP_PROMPT_DEFAULTS.masterHint.trim()),
    '★ 清空后应当回到默认')

  rmSync(DIR, { recursive: true, force: true })
})
