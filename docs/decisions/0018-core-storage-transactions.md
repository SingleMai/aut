# ADR-0018：core 持久化与事务边界

发布前存储格式现行规则见 [ADR-0048](0048-pre-release-data-baseline.md)。

- 状态：已接受（既定 SQLite / JSON 存储架构的实现细化）
- 日期：2026-11-16

## 背景

P1 需要将共享协议写入 SQLite，并为之后 chief、SessionManager 和 daemon 提供统一的原子更新入口。
任务回答、排队与决策日志修订可能同时到达，读后写不能覆盖其他 Fiber 的更新。

## 决策

1. 使用已锁定 Node 24 的 `node:sqlite`，同步数据库调用只出现于 `Effect.try` 边界；
   不新增数据库依赖。连接绑定 Scope，关闭 Layer 时关闭连接。
2. 六个业务表存放经过协议 Schema 校验的 JSON，另有 SQLite 序列、唯一 ID 与任务 ID 索引。
   迁移使用 `PRAGMA user_version`，在 `BEGIN IMMEDIATE` 事务内执行。未知未来版本拒绝打开。
3. 每个 Store 连接由 Effect Semaphore 串行访问；跨连接由 SQLite 事务协调。
   事务回调不得重入 Store，使用回调收到的 tx。失败或 Fiber 中断后回滚，提交失败也回滚。
4. MainThread、TaskRegistry、DecisionLog 的读改写使用同一事务入口。
   TaskRegistry 保持 task 的 id、botId、createdAt、session.instanceId 不变；状态只能通过转移表更新。
5. question 的 pending ID 增删由 TaskRegistry 原子完成。SessionRequest 关闭、问题卡片过期、
   回包与事件写入的跨表编排由后续 SessionManager/chief 在 Store.transaction 内完成，P1 不虚构已完成联调。
6. 配置在独立 Semaphore 下读取、校验、更新；写入同目录临时文件并 fsync，再原子 rename。
   配置目录权限 0700，文件权限 0600。未知配置字段拒绝写回，避免静默丢失未知设置。
7. EventBus 使用 scoped PubSub；它是实时通知通道，持久事件由 Store 的 events 表保存，
   不把内存发布误称为持久化。

## 理由

沿用既定六表、Effect 与本地 JSON 的设计，保持存储实现简洁；共享事务边界为多表一致性留出入口。
参考 OpenMausBot `738ec88` 的持久化文件组织仅用于核对设计，没有复制其代码。

## 后果

Schema 是存储格式边界，协议变更须提供迁移。当前 task 状态机与问题语义仍以 ADR-0015、0017 为准。
同步 SQLite 操作适合当前单机 MVP；长时间外部工作不得放进事务回调。
