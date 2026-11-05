# Windows安装、升级与排障

本轮基准为Windows、Node24、Python3.14及DSH0.2.0-rc.2公共模块。其他平台和版本不是本轮完成的端到端验证范围。历史预设差异见`COMPAT_DSH_0.2.md`。

源码与数据分开。源码可在普通工作目录，默认装机副本在`<DSH_HOME>/profiles/web/node_modules/dsh-echo`。个人数据默认在`<DSH_HOME>/echo`，可由`ECHO_DATA_DIR`、`ECHO_DB`覆盖。

先按DSH说明初始化Web profile，确认`profiles/web/package.json`存在。退出宿主，在源码目录运行：

```powershell
node scripts/install-preset.mjs
node scripts/install.mjs
node scripts/install.mjs --check
```

安装器使用npm和锁文件安装运行依赖，需要registry网络或完整缓存。运行副本不额外拉取整套DSH，宿主包由profile提供。无需手工junction。已有link形态会被校验而不会自动改成复制；改为复制前先卸载旧登记和链接。

两代预设manifest形态不同。生成器识别实际宿主底稿，必须在复制安装之前运行。开发测试使用有来源和MIT许可的0.2.0-rc.2原样预设夹具，不替代用户宿主检测。

## 升级与回退

退出DSH并备份自己的数据，获取新版本到新源码目录，按发行说明重新生成预设、安装和校验。库代码更新需正常重启宿主，网页刷新不会重新加载服务端JS。不要用仓库覆盖个人数据。

回退前退出宿主，用保留的旧源码或tgz重新安装。数据兼容性以对应发行说明为准，不保证任意跨版本降级可逆。

## 卸载

```powershell
node scripts/install-preset.mjs --remove
node scripts/install.mjs --remove
```

移除可确认为生成器所有的预设、插件副本、bundle/dependency登记和本地分发包。手改预设可能保留。个人数据、备份、导出、宿主日志不随代码卸载删除。

## 排障

| 症状 | 检查 |
|---|---|
| 404 | 使用`/echo/mock/final/index.html`，确认实际origin/端口 |
| 缺包 | 先`--check`，区分运行依赖与profile宿主包，不盲建junction |
| 预设或patch错误 | 对当前宿主重新生成后再复制，0.1.x/0.2.x形态不同 |
| Python不可用 | 检查PATH和`python --version`；基础引擎不要求pip |
| 旧代码仍在运行 | 核装机版本并正常重启宿主 |
| 写入或备份失败 | 先看维护状态、权限与数据位置，不直接删库 |

`--doctor`提供安装诊断。issue仅给错误类型和合成复现，路径用占位符，删除正文、账号、会话、token和图片地址。
