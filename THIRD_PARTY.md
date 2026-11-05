# 第三方代码、依赖与字体

Echo 自身采用根目录 [MIT License](LICENSE)。下表只陈述这个仓库中实际分发的代码、生产依赖或字体引用；研究文献与项目致谢不等于复制了它们的代码，也不因此把其许可证套到本项目。

## 随源码分发的组件

| 组件 | 实际版本/来源记录 | 许可与保留位置 |
|---|---|---|
| `lib/ipc-core/` | `dsh-interpersonal-circumplex` 的纯逻辑核心；仓内记录复制于2026-10-05，未记录可核的上游版本号或commit，故不补造版本 | MIT，Copyright (c) 2025 peirar；原许可在 [`lib/ipc-core/LICENSE`](lib/ipc-core/LICENSE)，来源说明在同目录 [`README.md`](lib/ipc-core/README.md) |
| `web/vendor/d3.v7.min.js` | D3 **7.9.0**；文件与 npm `d3@7.9.0` 的 `dist/d3.min.js` 逐字节一致 | ISC，Copyright 2010-2023 Mike Bostock；文件头版权和 [`web/vendor/LICENSE.d3.txt`](web/vendor/LICENSE.d3.txt) 原文均保留 |

D3 上游：[d3/d3](https://github.com/d3/d3)，本次核对发行物：[d3-7.9.0.tgz](https://registry.npmjs.org/d3/-/d3-7.9.0.tgz)。旧图谱页优先加载仓内 D3，只有本地脚本未能建立 `window.d3` 时才尝试 `https://d3js.org/d3.v7.min.js`；这一后备网络请求也属于 [隐私说明](PRIVACY.md) 的边界。

## 文件正文提取的生产依赖

以下是 `package.json` 的三个直接依赖及 `npm-shrinkwrap.json` 锁定的两个传递依赖。它们由 npm 安装，未把整个 `node_modules` 目录复制进插件源码包。

| 组件 | 精确版本 | 许可 | 上游与许可副本 |
|---|---|---|---|
| unpdf | 1.4.0 | MIT | [unjs/unpdf](https://github.com/unjs/unpdf)，[许可](LICENSES/unpdf-1.4.0.txt) |
| yauzl | 3.4.0 | MIT | [thejoshwolfe/yauzl](https://github.com/thejoshwolfe/yauzl)，[许可](LICENSES/yauzl-3.4.0.txt) |
| saxes | 6.0.0 | ISC | [lddubeau/saxes](https://github.com/lddubeau/saxes)，[完整许可](LICENSES/saxes-6.0.0.txt) |
| pend，yauzl 的传递依赖 | 1.2.0 | MIT | [andrewrk/node-pend](https://github.com/andrewrk/node-pend)，[许可](LICENSES/pend-1.2.0.txt) |
| xmlchars，saxes 的传递依赖 | 2.2.0 | MIT | [lddubeau/xmlchars](https://github.com/lddubeau/xmlchars)，[许可](LICENSES/xmlchars-2.2.0.txt) |

许可副本来自锁定版本的 npm 发行物；saxes 6.0.0 的 npm 包没有单独的 LICENSE 文件，因此保留了上游 **v6.0.0** tag 的[原始 LICENSE](https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE)，包括 sax 来源声明。

### unpdf 内嵌的 PDF.js

unpdf 1.4.0 的 serverless `dist/pdfjs.mjs` 包含 Mozilla PDF.js **5.4.296**，构建标识 **f56dc8601**，不是额外的 `pdfjs-dist` 运行时依赖。版本与构建标识已在实际锁定发行物中核对；unpdf 的 README 也明确写出 PDF.js 版本。

PDF.js 采用 Apache-2.0，由 Mozilla Foundation 与贡献者维护；完整 [Apache-2.0 许可](LICENSES/PDFjs-5.4.296-Apache-2.0.txt) 取自上游 [v5.4.296/LICENSE](https://github.com/mozilla/pdf.js/blob/v5.4.296/LICENSE)。unpdf 的 `BaseCanvasFactory` 等派生代码也有 Apache-2.0 来源注释，这些注释应继续保留。MIT 的 unpdf 外层许可不代替其内嵌 PDF.js 的许可。

本插件只调用文字提取流程，不安装 optional peer `@napi-rs/canvas`，也不随源码分发 PDF.js 的外部字体、CMap 或 WASM 二进制资产；包内引用这些资源的名称不代表已经捆绑了相应文件。实际运行行为以提取器配置及所用依赖版本为准。

## 字体

目前仓库没有 `.woff`、`.woff2`、`.ttf` 或 `.otf` 文件。新版面板在 `web/mock/final/app.css` 只用 `local("Noto Sans SC")` 与 `local("Noto Serif SC")`，再回退到系统字体；没有 Google Fonts 请求或随包字体文件。

字体名称引用不等于再分发字体。本项目没有给系统字体改许可，也没有把字体许可伪装成本仓许可证。如果以后加入字体文件，应同时记录准确来源、版本和对应许可。

## 宿主与开发环境

DSH 与其注入的 `@deepseek-ai/*` 服务由宿主提供，不是这个插件 vendored 的源码。开发/CI 为验证兼容性而下载的宿主发行物仍受各自许可证约束；不要将开发依赖树当作插件运行包随意再分发。

锁文件记录的版本和 integrity 用于可复现安装，不构成无漏洞保证；安全报告方式见 [SECURITY.md](SECURITY.md)。

## 情绪空间渲染来源

`web/views/emotion-space.js:5-11` 还记录了两份渲染来源：人际圆盘的几何/绘制/交互来自 `dsh-interpersonal-circumplex/client.js`，情感立方体的数学/绘制来自 `dsh-pad-emotion/client.js`。复制范围和外壳适配见 `docs/EMOTION_SPACE.md:370-376`；不能只列 `lib/ipc-core/` 而漏掉这些已分发的派生渲染代码。

IPC 项目现有原文许可是 `lib/ipc-core/LICENSE` 中的 MIT，Copyright (c) 2025 peirar；应连同 IPC 相关来源说明保留。

**PAD 来自收到的 `dsh-pad-emotion-main` 源码包，package.json 版本为0.1.0，license为MIT。** 原 LICENSE 已逐字节保存在 [`LICENSES/dsh-pad-emotion-MIT.txt`](LICENSES/dsh-pad-emotion-MIT.txt)，其中的 `Copyright (c) 2025 <YOUR NAME>` 是原文件占位符，完整保留；不擅自补写作者或不存在的commit。原包的 `private: true` 是其 npm 发布标志，不替代文件中的 MIT 授予。

本次从收到的源码实际核对了 `rotate`、`project`、`world` 三个函数：去除排版差异后相同，243组数值投影完全一致；view/projection、face-depth排序、棱线描画、轴描画四个已识别块也核对一致。React/原生外壳及本仓后续增加的显示逻辑属于适配，不声称整个渲染文件逐字节相同。原文件SHA256如下，精确来源记录见 [`docs/vendor/PAD_SOURCE.json`](docs/vendor/PAD_SOURCE.json)。

| 收到的源文件 | SHA256 |
|---|---|
| `LICENSE` | `7890035ee1010751e34fc6e3f0acb9c4642b860b03352b4b866ac2d237a51929` |
| `package.json` | `42780e40d5b3b0c87141c2b3ad17782b8c5097c1a8b819ddd445bd7ef813d748` |
| `client.js` | `91f23378bd6603d6a3b2c9d3d4e097ca71773a9769be8fd2b4f81d6d18e23dd8` |

历史评审提到的 NRC-VAD 词表限制也应与实际分发范围分开：当前 `lib/`、`web/`、`python/` 扫描没有发现 NRC-VAD 引用或该51条PAD词表副本；渲染来源注释列的是数学与绘制。本次不据旧评审推定本仓已经分发了整份词库。

## 仅开发测试使用的上游夹具

`tests/fixtures/host-web-app/` 保存 `@deepseek-ai/dsh-web-app` **0.2.0-rc.2** 的三个上游原文件：`package.json`、`presets/standard.patch.yml`、`LICENSE`；另有本地 `SOURCE.json` 记录来源、发行物 integrity 与各文件 SHA256。原许可为 **MIT，Copyright (c) 2026 DeepSeek**，原文完整保留在该夹具目录。

来源：[npm 精确发行物](https://registry.npmjs.org/@deepseek-ai/dsh-web-app/-/dsh-web-app-0.2.0-rc.2.tgz)。它是公开宿主发行物中的真实 preset 测试数据，不是宿主实现的替身，也不是插件运行依赖；整个 `tests/` 目录不进入 npm 运行包。源码仓库继续保留夹具许可证，不因测试文件不打包而删去它。
