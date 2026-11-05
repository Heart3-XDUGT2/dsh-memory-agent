import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { releaseEnvironment } from '../scripts/release-env.mjs'

test('release environment discards mixed-case external npm, Node and data aliases', () => {
  const external = {
    PATH: 'synthetic-path', SystemRoot: 'synthetic-system',
    NPM_CONFIG_USERCONFIG: 'synthetic-private-userconfig',
    Npm_Config_GlobalConfig: 'synthetic-private-globalconfig',
    npm_CONFIG_cache: 'synthetic-private-cache', NPM_CONFIG_REGISTRY: 'https://synthetic.invalid',
    node_options: '--import=synthetic', Node_Path: 'synthetic-modules',
    dsh_home: 'synthetic-home', Echo_Data_Dir: 'synthetic-data',
    ECHO_DB: 'synthetic-db', Echo_Test_Real_Dsh_Home: 'synthetic-real',
    Node_Auth_Token: 'synthetic-token', OPENAI_API_KEY: 'synthetic-key',
    home: 'synthetic-private-home', UserProfile: 'synthetic-private-profile',
    HomeDrive: 'synthetic-private-drive', homepath: 'synthetic-private-homepath',
    AppData: 'synthetic-private-appdata', LOCALAPPDATA: 'synthetic-private-localdata',
    xdg_CONFIG_home: 'synthetic-private-config', Xdg_Data_Home: 'synthetic-private-data',
    XDG_CACHE_HOME: 'synthetic-private-cache-home',
    TMP: 'synthetic-temp', Temp: 'synthetic-temp-alias'
  }
  const originalExternal = { ...external }
  const { folder, home, env } = releaseEnvironment('env-negative-control', external)
  const grouped = new Map()
  for (const key of Object.keys(env)) {
    const lower = key.toLowerCase()
    assert.equal(grouped.has(lower), false, 'case-insensitive duplicate key')
    grouped.set(lower, key)
  }
  for (const value of Object.values(env)) assert.equal(String(value).startsWith('synthetic-private-'), false)
  for (const key of ['node_options', 'node_path', 'echo_data_dir', 'echo_db', 'echo_test_real_dsh_home',
    'node_auth_token', 'openai_api_key']) assert.equal(grouped.has(key), false)
  assert.equal(env.DSH_HOME, home); assert.equal(env.TEMP, folder)
  assert.notEqual(env.npm_config_userconfig, env.npm_config_globalconfig)
  for (const key of ['npm_config_userconfig', 'npm_config_globalconfig']) {
    assert.ok(path.resolve(env[key]).startsWith(path.resolve(folder) + path.sep))
    assert.equal(fs.readFileSync(env[key], 'utf8'), '')
  }
  assert.equal(env.npm_config_registry, 'https://registry.npmjs.org/')
  assert.equal(env.PATH, external.PATH)
  assert.equal(env.HOME, home)
  assert.equal(env.USERPROFILE, home)
  assert.equal(path.resolve(env.HOMEDRIVE + env.HOMEPATH), path.resolve(home))
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
    assert.ok(path.resolve(env[key]).startsWith(path.resolve(home) + path.sep))
    assert.equal(fs.statSync(env[key]).isDirectory(), true)
  }
  assert.deepEqual(external, originalExternal, 'parent environment mapping changed')
})

test('release environment replaces ASCII Python aliases before Chinese subprocess output', () => {
  const allowed = new Set(['systemroot', 'windir', 'path', 'pathext', 'comspec', 'lang', 'lc_all', 'tz', 'systemdrive'])
  const external = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())))
  Object.assign(external, {
    PYTHONIOENCODING: 'ascii', PyThOnIoEnCoDiNg: 'ascii',
    pythonutf8: '0', PyThOnUtF8: '0'
  })
  const before = { ...external }
  const { folder, home, env } = releaseEnvironment('python-utf8-regression', external)
  assert.equal(new Set(Object.keys(env).map(key => key.toLowerCase())).size, Object.keys(env).length)
  assert.equal(env.PYTHONIOENCODING, 'utf-8')
  assert.equal(env.PYTHONUTF8, '1')
  assert.equal(env.HOME, home)
  assert.equal(env.USERPROFILE, home)
  const result = spawnSync('python', ['-S', '-B', '-c',
    "import sys; print('中文编码回归'); print(sys.stdout.encoding); print(sys.flags.utf8_mode)"],
  { cwd: folder, env, encoding: 'utf8', windowsHide: true })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split(/\r?\n/u), ['中文编码回归', 'utf-8', '1'])
  assert.equal(result.stderr, '')
  assert.deepEqual(external, before, 'parent environment mapping changed')
})
