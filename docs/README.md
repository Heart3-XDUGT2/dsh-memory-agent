# docs/ 文档索引

当前发布候选：`0.46.0-rc.1`。面向使用者，先读：

1. [安装与排障](INSTALL.md)
2. [项目架构](ARCHITECTURE.md)
3. [API](API.md)
4. [测试与验证](TESTING.md)
5. [DSH兼容性](COMPAT_DSH_0.2.md)
6. [发行说明](releases/0.46.0-rc.1.md)
7. [隐私与第三方来源](../PRIVACY.md) / [THIRD_PARTY.md](../THIRD_PARTY.md)

## 当前参考

| 文档 | 用途 |
| --- | --- |
| `ARCHITECTURE.md` | Echo整体架构、JS壳/Python引擎、读取/写入数据流 |
| `MEMORY_ARCHITECTURE.md` | 记忆表、字段和数据语义参考；不代表实时个人数据 |
| `EMOTION_SPACE.md` | 情绪空间、关系维度和面板口径 |
| `RETRIEVAL_BASELINE.md` | 检索基线与降级行为 |
| `CONFIG_CENTER_CONTRACT.md` | 设置中心字段与持久化契约 |
| `CONFIG_CENTER_CURL.md` | 设置接口示例 |
| `DISCIPLINE.md` | 失败可见、来源留痕和数据边界规则 |
| `DEFENSE.md` | 项目演示和技术问答材料 |
| `QQ_BRIDGE_DIY_PLAN.md` | QQ桥接边界与拆分说明 |

仓库根README包含面向使用者的架构总览；本目录文档提供实现和维护细节。若文档与源码或发行说明冲突，以当前源码、`CHANGELOG.md`和发行说明为准。

## 历史归档

`archive/2026-11-08/`保存早期调研、施工计划、现场审计、旧界面验收和旧版本语音/图谱资料。它们用于追溯设计来源，不是当前安装步骤、默认配置或验证结论。归档文件不再作为根README的操作入口。

## 验证入口

```powershell
npm ci --ignore-scripts
npm run dev:bootstrap
npm run test:unit
npm run test:py
npm run release:check
```

完整验证范围、隔离环境和跨仓条件见[TESTING.md](TESTING.md)。
