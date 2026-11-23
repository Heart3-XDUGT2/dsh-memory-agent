// Build the three-file static preview without adding a runtime dependency.
// node vendor/jiulin/build.mjs [path-to-an-existing-esbuild-package]
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(import.meta.url)
const { build } = require(process.argv[2] || 'esbuild')
const assets = await Promise.all(['three.min.js', 'OrbitControls.js', 'NOTICE.txt', 'THREE-LICENSE.txt']
  .map(name => readFile(new URL(name, import.meta.url), 'utf8')))
const [three, controls, notice, license] = assets
await build({
  absWorkingDir: root, entryPoints: ['memory-star-page.js'], outfile: 'memory-star-experience.js',
  bundle: true, format: 'iife', platform: 'browser', target: 'es2020', charset: 'utf8',
  banner: { js: `/*! ${notice}\n${license} */\n${three}\n${controls}\n;` }
})
