# ADR-0073：电脑配对与设置分区

- 状态：已接受
- 日期：2026-11-25

## 背景

ADR-0072 的首版界面直接展示连接 JSON 输入框，且把连接其他电脑、共享本机、执行器和
分类器堆在同一长表单。用户无法判断连接信息从哪里来，也难以确认设置作用于哪台电脑。

参考 t3code 的独立添加环境弹窗、共享与访问设置，以及 VS Code、Zed 的电脑选择入口：

- [t3code 添加环境](https://github.com/pingdotgg/t3code/blob/dca3ab2025c15cfa5907757229be894cbc04cd80/apps/web/src/components/settings/AddEnvironmentDialog.tsx)
- [t3code 共享与访问](https://github.com/pingdotgg/t3code/blob/dca3ab2025c15cfa5907757229be894cbc04cd80/apps/web/src/components/settings/ConnectionsSettings.tsx)
- [VS Code Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels)
- [Zed Remote Development](https://zed.dev/docs/remote-development)

只参考交互结构，不复制第三方代码。

## 决策

1. 设置按「电脑与连接」「远程访问」「执行器」「消息路由」分区。远程访问只在本机模式
   可管理；执行器与路由显示所属执行电脑。分区切换保留未保存配置，校验失败定位相应分区。
2. 电脑与连接默认显示当前执行电脑、连接状态及下一步操作。添加电脑使用独立弹窗：
   说明如何在另一台电脑开启远程访问、复制连接码；本机粘贴后先显示识别出的电脑名称，
   用户再确认切换。格式有效不等同于已联网，登录和连接状态仍由实际组件返回。
3. 连接码为 `aut-connect:` 前缀加 base64url 编码的既有 `RemoteConnectionInfo` JSON。
   它不是短 PIN、一次性口令或可打开的网址；继续接受旧 JSON。其权限与轮换语义不变。
4. 默认通过主进程读取用户主动点击粘贴时的剪贴板。主进程校验并按窗口暂存凭据，
   renderer 只取得名称、主机 ID 和临时确认 ID；确认按此 ID 取回同一份凭据。
   手动粘贴备用入口只临时持有输入，提交识别后清空。取消、覆盖或关闭窗口清除暂存。
   不在普通状态、日志、错误或识别预览中返回密钥。仍在主进程直接复制、加密持久化。
5. 主机页面按开启、登录、复制三个阶段呈现，只突出当前所需动作。名称修改提供明确保存；
   更换连接码与关闭远程访问置于次级操作，执行前说明对现有连接的影响。
6. 执行器的命令参数、环境变量和认证 ID 收入高级设置，分类器的密钥引用同样按需展开。
   不改变已有配置内容、保存 API、业务逻辑或 ADR-0072 的网络架构。

## 后果与验收

连接码仍需从 Pro 传到 Air，两端仍需登录同一 Tailscale 网络；不引入设备自动发现、云账户
或短码交换服务。验证编码/旧格式、坏输入与无密钥回显、窗口暂存隔离与取消，以及设置
草稿跨分区保留、离线入口、字段错误定位、键盘操作和浅/深色界面。
