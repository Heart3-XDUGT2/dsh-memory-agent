#!/usr/bin/env node
/**
 * dsh-echo — 向量臂依赖安装器（Step A）
 * ============================================================
 * 用法:
 *   node scripts/embed-setup.mjs            # 装:建 venv + 装依赖 + 下模型
 *   node scripts/embed-setup.mjs --check    # 只读:报告装没装、缺什么(不改任何东西)
 *   node scripts/embed-setup.mjs --doctor   # 诊断:逐项说清"为什么缺/缺了会怎样"
 *   node scripts/embed-setup.mjs --remove   # 卸:删 venv + 删模型(完整回滚)
 *   node scripts/embed-setup.mjs --help
 *
 * ---- 为什么是"独立 venv + 独立目录"，而不是装进系统 python ----
 * 1. **回滚要干净**:`--remove` 删两个目录就回到零依赖状态,系统 python 一个字节没动。
 *    装进系统 python 的话,"卸载"要精确列出当初装了什么、还不能误删别人的包。
 * 2. **零依赖纪律不破**:系统 python 仍然零第三方依赖;这个 venv 是**可选件** ——
 *    没装它,插件照常跑(向量臂自动不可用),与今天完全一样。
 * 3. **隔离**:宿主/别的插件升级 python 或包,不会连带把向量臂弄坏,反之亦然。
 *
 * ---- 依赖清单为什么是这三个 ----
 * 实测(2026-10-12,Windows + cp314 非自由线程):
 *   onnxruntime  ✅ cp314-cp314-win_amd64 轮子(1.26.0 ~ 1.31.0)
 *   numpy        ✅ cp314-cp314-win_amd64 轮子(2.5.0 ~ 2.5.4)
 *   tokenizers   ✅ **cp310-abi3**-win_amd64 轮子 —— abi3 向前兼容,cp314 装得上
 *                   (本机 .venv314 里 tokenizers 0.23.2 正跑在 3.14.7 上,是活证)
 *   transformers ❌ 不需要(纯 Python,而且只为拿分词器的话 tokenizers 直接够)
 *   onnx         ❌ 不需要(模型用现成的 ONNX,不自己导出)
 * ⇒ 目标依赖 = **onnxruntime + numpy + tokenizers**(三个都钉版本)。
 *
 * ⚠️ 一条教训:第一轮我把判据写成"有没有精确的 `cp314-cp314-win_amd64`",
 * 于是把 tokenizers 判成"装不上",还准备手写 WordPiece。**abi3 轮子被漏掉了** ——
 * 判"能不能装"时,ABI 标签要看全(精确标签 **和** abi3),不能只认最严的那个。
 *
 * ---- 模型为什么用 Xenova 的仓 ----
 * `BAAI/bge-small-zh-v1.5` 官方仓**没有 ONNX**(实测 `onnx/*` 全 404,只有 safetensors)。
 * `Xenova/bge-small-zh-v1.5` 有现成的 ONNX,而且**不用拖 torch 去导出**:
 *   onnx/model.onnx            94,851,877 B(90.5 MB,fp32 ← 默认)
 *   onnx/model_quantized.onnx  24,010,842 B(22.9 MB,int8)
 *   onnx/model_fp16.onnx       47,497,427 B(47.5 MB)
 * 池化照 **BAAI 原仓**的 `1_Pooling/config.json`:`pooling_mode_cls_token: true`
 * (Xenova 仓没有 1_Pooling,所以那条权威来自 BAAI 原仓)。
 */
import { spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveDataDir } from '../lib/data-dir.js'
import { detectPython } from '../lib/sidecar-client.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

/** 依赖钉版本:不钉的话"下次装出来的东西不一样",回滚与复现都无从谈起。 */
export const DEPS = Object.freeze(['onnxruntime==1.31.0', 'numpy==2.5.4', 'tokenizers==0.23.3'])

/** 模型来源与要拉的文件(路径 = 仓内路径,也是本地落盘的相对路径)。 */
export const MODEL_REPO = 'Xenova/bge-small-zh-v1.5'
export const MODEL_FILES = Object.freeze([
  { repo: 'onnx/model.onnx', local: 'model.onnx', bytes: 94851877, required: true },
  { repo: 'tokenizer.json', local: 'tokenizer.json', bytes: 439125, required: true },
  { repo: 'vocab.txt', local: 'vocab.txt', bytes: 109540, required: false },
  { repo: 'tokenizer_config.json', local: 'tokenizer_config.json', bytes: 190, required: false },
  { repo: 'config.json', local: 'config.json', bytes: 716, required: false },
])
/** 镜像:直连 huggingface.co 在本机超时(实测),hf-mirror 可达。 */
export const DEFAULT_ENDPOINT = 'https://hf-mirror.com'

export function pathsOf (env = process.env) {
  const dataDir = resolveDataDir(env)
  return {
    dataDir,
    venv: join(dataDir, 'venv'),
    venvPython: join(dataDir, 'venv', 'Scripts', 'python.exe'),
    modelDir: join(dataDir, 'models', 'bge-small-zh-v1.5'),
  }
}

/** 只读体检:每一项都报"在不在 + 大小",不改任何东西。 */
export function statusOf (env = process.env) {
  const p = pathsOf(env)
  const model = {}
  for (const f of MODEL_FILES) {
    const full = join(p.modelDir, f.local)
    let ok = false
    let bytes = 0
    try {
      const st = statSync(full)
      ok = st.isFile() && st.size > 0
      bytes = st.size
    } catch { /* 不存在 */ }
    model[f.local] = { ok, bytes, expected: f.bytes, required: f.required }
  }
  return {
    ...p,
    venvExists: existsSync(p.venvPython),
    modelDirExists: existsSync(p.modelDir),
    model,
  }
}

function run (cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  return r.status === 0
}

async function download (url, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  const res = await fetch(url, { headers: { 'User-Agent': 'dsh-echo/embed-setup' } })
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

// ---------------------------------------------------------------- 子命令

async function cmdInstall (env) {
  const p = pathsOf(env)
  const endpoint = (env.ECHO_HF_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '')
  console.log('[1/4] 找 python …')
  const py = await detectPython({ env })
  if (py === null) {
    console.error('  找不到可用的 python(≥3.9)。设 ECHO_PYTHON 或面板 pythonPath 后再来。')
    return 2
  }
  console.log('  ' + py.path + '  (3.' + py.minor + ')')

  console.log('[2/4] 建 venv: ' + p.venv)
  if (existsSync(p.venvPython)) {
    console.log('  已存在,跳过建(要重建就先 --remove)')
  } else if (!run(py.path, ['-m', 'venv', p.venv])) {
    console.error('  建 venv 失败')
    return 3
  }

  console.log('[3/4] 装依赖: ' + DEPS.join(' '))
  if (!run(p.venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', ...DEPS])) {
    console.error('  装依赖失败 —— venv 已建但依赖不全;重跑本命令可续,或 --remove 全清。')
    return 4
  }

  console.log('[4/4] 下模型 → ' + p.modelDir)
  for (const f of MODEL_FILES) {
    const dest = join(p.modelDir, f.local)
    if (existsSync(dest) && statSync(dest).size > 0) {
      console.log('  ' + f.local + ' 已存在,跳过')
      continue
    }
    const url = endpoint + '/' + MODEL_REPO + '/resolve/main/' + f.repo
    try {
      await download(url, dest)
      console.log('  ' + f.local + '  ' + statSync(dest).size + ' B')
    } catch (err) {
      const msg = '  ' + f.local + ' 下载失败: ' + String(err?.message ?? err)
      if (f.required) {
        console.error(msg)
        console.error('  必需文件缺失 ⇒ 向量臂不可用(插件其余部分照常)。')
        return 5
      }
      console.warn(msg + '  (可选文件,继续)')
    }
  }

  console.log()
  console.log('装好了。回滚方式: node scripts/embed-setup.mjs --remove')
  console.log('⚠️ 本命令**没有**接任何检索路径 —— 向量臂仍未启用。')
  return 0
}

function cmdRemove (env) {
  const p = pathsOf(env)
  let n = 0
  for (const [label, dir] of [['venv', p.venv], ['模型', p.modelDir]]) {
    if (!existsSync(dir)) {
      console.log('  ' + label + ' 本来就不存在: ' + dir)
      continue
    }
    // 只删我们自己建的那两个目录,不做任何通配
    rmSync(dir, { recursive: true, force: true })
    console.log('  已删 ' + label + ': ' + dir)
    n++
  }
  console.log('  删了 ' + n + ' 个目录 —— 回到零依赖状态。系统 python 未被动过。')
  return 0
}

function cmdCheck (env, doctor) {
  const s = statusOf(env)
  console.log('数据目录: ' + s.dataDir)
  console.log('venv    : ' + (s.venvExists ? '在' : '**不在**') + '  ' + s.venv)
  console.log('模型目录: ' + (s.modelDirExists ? '在' : '**不在**') + '  ' + s.modelDir)
  for (const [name, m] of Object.entries(s.model)) {
    const tag = m.ok ? '在' : (m.required ? '**缺(必需)**' : '缺(可选)')
    console.log('  ' + name.padEnd(24) + tag + (m.ok ? '  ' + m.bytes + ' B' : ''))
  }
  const missing = Object.entries(s.model).filter(([, m]) => m.required && !m.ok).map(([k]) => k)
  const ready = s.venvExists && missing.length === 0
  console.log()
  console.log(ready ? '结论: 依赖齐备(但**未接检索路径**)' : '结论: 还不齐 —— 跑 node scripts/embed-setup.mjs 装')
  if (doctor) {
    console.log()
    console.log('诊断:')
    console.log('  · venv 不在 ⇒ 向量臂不可用;插件其余部分照常(自动降级,不报错)')
    console.log('  · 必需模型文件缺 ⇒ 同上;可选文件缺只影响元信息')
    console.log('  · 直连 huggingface.co 在本机**超时**(实测),所以默认走 hf-mirror')
    console.log('  · 想换镜像: 设 ECHO_HF_ENDPOINT,再重跑装')
    console.log('  · 卸载: node scripts/embed-setup.mjs --remove(只删上面那两个目录)')
  }
  return ready ? 0 : 1
}

function usage () {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim())
}

const argv = process.argv.slice(2)
const env = process.env
const has = (f) => argv.includes(f)

if (has('--help') || has('-h')) { usage(); process.exit(0) }

let code = 0
if (has('--remove')) code = cmdRemove(env)
else if (has('--check')) code = cmdCheck(env, false)
else if (has('--doctor')) code = cmdCheck(env, true)
else code = await cmdInstall(env)
process.exit(code)
