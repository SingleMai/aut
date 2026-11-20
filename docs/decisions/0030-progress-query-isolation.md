# ADR-0030：只读进度查询的登记与隔离执行

- 状态：已接受（ADR-0012 与 ADR-0028 的实现细化）
- 日期：2026-11-16

## 决策

- ProgressQuery.register(ask, decisionLogId) 校验任务、原用户消息与已持久化的同一 ask 决策日志。
  返回 RegisteredExecution，Chief 先保存登记结果和确认消息，再调用 activate；按 decisionLogId 去重。
  完成结果与固定消息 ID 一起持久化后移除内存登记；重复调用先读取持久结果，Scope 关闭时清空登记。
  查询不进入 Task.queue，也不跨 daemon 重启自动重放，不为查询隐式继续原任务执行。
- fast 仅从任务、bot 配置读取状态、创建时间、最近活动和待答数，使用固定中文模板。
  bot 名称有界截取，整个模板不超过 200 个 Unicode 码点；不调用分类器、adapter 或模型。
  消息 author=chief，带来源 taskId。
- deep 通过 SessionManager.snapshot 获得只读句柄（cursor/fork/transcript），不接触 runtime Map，
  不持有会阻止取消的锁。无 live 时，仅在查询自己的 Scope 内恢复持久化 cursor 用于 fork/读 transcript，
  永不向恢复的原会话 startTurn，不改变任务状态或队列。归档任务同样可只读查询。
- 支持 native fork 时在独立 fork 提问；无 fork 则读取原 transcript，创建没有 soul/MCP 的临时会话。
  原会话在读/分叉间关闭时，允许按已保存 cursor 重建只读来源；无法取得可靠上下文则明确失败，不从事件文本推断进度。
- 提问指令固定要求只报告已知事实、不继续原工作、不修改文件、不询问追加输入；内部 question 按 ADR-0028
  取消临时查询、记录事件与失败、提示用户补充，绝不自动回答，也不增加原任务 pending。
- 查询子进程、监听与超时绑定独立 Scope；所有原生事件持久化供审计，不送入原任务的状态处理队列。
  成功完成报告通过同一 SessionReplyGate，再以 bot/task 来源写 reply 与独立 event:fullReportRef。
  不覆盖 Task.lastReport；结束后释放所有临时会话。
- 查询失败写执行失败日志与固定中文提示，避免无响应。内部错误详情不作为用户报告绕过 gate。

## 后果

主会话排序只等待查询登记，深查在服务 Scope 内后台进行。原任务继续执行或被用户取消都不受查询阻塞。
查询没有新任务身份，完整报告通过独立完成事件保存。需要跨重启查询重放时另行定义持久执行队列。
