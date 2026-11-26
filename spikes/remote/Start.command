#!/bin/bash
# Interactive launcher for the isolated probe; no developer tools are required.
set -euo pipefail
umask 077

# Keep this userspace probe on the system route, including Clash TUN fake-IP routes.
# The setting affects only this launcher and its child process.
export TS_BIND_TO_INTERFACE_BY_ROUTE=1

finish() {
  probe_status=$?
  if [ "$probe_status" -ne 0 ]; then
    printf '\n测试未完成（退出码 %s），请保留上面的错误信息。\n' "$probe_status"
  fi
  read -r -p '按回车关闭窗口。' _ || true
}
trap finish EXIT

probe_bundle=$(cd -- "$(dirname -- "$0")" && pwd)
probe_state="$HOME/Library/Application Support/aut-remote-probe"
printf 'aut 双机连接测试（仅合成数据）\n\n'
printf '1 = 办公室 Pro（保持运行）\n2 = 随身 Air（检查连接）\n'
read -r -p '请选择 1 或 2：' probe_role

case "$probe_role" in
  1)
    mkdir -p "$probe_state"
    if [ ! -s "$probe_state/pro-token" ]; then
      /usr/bin/openssl rand -hex 24 > "$probe_state/pro-token"
    fi
    AUT_REMOTE_PROBE_TOKEN=$(cat "$probe_state/pro-token")
    export AUT_REMOTE_PROBE_TOKEN
    printf '\n在 Air 上输入这个测试连接码：\n%s\n\n' "$AUT_REMOTE_PROBE_TOKEN"
    printf '正在启动并连接 Tailscale，生成登录链接后会显示在下方。\n'
    printf '打开该链接登录；两台设备选择同一个账户和网络。\n'
    printf '登录后将显示 Pro 的测试 IP。保持此窗口开启，Ctrl-C 停止。\n\n'
    "$probe_bundle/aut-remote-probe" -mode serve -state-dir "$probe_state/pro-node"
    ;;
  2)
    read -r -p '输入 Pro 窗口显示的 Tailscale IP（不含 :8080）：' probe_peer
    read -r -s -p '粘贴 Pro 的测试连接码，再按回车（输入不显示）：' AUT_REMOTE_PROBE_TOKEN
    printf '\n\n'
    export AUT_REMOTE_PROBE_TOKEN
    printf '正在启动并连接 Tailscale。首次运行生成登录链接后，请选择与 Pro 相同的账户和网络。\n\n'
    "$probe_bundle/aut-remote-probe" -mode check -state-dir "$probe_state/air-node" -peer "$probe_peer"
    printf '\n本轮连接检查通过。换网后可重新运行；这只验证重新连接。\n'
    ;;
  *)
    printf '请输入 1 或 2。\n'
    exit 1
    ;;
esac
