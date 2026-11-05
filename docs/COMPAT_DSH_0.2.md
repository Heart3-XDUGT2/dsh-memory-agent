# DSH 0.2.0-rc 适配(实测 0.2.0-rc.2)

> 2026-10-02 实测成文。上一版是源码评估;这版每条都有验收数字。
> 红线 `lib/relay.js` / `persona.json` / `cordis.patch.yml` 全程未动。

## 一句话

**四个插件资产里只有预设会"死"**(0.2.0 换了预设的发行机制);其余是
**零改动**(settings 段、slots、`dsh.client`、`remote.agentPresets` 都没变)。
0.44.0 把两代预设机制都做进生成器,升级后**跑一次生成脚本**即可;不跑也不会坏
(存根形态在 0.2.0 实测好使),只是预设名单里暂时没有「Echo 陪伴模式」。

## 实测:什么变了(机制,全部对着真源码 + 真二进制量出来)

### 1. 预设机制换代 —— 唯一的硬破坏

| | 0.1.5-rc.3 | 0.2.0-rc.2 |
|---|---|---|
| 预设从哪来 | 扫 `<DSH_HOME>/.agent-presets/*/` + `*.json` **文件** | **不扫目录、不收路径**;bundle patch 里的 `@deepseek-ai/dsh-agent-preset` **声明行** |
| 我们的预设 | `~/.dsh/.agent-presets/echo/`(v0.38 生成,`.echo-generated.json` 记指纹) | 这份**不再被读** ⇒ 必须转成声明行 |
| 覆盖口径 | 按名字合并(可以只写要盖的成员) | `config.plugins[]` 是**完整成员清单**,替换整份名单(没有"按名字合并") |
| 会话存的键 | `presetId` = 目录名 `echo` | `presetId` = `config.id`(不是行 id!) |
| 顺序 | `manifest.json` 的 `order: 9` | `config.order: 9` |
| 行 id(Loader 编辑地址) | — | `- id: preset-echo` |

来源(实测源码):`dsh-app-boot/lib/index.js:272-276`(`evaluatePluginCompatibility`)、
`:1183-1189` + `:3227-3231`(`loadPresetBundles` 注册表:「does not scan preset
directories and does not accept preset paths」)、`dsh-agent-preset/src/index.ts:336-360`
(`config.id` 是身份)、`dsh-client-ui-agent-preset/src/service.ts:242-252` + `:284-292`
(会话只存 `presetId`,按 `(id, version)` 去重,`order` 只管展示)。
出厂四份预设的形状:`dsh-web-app/presets/{standard,ptc,minimal,cordis}.patch.yml`
(`standard.patch.yml` 146 行 = 一份完整标准预设的全部成员)。

**装法实测**:`dsh.bundle.patch` 点名 `preset.patch.yml` ⇒ 生成的声明行进组合树
⇒ 预设名单出现「Echo 陪伴模式」(name=`Echo 陪伴模式`,config.id=`echo`,order=9)
⇒ 按 `config.id == 'echo'` 选中 ⇒ 会话压缩走 `dsh-echo/compaction`。
旧目录**留着不删**(降级回来还在;0.2.0 只是不读它)。

### 2. 兼容检查(peerDependencies,新)

宿主启动/安装时校验 `peerDependencies` 里**点名 `@deepseek-ai/dsh` 的范围**
(`semver.satisfies(runtime, range, {includePrerelease:true})`,rc 算数)。
不满足 ⇒ **跳过整个 bundle** 并报 `incompatible-version`;豁免 = 插件管理器的
`compatibility.json`(`allow-version <pkg@version> --dsh-version <ver> --accept-risk`)。

- 实测正对照:沙盒把 peer 改成 `>=0.3.0` ⇒ 报
  `dsh: skipping profile bundle "dsh-echo": Error: Plugin dsh-echo@0.44.0 is
  incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh":">=0.3.0"}`,
  并指路 `dsh plugin allow-version` ⇒ **检查真读这个字段**。
- 我们声明 `">=0.1.5-rc.3 <0.3.0"`(两包)⇒ 实测 0.2.0-rc.2 **通过**(不跳过)。
- `autoInstallPeers: false` ⇒ 声明 peer **不会**触发任何安装。
- **不**给 `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-llm` 声明 peer:它们随宿主
  从 `~/.dsh/node_modules` 解析(当前部署就是这样),npm registry 上装不到。

### 3. `dsh.bundle.patch` 的形态(踩过雷)

**0.1.5 只吃字符串,0.2.0 才收一串。** 数组塞给 0.1.5 ⇒ 当场炸
(`path.join` 收到数组,`loadProfileDirectory`,`dsh-app-boot/lib/index.js:853`,实测)。
⇒ 生成器**按世代自摆**:0.2.0 写数组 `["./cordis.patch.yml","./preset.patch.yml"]`,
0.1.x 摆回字符串 `"./cordis.patch.yml"`(`setBundlePatchForm` / `ensureManifestForm`;
`npm run check` 的世代门也钉着这个形态)。

### 4. 没变的(源码量过,一个字都不用改)

- `settings.section` 槽:0.2.0 的 slot id 表里原样(`dsh-client-ui-settings`)。
- 会话头四个槽(`header.utilities` / `.actions` / `.corner` / session)、
  `slots.inject(name, fn)` + `slots.register({name,id,order,label}, C)`、
  label 可以是 `() => string` —— `dsh-client-ui-slots/src/index.ts:398-408` 与 types L555。
  client.js 里那几个 `ctx.get('slots')` 也是官方口径(service.ts:275-283)。
- `dsh.client` 块形状({platform, inject?, external?, immediately?} + `exports["./client"]`)。
- `remote.agentPresets`(`list()` / `select(sessionId, presetId)` / `read(id)`)⇒
  PresetPicker 的三件事 0.2.0 全按旧契约应答(`load()` 纯读、按 `config.id` 选、会话零持久化),
  **零改动**。

## 我们改了什么(0.44.0)

1. **`lib/preset-patch.js` 三把新刀**(纯函数 + 可测):
   `presetDeclarationPatch(stockText)` 整份抄出厂 standard 底稿、只动四件事
   (压缩行换 `dsh-echo/compaction`、行 id→`preset-echo`、`config.id`→`echo`、
   name/description/order→我们的);`emptyPresetPatch()` = 0.1.x 的空存根
   (`- insert: []` + 说明);`setBundlePatchForm(manifest, wantArray)` = manifest 形态。
2. **`scripts/install-preset.mjs` 双世代生成器**:自动识别世代(找得到
   `dsh-web-app/presets/standard.patch.yml` = 0.2.0 世代)⇒ 0.2.0 写声明行,
   0.1.x 照旧走预设目录;`--check` / `--force` / `--remove` 两边都支持;
   manifest 形态跟着世代自摆。升级后**跑一次**即可,幂等。
3. **`scripts/check-preset-patch.mjs` 世代门**(`npm run check` 第五闸):
   按世代验 `preset.patch.yml` 的形状(0.2.0 ⇒ 有 `preset-echo` 行且没有出厂压缩行;
   0.1.x ⇒ 一行 `- id:` 都不许有)+ manifest 形态 + 预设目录清单钉子。
4. **`peerDependencies`**(`dsh-echo` / `dsh-echo-qq`)。
5. 电池:`tests/preset-declaration.test.js` 13 条(手术保真、幂等、失败要报原因、
   旧刀还在、manifest 形态双向)。

## 验收(全部实测,不是推演)

| 项 | 结果 |
|---|---|
| 0.2.0-rc.2 组合树(`--dump-config`,真二进制,隔离 `DSH_HOME` 沙盒) | **exit 0,1454 行**;`echo-qq` / `echo` / `preset-echo` 都在 |
| 声明行逐字段 | 行 id `preset-echo`、`config.id: echo`、name/description/order(9)全对;`!!js` 条件原样活着 |
| 压缩行 | 我们那份 = `compaction-echo / name: dsh-echo/compaction`;出厂四份各留各的 `compaction-basic`(没被误伤) |
| 升级瞬间(存根形态)组合 | **exit 0,1265 行** ⇒ 不跑生成器也不会坏 |
| 兼容检查正对照 | peer 改 `>=0.3.0` ⇒ 精确报 `skipping profile bundle "dsh-echo"` + 豁免指路(证明检查真读字段) |
| `--dump-config-schema` | 与纯出厂对照只多 **1 条同型提示**(`unrecognized Loader tree carrier` —— rc.2 的 schema dumper 对**出厂四份预设**也这么叫,不是我们的形状错) |
| 0.1.5-rc.3 真宿主组合树 | **exit 0,594 行**(字符串形态;数组形态实测会炸,已修) |
| 8 个工具过 0.2.0 真 `defineTool` | **8/8 绿**(真实返回值过 schema + 无损 JSON) |
| JS 电池 | **1173 绿 / 0 败**(含 preset-declaration 13、graph-layers 11;重构后复跑分毫不差) |
| Python 电池 | **603 绿**(602 + 1 条孤门守卫) |

## 升级清单(他要做的)

1. 把 dsh 升到 0.2.0(他自己装;插件一个字不用改)。
2. 重挂载后,在 `dsh-echo` 里跑一次 **`node scripts/install-preset.mjs`** ——
   自动:识别 0.2.0、写 `preset.patch.yml` 声明行、manifest 摆成数组。
   **不跑也不会坏**(存根形态实测好使),只是预设名单里没有「Echo 陪伴模式」。
3. 想验:`node scripts/check-preset-patch.mjs` + `node scripts/install-preset.mjs --check`。
4. 旧目录 `~/.dsh/.agent-presets/echo/` **留着**(0.2.0 不读它;万一降级回来还在)。
5. 降回 0.1.x:重跑 `node scripts/install-preset.mjs` 自动摆回(双向都实测过)。

## 已知的 rc.2 坑(与我们无关,但要知道)

- `--dump-config-schema` 对**每份预设声明**都报一条
  `unrecognized Loader tree carrier; use cordis:group or cordis:include for native child
  collection`(出厂四份 + 我们那份都报)—— schema dumper 的口径问题,
  `--dump-config` 组合是好的,加载也认(`plugins[]` 是配置不是 Loader 树)。
- PowerShell `Out-File -Encoding utf8` 在这台机器上**写 BOM**,JSON 会被
  `JSON.parse` 拒(`Unexpected token '﻿'`)—— 生成器一律用 node 写盘,无 BOM。
