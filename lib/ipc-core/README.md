# lib/ipc-core/ —— IPC(人际环形模型)纯逻辑核心的**只读副本**

## 出处(保留出处是硬要求)

- 上游项目:`dsh-interpersonal-circumplex`(队友插件,包名 `dsh-interpersonal-circumplex`)
- 上游本地路径:`上游本地副本(不入包)dsh-interpersonal-circumplex-main\`
- 复制范围:**仅 `core/` 目录下的 8 个 `.js` + 上游 `LICENSE`**
- 复制日期:2026-10-05
- 许可:**MIT**(见本目录 `LICENSE`,首行 `MIT License`)
- 未复制的内容:`index.js`(host 半边,依赖 node:fs/path 与 `@deepseek-ai/*`)、`client.js`、`README.md`、`setup.ps1` / `verify.ps1` / `install.cmd`、`cordis.patch.yml`、`SETTINGS-SNIPPET.yaml`、`安装说明.md`、`_tools`

## 为什么可以整段借用

`core/` 自述"不 import 任何 DSH 包、不碰文件系统、不碰网络"(`index.js:3-4`)——已实测复核:
本目录 9 个 `.js` 的全部 import **都是同目录相对路径**(`./xxx.js`),零 node 内置、零三方依赖。

## 文件清单(2026-10-05 复制时的大小)

| 文件 | 作用 |
|---|---|
| `circumplex.js` | 环形几何、8 分仪、121 格(裁圆后可达 81)、四种关系原型与全套关系度量 |
| `lexicon.js` | 单方姿态词表(**33** 条,带出处分级)与强度分档 |
| `states.js` | 关系状态词表(**178** 条)与按读数选词 |
| `match.js` | 坐标 ↔ 语言的唯一转换点(`nearestAnchors` / `describeRegion`) |
| `dynamics.js` | 惯性、非互补升级、网格+残差量化(无时间项) |
| `state.js` | 会话级双人状态机(历史/转写/开关/持久化) |
| `appraise.js` | 对话 → 两个坐标的打分提示词与解析器 |
| `describe.js` | 度量 → 提示词块 / 行为指引 / 日志摘要 |
| `index.js` | 仅做 `export *`(便于一句 `import('./ipc-core/index.js')`) |

## 使用约定(重要)

- **只读**:本仓库**不改动**这些文件;上游升级时整目录覆盖,改动一律写在外层的
  `lib/ipc-adapter.js`(适配器)里。
- **fail-soft**:外层一律用 `lib/ipc-adapter.js` 的动态 import 访问,目录缺失时降级为
  "无关系代数",绝不抛错(见 `lib/ipc-adapter.js` 与 `tests/ipc-adapter.test.js`)。
- **不改上游语义**:轴名沿用上游的 `a`(掌控/agency)与 `c`(联结/communion);
  `DOM`/`LOV` 只是文档别名,不是代码标识符。
