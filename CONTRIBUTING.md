# 参与开发

先读README、PRIVACY、SECURITY和`docs/TESTING.md`。使用Node24、Python3.14、全新临时目录与合成数据，不把自己的`.dsh`、junction或聊天当作测试前提。

```powershell
npm ci --ignore-scripts
npm run dev:bootstrap
npm run test:unit
npm run test:py
npm run release:check
```

集成需同父目录的`dsh-qq-bridge`，再执行`npm run test:all`。完整CI包含跨仓测试；单元结果不能冒充集成通过。不得在测试中配置真实模型或QQ账号。

新增依赖固定版本并更新shrinkwrap，注明用途和许可。检查包内容与引用。UI变更附合成数据下的1440/768/390截图；仅文档、测试、发布工程不必重设计UI。

PR说明问题、最终行为、验证命令、结果、兼容和迁移影响。失败、跳过与不具备环境分别报告。不要提交个人称呼、账号、凭据、数据库、原始审计截图或聊天日志。安全问题使用私密渠道。
