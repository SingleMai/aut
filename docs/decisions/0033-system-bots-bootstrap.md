# ADR-0033：系统 bot 初始化与慢脑执行

关于两个内置角色的决定已由 [ADR-0047](0047-single-primary-assistant.md) 更新。

- 状态：已接受
- 日期：2026-11-16

## 背景

general 与 slow-brain 是不可删除的系统角色，但首次启动不能为了补齐它们而覆盖用户的模型、Provider或项目配置。
escalate 必须复用正常任务登记/投递/交接/回包链路，而不能另建树外模型调用。

## 决策

1. SystemBots 按 BotConfig.system 的 general / slow-brain 枚举识别角色，不要求固定bot ID。
   系统bot默认description与soul使用英文，名称面向中文UI。已有系统bot完整保留，不重置用户编辑。
   创建时ID冲突使用新的aut前缀ID，不覆盖或重新标记同名用户bot；MCP配置默认空，由SessionSetup注入aut桥。
   Administration既有规则继续禁止删除系统bot或修改system身份。
2. daemon启动运行可重复的ensure；用户保存bot/harness配置后可再次调用公开ensure方法。
   缺失角色优先复用已有bot的modelSelection（含effort）与cwd，前提是引用的实例已配置且是MVP支持的Codex实例。
   只增加缺失系统bot，不修改任何现有bot、harness、classifier、Provider或密钥设置。
3. 没有可复用bot时，使用现有Codex实例的command/args/env做只读探测；实例全空时才新建aut自身的Codex实例。
   通过现有adapter transport运行initialize、config/read；优先使用实际配置model与effort。
   model未指定时读取model/list，只有唯一isDefault才采用，并优先保留用户配置effort。
   Provider由原CLI环境与配置继续决定，aut不写model_provider覆盖，不读取或保存配置中的密钥。
4. 只有aut实例与bot配置完全为空时，默认工作目录为dataDir/workspace；已有bot复用其cwd。
   已有实例但无可复用bot时，使用显式bootstrap工作目录或daemon当前工作目录，不切换用户项目。
   探测有总超时与Scope资源清理，默认预算30秒，可显式缩短。当前机器的只读冷启动实测
   initialize约24.1秒、config/read约2.5秒、model/list约0.14秒，原5秒预算不足；
   此预算仅作用于首次配置发现，不修改Jev分类节点的1.5秒预算。缺CLI、模型不明确或不支持的实例返回needsConfiguration，API仍可用于设置。
   不虚构模型、不创建带占位模型的bot，也不因初始化失败改写原配置。
   ensure与Administration配置变更共用ConfigStore.withMutation工作流锁；锁内检查跨config/bots引用，
   再用updateBots/updateConfig写入，防止旧快照覆盖新建系统bot。保存后的ensure在外层锁释放后
   由daemon Scope后台执行，避免重入，并让已成功的设置保存立即返回；其30秒探测预算不能
   拖住桌面普通API的10秒响应预算。关闭daemon会中断后台探测并释放子进程。
5. SystemBots.get是只读注册表；SlowBrain.escalate只同步调用SessionManager.register(new)，返回RegisteredExecution。
   Task.origin在创建事务内写为slow-brain与源decisionLogId，供HandoffBuilder模板化摘要。
   Chief沿用“我想想”模板与先完成登记日志、再activate的顺序，不等待真实worker。
6. 慢脑task走同一HandoffBuilder、原生问答与SessionReplyGate。用户后续send仍到同一task。
   propose_route沿用MCP身份/角色校验与Chief串行队列，不把提议当作已完成工作；普通bot仍不能使用。

## 验证

只读CLI 0.167.0探测的fixture仅保存model/provider/effort投影与唯一默认模型，不保存原始config、请求头、环境或凭据。
覆盖已有配置原样保留、缺一/两种系统角色、ID冲突、模型不明确与探测失败、重复ensure，以及三个下沉入口与提议授权。
