# ADR-0077：Bot 模型与运行参数的三栏选择

- 状态：已接受
- 日期：2026-11-26

## 背景

用户要求在 Bot 配置中一次完成 provider、模型、思考强度和速度选择，参考三栏布局，
不提供自定义模型输入。ADR-0076 的模型弹层和独立自由文本思考字段不能表达模型能力，
速度也未进入会话协议。

## 决策

1. 模型弹层按 provider、模型、运行参数三栏排列，搜索和刷新在顶部。点击模型后保持
   展开，右栏调整思考强度与速度，「完成」关闭弹层，Bot 的保存才持久化。
   移除自定义模型输入和外置思考字段；已有配置中的模型继续保留。
2. 模型目录增加可选 efforts / speeds（value、可选 label）与默认 speed，原有 effort
   表示默认思考值。只有原生协议实际公布并已实现传递的选项可供选择。未公布时显示
   「由模型决定」；已有未知值保留并标识当前设置，不能在刷新时悄悄改写。
   「自动」表示不显式覆盖原生设置。切换模型时使用新模型公布的默认值，清除旧模型参数。
   浏览 provider、搜索和迟到的发现响应不改变草稿选择。
3. ModelSelection 和 StartSessionInput 增加可选 speed 字符串，存储 adapter 所理解的
   速度选项值。daemon 原样传递；renderer/core 不按程序名字分支，按目录能力渲染。
4. Codex 0.171.0 投影 supportedReasoningEfforts 与 serviceTiers；存在附加速度档位时
   增加标准速度 default。每次 turn/start 通过 serviceTierForTurn 显式设置，覆盖恢复与
   fork 会话中的继承值；未指定时继续沿用原生配置。自定义 Provider 仍仅返回其已配置
   模型，不拿官方目录猜测其能力。
5. Claude Code 2.1.330 投影 supportedEffortLevels 和 supportsFastMode。支持快速模式
   的模型公布 default / fast；会话临时 settings 的 fastMode=false / true 实现覆盖，
   不修改原生配置文件。思考档位继续通过 --effort 传递。原生初始化探针验证开关状态，
   不把元数据验证称为模型付费回合验证。ACP 尚无已验证的速度目录，不合成速度选项。

## 理由与后果

Bot 保持唯一配置入口，选项与实际模型能力一致。速度影响执行行为，不能只做界面开关；
协议样本、模型读取、Bot 保存和 adapter 发送链路一起验收。旧配置无 speed 字段时行为不变。
本决策替代 ADR-0076 中的自定义模型输入，保留其已有接入、错误隔离和配置保护边界。
