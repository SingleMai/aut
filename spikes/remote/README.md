# 个人远程主机传输探针

范围由 [ADR-0071](../../docs/decisions/0071-remote-host-transport-probe.md) 定义。本目录不是产品远程模式。
固定依赖为 Tailscale `v1.106.1`、Go `1.27.4`、WebSocket 库 `v1.8.15`；Go 可按模块声明自动获取工具链。

## 验证内容

链路为客户端本地 TCP 入口 → 客户端 `tsnet.Dial` → 主机 `tsnet.Listen` → 主机本地合成 HTTP 服务。
HTTP、WebSocket 升级和文件字节通过同一条传输，不调用模型，不读取真实 aut 数据。

`transport_test.go` 使用上游公开的 `testcontrol` / `RunDERPAndSTUN` 测试组件，在本机启动隔离控制面和中继。
节点握手和传输使用真实 tsnet。它不登录用户账户、不注册到官方服务；状态使用临时目录。
合成服务要求独立测试 token，匿名请求返回 401。

覆盖：

- 节点运行时没有新增系统网络接口。
- HTTP 请求、约 650 KB 二进制上传回传摘要、HTML 预览内容、WebSocket 双向消息。
- 客户端连接组件和 tsnet 节点关闭后，主机合成计数任务继续运行。
- 用原状态目录启动新客户端，节点公钥保持一致，四种传输重新通过。
- macOS 的网络接口、DNS、代理设置及公共地址路由在运行前后对比；结果只保存摘要，不保存 DNS / 代理原始配置。

本机测试不能证明公网直连或中继质量、Clash TUN 跨网络共存、双机合盖和换网恢复。
合成计数任务不是真实 harness；HTML 内容校验不是 Electron 浏览器预览验收。

## 本机复验

```sh
rtk proxy node spikes/remote/run.ts .artifacts/remote-probe-new/result.json
```

输出文件必须不存在。TypeScript 记录器使用 Effect 与 Schema 校验 Go 测试事件和证据结构；
只有全部预期场景通过才保存成功结果。网络前后观察变化时保留结果并以失败退出，需人工检查变化来源。

独立运行或检查 Go 代码：

```sh
rtk proxy go -C spikes/remote test -count=1 -timeout=120s ./...
rtk proxy go -C spikes/remote vet ./...
rtk proxy go -C spikes/remote build -o aut-remote-probe .
```

## 真实双机探针

当前这台设备为 Pro；Air 尚无开发或远程登录配置，两台处于同一局域网。
可以把预编译测试包复制到两台 Mac，双击 `Start.command`，分别选择主机和客户端。
操作说明见 [`使用说明.txt`](使用说明.txt)。无需用户修改代码或安装开发环境；
两端仍需在官方页面完成各自的测试节点登录。
启动器只对自身及子进程设置 `TS_BIND_TO_INTERFACE_BY_ROUTE=1`，让 tsnet 按目标地址的
系统路由选择网卡；这是当前探针对 Clash TUN / fake-IP 的兼容设置，不改变系统网络配置。

需要两台设备能够执行本探针、同一个可访问的 tailnet，以及适用的账户授权。
两端分别使用新建的专用状态目录；不要使用 `~/.aut/`、系统 Tailscale 或 Clash 的状态目录。
在两端终端设置相同的随机 `AUT_REMOTE_PROBE_TOKEN`（至少 32 字符），不要把它放进命令参数、仓库或结果文件。

办公室主机：

```sh
rtk proxy env TS_BIND_TO_INTERFACE_BY_ROUTE=1 go -C spikes/remote run . -mode serve -state-dir /absolute/probe-state/pro
```

首次运行会打印登录 URL，完成 Tailscale 登录与授权后会打印探针 IP。
服务只提供合成数据；不转发真实 daemon、任意本机端口、文件系统或 shell。
保持该进程运行，在另一台设备执行：

```sh
rtk proxy env TS_BIND_TO_INTERFACE_BY_ROUTE=1 go -C spikes/remote run . -mode check -state-dir /absolute/probe-state/air -peer PRO_TAILSCALE_IP
```

真实双机复验需要额外记录：两端 OS / Clash / Mihomo 版本、TUN 是否开启、普通代理访问是否仍正常、
两端退出和重启连接组件后的结果，以及 Air 换网和合盖期间 Pro 进程的连续性。
当前 `check` 是一次连通性检查，不实现桌面自动重连；重复运行不能伪装成自动重连验收。

主机进程用 Ctrl-C 退出。状态目录保留以复验身份；探针不自动修改或注销账户中的节点。
不需要保留时由测试者在 Tailscale 设备管理中移除这些测试节点，再删除专用状态目录。
命令行会拒绝继承已有 `TS_AUTHKEY` 等身份环境变量，且固定使用官方控制面；
本机测试则清空这些变量，并显式使用隔离控制面。状态目录检查会解析符号链接以保护 `~/.aut/`。

## macOS 测试包

修正后的测试包位于忽略提交的 `dist/aut-remote-probe-macos-v2.zip`，包括通用二进制、
`Start.command`、中文操作说明、本机证据与所链接模块的版权许可。
它没有 Developer ID 签名或公证，仅对通用二进制做本地 ad-hoc 签名。
已检查两种架构、签名完整性、当前 arm64 主机的启动入口和启动脚本语法；
Intel 版本仅完成交叉编译，尚无 Intel 设备运行证据。

二进制重建：

```sh
rtk proxy go -C spikes/remote build -trimpath -ldflags='-s -w' -o dist/aut-remote-probe-arm64 .
rtk proxy env GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go -C spikes/remote build -trimpath -ldflags='-s -w' -o dist/aut-remote-probe-amd64 .
```

用 macOS `lipo` 合并两种架构，再以 `codesign --sign -` 本地签名；
打包应保留启动脚本和二进制的可执行权限，不包含运行时状态或连接码。

## 证据

初始环境：macOS 26.7.2 arm64、Clash Verge 2.5.10，已安装的稳定内核为 Mihomo v1.19.33。
安装版本和进程存在不等于已确认当前 TUN 参数；后续结果按实际验证范围记录。

2026-11-25 本机证据见 [`results/local-macos-arm64.json`](results/local-macos-arm64.json)：
8 项传输检查全部通过，网络快照一致；到 `1.1.1.1` 的路由接口在前后均为 `utun4`，
没有新增系统接口。该记录不确认 `utun4` 归属，也不等同于完整路由表审计或真实换网共存验收。
另已通过生产状态目录保护测试（含符号链接）、Go 编译 / vet、记录器 TypeScript 严格类型检查及仓库依赖边界检查。
启用按系统路由选网卡后的复验记录为
[`results/local-system-route-macos-arm64.json`](results/local-system-route-macos-arm64.json)：
同样 8 项通过、网络快照一致；Schema v2 显式记录 `interfaceBinding: system-route`。
Pro 已完成真实账户登录并启动合成服务；Air 首轮双机检查与换网指引后的复验均为四项通过，
详见下方用户提供的结果及其覆盖边界。

### 官方登录前连接与 Clash TUN

2026-11-25 在 Pro 上，原设置启动后停在 `NeedsLogin`，到官方控制面的连接持续为 `SYN_SENT`。
该域名在本机解析为 fake-IP 地址，系统路由指向 `utun4`；普通 HTTPS 请求按系统路由可获得 200。
固定版本上游 `net/netns/netns_darwin.go` 默认绑定默认网卡，而非按目标地址路由选网卡。

仅为探针进程设置 `TS_BIND_TO_INTERFACE_BY_ROUTE=1` 后，沿用同一独立节点目录，
在约 5 秒内获得官方登录 URL。该次启动显式移除了代理环境变量，确认结果不依赖 Agent 自带的 HTTP 代理。
登录 URL 和测试连接码不写入证据文件。首轮临时探针在等待账户登录三分钟后按超时退出。
随后用户从修正后的启动器重新运行并完成 Pro 节点登录。观察到合成服务已经监听，
对本机合成服务执行带独立测试 token 的 `/probe/health` 请求，返回 200 和预期内容。
该服务仅在 `tsnet.Up` 成功后启动，因此已确认 Pro 节点上线及主机服务就绪。
该健康检查通过本机入口完成，不构成通过 tailnet 的双机传输、换网或真实 Agent 执行验收。

### Air → Pro 首轮真实双机传输

用户提供的 Air 终端输出见
[`results/air-pro-initial-2026-11-25.txt`](results/air-pro-initial-2026-11-25.txt)。
用户在旧版启动器前加 `TS_BIND_TO_INTERFACE_BY_ROUTE=1` 后，HTTP、文件回传、
HTML 内容和 WebSocket 四项检查均通过。此前设备位于同一局域网；该输出未单独记录当前网络元数据，
不能单凭首轮输出作为跨网络验收。

### Air 换网后的重新连接

在“切到手机热点、保持 Clash 日常 TUN 设置、重新运行同一命令”的指引后，
用户回贴了第二轮四项 PASS，原文见
[`results/air-pro-reconnect-2026-11-25.txt`](results/air-pro-reconnect-2026-11-25.txt)。
按会话上下文记录为换网后重新连接成功；本段输出没有独立的网络元数据。
由此支持继续设计办公室常驻 Pro 与随身 Air 的远程模式，但尚不构成生产功能验收。

仍需验证：普通代理访问是否受影响、直连或中继路径、延迟/吞吐、合盖、桌面自动重连、
断线后事件补读与消息去重，以及真实 aut / harness 任务、问题卡片和桌面成果交互。

## 应用集成与原生验收

生产接入见 [ADR-0072](../../docs/decisions/0072-personal-remote-host.md)。原来的探针仍只使用合成数据；
应用采用独立节点目录、稳定节点身份及单独远程凭据，不复用探针登录文件或测试连接码。

`packages/transport/native` 的 `go test -race ./...` 使用真实 tsnet 和本地 control/DERP 测试服务，
覆盖生产固定目标转发、节点身份、HTTP 字节、WebSocket、客户端退出与保留身份重连。
这不等价于公网 NAT、Clash 常规浏览、两台 Mac 的睡眠或真实 harness 任务验收。

构建桌面开发包后，在仓库根目录运行 `node spikes/remote/packaged-smoke.mjs`。
该脚本创建隔离数据和桌面配置，打开真实应用并连接其调试端口；不发模型任务、不会完成 Tailscale 账户配对。
它检查默认本机启动、内置 helper 的官方登录入口、原生 IPC、macOS 加密保存、切换请求、
关闭桌面后的 daemon 健康、远程离线设置，以及本机服务无法启动时的首次配对入口。
仅确认对话框返回值及重启触发器被替换；实际 IPC、加密、保存、退出和重新打开均使用应用代码。
结果见 `results/packaged-remote-smoke.json`。

正式双机复验：两端打开本次应用；Pro 设置中开启远程主机并登录；复制连接信息到 Air 的执行位置；
Air 登录相同网络。使用一项真实任务验证提交、原生提问与回答、成果预览；执行期间让 Air 换热点并合盖，
重开后确认原任务在 Pro 继续执行且没有重复提交。尚未执行的步骤不能记为通过。
