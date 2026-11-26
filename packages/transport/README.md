# aut 远程传输组件

架构与权限边界见 [ADR-0072](../../docs/decisions/0072-personal-remote-host.md)。
此包由 Effect 进程服务和 Go/tsnet 网络程序组成，不实现任务、Provider 或主会话逻辑。

在 macOS 上运行 `node packages/transport/scripts/build-native.mjs` 构建当前架构的
`dist/native/aut-transport`、依赖版本清单和第三方许可证。可传输出目录和 `arm64` / `x64`。
桌面打包会自动执行这一步，将结果放入应用的 `Resources/transport/`。
构建需要 Go（工具链版本按 go.mod）；运行应用本身不需要安装 Go 或 Node。

从 `native/` 执行 `go test -race ./...` 和 `go vet ./...`；TypeScript 进程协议和清理测试
包含在仓库 Vitest 套件中。本地 control/DERP 测试服务不会连接用户账户。
完整应用的隔离原生检查见 [远程验收说明](../../spikes/remote/README.md#应用集成与原生验收)。
