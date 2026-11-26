# ADR-0071：个人远程主机与应用内组网探针

- 状态：已接受（仅验证范围；生产接入尚未决定）
- 日期：2026-11-24

## 背景

用户希望办公室的 Mac Pro 常驻执行 Agent，随身 Mac Air 负责主会话、回答问题和验收成果。
Air 合盖或切换网络不应停止 Pro 已接收的任务。用户不亲自修改代码，并接受适用的 Tailscale 服务费用。
现有 Clash Verge TUN 需要继续工作。

现行 daemon API 与桌面客户端只支持本机连接（ADR-0021、ADR-0025）。Tailscale 官方 `tsnet`
支持在进程内接收和发起连接，无需配置系统 TUN；这一能力适合先做隔离验证。
公开实现只提供线索，不能替代当前 macOS、Clash 和 aut 链路的实测。

## 决策

1. 验证拓扑为一个常驻主机和远程客户端。主机拥有唯一的 chief、主会话、任务、Bot 记忆和工作目录。
   客户端断线不关闭主机上的执行资源，也不自动转为本机执行。
2. 在 `spikes/remote/` 增加独立的 `tsnet` 传输探针。Go 只用于探测其原生库和网络传输，
   不进入生产构建、不承载 aut 业务逻辑；不改变 ADR-0009 的 TypeScript / Effect 技术栈。
3. 探针使用独立状态目录、合成文件和合成任务。不得读取真实主会话、Provider 密钥、
   `~/.aut/daemon-token` 或发布现有 daemon；不得修改 Clash、系统路由、DNS 或睡眠设置。
4. 分开记录本机隔离网络、真实 Tailscale 服务和 Air / Pro 双机的证据。
   HTTP、WebSocket、文件、预览、断开后继续运行与重连须分别验证。
   合成任务继续运行不构成真实 harness 生命周期验收；同机重连不构成换 Wi-Fi / 合盖验收。
5. 官方服务登录、真实节点注册和另一台设备操作需要可用的用户身份及设备入口。
   缺失时先完成独立于这些条件的探针，并将相应场景标记为待验证。
6. 在双机证据充分前，不确定生产 helper 进程协议、设备配对授权、客户端凭据管理、
   远端成果缓存及预览转发接口。这些变更须通过后续 ADR、共享 Schema 和生产链路测试落实。

## 理由

两端均使用应用内传输，可以避免新增整机 TUN 的路由配置竞争；其底层出站仍经过主机网络，
与 Clash 的实际共存情况、直连 / 中继质量和跨网络恢复必须实测。独立探针能验证这一假设，
同时保留当前本机版的运行与安全边界。

## 后果

当前产品继续遵循本地 API 与桌面连接规范。探针入口、固定依赖、原始结果和未覆盖场景统一维护在
[`spikes/remote/README.md`](../../spikes/remote/README.md)。通过传输验证后，再决定是否引入需要
单独打包、签名和管理登录状态的连接组件。

参考：

- [官方 tsnet API](https://github.com/tailscale/tailscale/tree/main/tsnet)：用户态的 Listen、Dial 与独立状态。
- [T3 Code 远程边界](https://github.com/pingdotgg/t3code/blob/main/docs/internals/05_remote.md)：执行环境身份独立于连接路径。
- [Caddy Tailscale 插件](https://github.com/tailscale/caddy-tailscale)：内嵌监听与出站代理，项目标注为实验性。
- [Mihomo Tailscale 出站](https://github.com/MetaCubeX/Meta-Docs/blob/main/docs/config/proxies/tailscale.md)：现有 Clash 的另一种候选接入方式，非本次默认修改项。
