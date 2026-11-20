# ADR-0025：Electron 桌面客户端与进程边界

- 状态：已接受。窗口渲染技术已由 [ADR-0044](0044-desktop-react-renderer.md) 更新。
- 日期：2026-11-16

## 决策

- Electron + TypeScript 原生 DOM 视图；esbuild 打包 renderer/preload，@electron/packager 生成 macOS .app。
  中文文案集中到 i18n 表；renderer 只缓存 API 视图数据，不执行 chief、任务转移、问题回答推断或模型调用。
- main 先连接 `127.0.0.1` daemon；仅连接明确 ECONNREFUSED 时以 child_process 启动编译入口。
  token 缺失、鉴权失败、协议不兼容分别报错，不反复启动。已有 daemon/token/provider 配置保持原样。
  开发时使用 Node 24；打包后使用 Electron 的 ELECTRON_RUN_AS_NODE 运行独立 ESM daemon bundle（附带同目录 MCP stdio bundle，保留 import.meta.url 相对定位），验证 node:sqlite 可用。
  子进程 detached，关闭 UI 不停止 daemon；daemon 自己持有数据目录锁与恢复职责。
- BrowserWindow 开启 contextIsolation 与 sandbox，关闭 nodeIntegration；preload 仅提供已允许路由的 request、
  连接状态和通知订阅 IPC。token 留在 main，不传 renderer，不放 URL/log；main 验证发送窗口及 IPC Schema。
  页面禁止外部导航/新窗口，CSP 限制本地脚本；用户文本按原文呈现；worker 正文的安全 Markdown 展示见 ADR-0040，不执行原始 HTML。
- WebSocket 在 main 连接并验证 DaemonEvent，renderer 收到 changed 后回读对应 API；重连重新读取快照。
- 所有问题按 requestId 获取完整题组，一次提交非空整组答案；澄清卡只提交 cardId/optionId，不能自动回答。
  引用回复提交原始文本和引用消息 ID；持久化顺序由 daemon 保证。
- 消息完整报告通过 `GET /v1/reports/:ref` 读取不可变回包，任务 panel 的“最近完整报告”才读取 Task.lastReport。
- 路由试验使用独立 daemon API，只展示各 bot 概率，不执行任务、不写主会话；分类调用与决策日志由 daemon 负责。
  密钥通过专用写入 API 保存，仅返回引用/配置状态；普通 config.json 仅保存 apiKeyRef。
  设置界面明确提醒所选服务会接收发送给它的用户内容。

## 后果

客户端可以独立打包，业务实现继续集中在 daemon。开发预览通过受限本地代理复用相同 renderer 与真实 API，
用于浏览器交互 QA；代理不进入产品 bundle，不向 renderer 暴露 token。端到端验收仍需真实 Electron 与 daemon。
