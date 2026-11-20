# ADR-0021：本地 daemon API 与恢复入口

- 状态：已接受（MVP-05 既定 HTTP + WebSocket / 本地鉴权要求的实现细化）
- 日期：2026-11-16

## 背景

桌面端只是 daemon 客户端。需要固定请求边界与鉴权方式，供客户端和后续 chief 接入；
存储服务与 API 可按该接口并行实现，整体验收必须等待真实存储集成测试通过。

## 决策

- HTTP 仅监听 `127.0.0.1`，默认端口 4317，测试可用动态端口。API 路径统一为 `/v1/`。
- 同一数据目录只允许一个 daemon 实例；在恢复任务之前用独立 SQLite 连接打开 `daemon-lock.sqlite`，
  以 `busy_timeout=0` 和 `BEGIN EXCLUSIVE` 持有操作系统文件锁直到 Scope 结束；获取失败必须关闭连接。
  正常关闭 rollback + close，崩溃由操作系统释放锁，不删除锁数据库，不使用有检查/删除竞态的 PID 文件。
  第二实例取得锁失败，不得打开主数据库或恢复仍运行的任务。
- 每个数据目录创建持久化随机 token 文件 `daemon-token`，权限 0600；HTTP 使用 Bearer token。
  WebSocket 使用同样的 Authorization header，浏览器客户端也可通过 `aut-token.<token>` 子协议携带。
  不在 URL 中传递 token，不向远端监听地址开放，也不输出 token 到日志。
- 所有输入输出由共享 Effect Schema 校验；请求体上限 1 MiB。错误输出固定 `{ error: { code, message } }`。
- 新消息先写 main thread，再交给可替换的 `InboundGateway`。MVP-05 的 gateway 只发布事件，
  不伪造路由或执行报告；后续替换为 chief 的串行入口。
- 启动时按表恢复 created/running/waiting_user/reporting 为 interrupted，并持久化模板通知。
  已 idle/failed/interrupted/cancelled/archived 的任务不重复改动，resume 游标保留。
- WebSocket 使用独立 `DaemonEvent`：`{type:"event",event:AutEvent}` 或
  `{type:"changed",resources:["messages"|"tasks"|"requests"|"bots"|"config",...]}`。
  输出变更不伪装成用户输入；客户端收到资源失效通知后回读 API，连接初始与重连也回读。
  Store 记录事务内成功写入的表，只有 COMMIT 成功后才发布去重资源集合；只读、回滚、失败不发布。
  COMMIT 与 PubSub 发布在同一不可中断区间；ConfigStore 原子保存成功后采用同一规则发布。
  独立 Changes PubSub 及每条订阅都绑定 Scope。仅参考 OpenMausBot 738ec88 的
  `server/store.ts` onChange/emit → `server/index.ts` broadcast 结构，使用本项目 Effect 实现，不复制代码。
- `quote-reply` 在入口事务中检查引用消息存在，将用户原文保存为 `quote:${storedEvent.id}`，
  author=user、kind=text、at=事件时间，并继承被引用消息的 taskId（若有）；同事务保存原始 UiAction 事件。
  然后才发布输入事件，保证主会话顺序；Chief/StateSource 只读取这条消息，不能延迟补写。
- 配置写入由 ConfigStore 负责；本地 API 对配置修改串行化并检查 bot/harness 引用，保护系统 bot 标记。
- daemon 入口只组装 Layer，HTTP 生命周期、鉴权、请求解码、恢复分别放服务；关闭 UI 不调用 daemon shutdown。

## 后果

精确路由见 `docs/local-api.md`。端到端测试使用临时数据目录、真实 HTTP/WS 与 SQLite，
验证鉴权、分页、非法数据拒绝、配置保护、重启恢复；此阶段不宣称已接入 chief 或 session。
