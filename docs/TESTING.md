# 可复现验证

使用Node24、npm、Python3.14。依赖由shrinkwrap锁定，安装不执行生命周期。bootstrap验证实际公共宿主版本、ESM模块及有来源的原样预设底稿。

```powershell
npm ci --ignore-scripts
npm run dev:bootstrap
npm run test:unit
npm run test:py -- --guard-selftest
npm run test:py
npm run release:check
```

测试自动纳入`.test.js`及`.test.mjs`。跨仓依赖单列；固定布局为同父目录的`dsh-memory-agent`和`dsh-qq-bridge`（含`official/`）。跨仓WebSocket测试使用本仓锁定的`ws 8.22.1`开发依赖。运行`npm run test:all`完成两类测试；缺必要源码、宿主、Python或断言失败应非零退出，不静默跳过。

使用临时DSH_HOME、合成数据和模型适配器。宿主模块是真实公共发行物，合成适配器不调用真实模型或QQ。模块导入和注册/装卸不等于完整Web服务启动。

Node测试与发布子进程显式使用`PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`，覆盖大小写混杂的外部同名变量，使Python中文输出在英文Windows中保持UTF-8。

Python公共入口仅为`npm run test:py`，不要直接运行旧的`unittest discover`命令。入口在导入测试前使用`-I -S -B`和独有临时工作目录，设置合成HOME、DSH及配置路径；文件和SQLite连接审计保护也覆盖实际worker子进程。这些受保护调用一旦越界就使验证失败，包括被业务代码捕获的拒绝。保护范围为已审源码使用的调用；新增原生扩展、SQLite附加库等入口须补策略与复审。源码须与已审`release-ast-policy.json`摘要一致，否则停止发现测试。

公共清单为753项原安全用例加5项图谱、5项嵌入合成契约，共763项。图谱使用公开定义的非空临时库；嵌入执行生产函数，但以标准库适配器代替ONNX、NumPy和Tokenizer后端，不表示真实模型已验。原5项模型与5项历史私有快照控制保留在[`python/manual/`](../python/manual/README.md)，默认明确列为`NOT_RUN_MANUAL`，不计为通过或skip。先前与新清单同为763的旧发现结果不能替代新基线。

`--guard-selftest`只使用自建合成数据库及文件作禁止目标，检查越界操作被事先拒绝、子进程拒绝被记录、父进程环境和禁止目标字节保持不变。保护负控与公共基线是两组独立结果。

`scripts/live-config-guard.mjs`是可能读真实配置的手动运维工具，不是发布命令。公共测试仅验证其路径和快照逻辑，全部使用合成哨兵，不声称观察过真实配置。

归档工具的测试也只使用独有临时目录与真实合成SQLite。锁冲突、损坏库或采样结构变化必须拒签，`--force`不能覆盖未知结果；持锁释放、耗尽和schema变化均通过真实SQLite连接验证，不靠吞错或放宽drift断言。
只读SQLite连接仍可能维护WAL共享内存索引；精确源字节控制使用已知日志模式与一致夹具，不能将任意模拟WAL/SHM的副作用误当成归档写入。

`release:check`检查语法、静态隐私规则、引用、依赖锁、许可和实际npm包。它不通过读取真实profile来决定称呼检查是否跳过。沙盒`release-lifecycle.mjs`实际装机、升级、校验、卸载tgz，核对合成数据和无关profile字段不变。

CI只读仓库权限，Node24/Python3.14，无发布权限、模型凭据和QQ token。同仓standalone job在私有阶段也运行单元、Python和发布闸。跨仓job只在仓库公开后的非PR事件运行，不用额外token访问另一个私库。该job未运行时不能声称远端跨仓已绿；本地仍可用两份源码执行全量集成。定义了workflow不代表GitHub Actions已执行，远端状态以实际Actions为准。
