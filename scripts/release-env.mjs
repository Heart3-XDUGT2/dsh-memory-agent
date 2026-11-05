import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
export function releaseEnvironment(label, external = process.env) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-release-' + label + '-'))
  const home = path.join(folder, 'synthetic-home')
  fs.mkdirSync(home)
  const userConfig = path.join(folder, 'empty-user.npmrc'), globalConfig = path.join(folder, 'empty-global.npmrc')
  fs.writeFileSync(userConfig, ''); fs.writeFileSync(globalConfig, '')
  const removed = new Set(['node_options', 'node_path', 'dsh_home', 'dsh_data_dir', 'dsh_tools_path',
    'dsh_web_app', 'dsh_agent_presets', 'temp', 'tmp', 'tmpdir',
    'pythonioencoding', 'pythonutf8',
    'home', 'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata',
    'xdg_config_home', 'xdg_data_home', 'xdg_cache_home',
    'npm_token', 'node_auth_token', 'openai_api_key', 'deepseek_api_key', 'anthropic_api_key'])
  // Windows treats environment keys without case; remove aliases before adding
  // sandbox values so Node cannot choose an inherited uppercase configuration.
  const env = Object.fromEntries(Object.entries(external).filter(([key]) => {
    const lower = key.toLowerCase()
    return !lower.startsWith('npm_config_') && !lower.startsWith('echo_') && !removed.has(lower)
  }))
  const drive = path.parse(home).root.replace(/[\\/]+$/u, '')
  Object.assign(env, { DSH_HOME: home, DSH_DATA_DIR: home,
    HOME: home, USERPROFILE: home, HOMEDRIVE: drive, HOMEPATH: drive ? home.slice(drive.length) : home,
    APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'local-appdata'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    TEMP: folder, TMP: folder, TMPDIR: folder, PYTHONDONTWRITEBYTECODE: '1',
    PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
    npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
    npm_config_cache: path.join(folder, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_update_notifier: 'false', npm_config_registry: 'https://registry.npmjs.org/' })
  for (const key of ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) {
    fs.mkdirSync(env[key], { recursive: true })
  }
  return { folder, home, env }
}
