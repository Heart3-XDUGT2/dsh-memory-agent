# docs/ 文档索引

当前发布候选：`0.46.0-rc.2`。面向使用者，先读：

1. [安装与排障](INSTALL.md)
2. [项目架构](ARCHITECTURE.md)
3. [API](API.md)
4. [测试与验证](TESTING.md)
5. [DSH兼容性](COMPAT_DSH_0.2.md)
6. [发行说明](releases/0.46.0-rc.2.md)
7. [隐私与第三方来源](../PRIVACY.md) / [THIRD_PARTY.md](../THIRD_PARTY.md)

## 当前参考

| 文档 | 用途 |
| --- | --- |
| `ARCHITECTURE.md` | Echo整体架构、JS壳/Python引擎、读取/写入数据流 |
| `MEMORY_ARCHITECTURE.md` | 记忆表、字段和数据语义参考；不代表实时个人数据 |
| `EMOTION_SPACE.md` | 情绪空间、关系维度和面板口径 |
| `CONFIG_CENTER_CONTRACT.md` | 设置中心字段与持久化契约 |
| `CONFIG_CENTER_CURL.md` | 设置接口示例 |

仓库根README包含面向使用者的架构总览；本目录文档提供实现和维护细节。若文档与源码或发行说明冲突，以当前源码、`CHANGELOG.md`和发行说明为准。

## 验证入口

```powershell
npm run release:check
```

验证范围与限制见[TESTING.md](TESTING.md)。
