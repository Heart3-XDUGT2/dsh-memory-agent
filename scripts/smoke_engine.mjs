/**
 * M2-d 真实数据冒烟:活库副本上走引擎门面,预演她将收到的注入信。
 * 用法:node scripts/smoke_engine.mjs(仓库根运行)
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupLiveDb } from './smoke_lib.mjs'

const { createEngine } = await import('../lib/engine.js')
const { openStore } = await import('../lib/store.js')
const { detectPython } = await import('../lib/sidecar-client.js')

const dir = mkdtempSync(join(tmpdir(), 'echo-smoke-engine-'))
let engine = null
let store = null
try {
  const dbPath = await backupLiveDb(join(dir, 'echo.db'))
  store = openStore(dbPath)
  engine = createEngine({ store, dbPath, detect: detectPython })
  const mode = await engine.init()
  console.log('== 引擎模式:', mode, '==')
  if (mode !== 'python') throw new Error('本机应探到 Python')

  for (const q of ['西电的校园跑要求是什么', '还记得面试的事吗']) {
    const r = await engine.retrieve(q)
    console.log('\n== 查询:「' + q + '」 via ' + r.engine + ' ==')
    console.log(r.text)
  }
  console.log('\n== 想念真值(M2-f,读即刷新)==')
  const lg = await engine.longing('master')
  console.log(lg === null ? '(引擎不在,null → 面板回落 JS 复刻)' : JSON.stringify(lg, null, 2))

  console.log('\n== 心跳帧链(M3-a:脉冲→路由→选题→提醒池)==')
  // ① 模拟你在会话 smoke-sess 里说了一句话(脉冲削减+会话路由刷新)
  // v0.6.0 先读后削:帧带回削减前后双值(pre = 她等你时的想念)
  const lmsg = await engine.longingMessage('master', '在吗,最近在赶一个答辩项目', 'smoke-sess')
  console.log('先读后削:', lmsg === null ? '(null)' :
    'pre=' + (lmsg.pre ? lmsg.pre.value : '?') + ' post=' + (lmsg.post ? lmsg.post.value : '?'))
  const lg2 = await engine.longing('master')
  console.log('sessionId 路由回读:', lg2 === null ? '(null)' : lg2.sessionId)
  if (lg2 !== null && lg2.sessionId !== 'smoke-sess') throw new Error('sessionId 未随帧往返')
  // ② 她的议程簿选题(效用 top-1,纯读不落账)
  const agendaItem = await engine.agendaPick('master')
  console.log('议程选题:', agendaItem === null ? '(null)' : JSON.stringify(agendaItem))
  // ③ 提醒池(纯读不落账 —— 发送成功才 mark)
  const remind = await engine.threadsRemindable()
  console.log('提醒池:', remind === null ? '(null)' : JSON.stringify(remind.items))
  // ④ 补差 tick(幂等,60s 粒度)
  await engine.longingTick()
  console.log('tick: ok')

  console.log('\n== 引擎状态 ==')
  console.log(JSON.stringify(engine.state(), null, 2))
} finally {
  if (engine !== null) await engine.stop().catch(() => { })
  try { store?.close() } catch { }
  rmSync(dir, { recursive: true, force: true })
}
