import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  DaemonEvent,
  type DesktopConnectionStatus,
  HealthResponse,
  RemoteConnectionInfo,
} from "@aut/protocol";
import { RemoteTransportLive } from "@aut/transport";
import { Context, Effect, Layer, PubSub, Schedule, Schema, Stream } from "effect";
import { ApiRequest, type ApiResult, type DesktopNotice } from "./bridge.js";
import { daemonResponses, requestInit } from "./daemon-response.js";
import { type DesktopError, desktopError } from "./desktop-error.js";
import { remoteConnection } from "./remote-connection.js";

export { DesktopError } from "./desktop-error.js";

export interface ConnectionOptions {
  readonly dataDirectory?: string;
  readonly port?: number;
  readonly daemonEntry: string;
  readonly executable: string;
  readonly electronNode?: boolean;
  readonly transportBinary?: string;
  readonly remote?: RemoteConnectionInfo;
  readonly transportDirectory?: string;
}
export class DesktopConnection extends Context.Tag("aut/DesktopConnection")<
  DesktopConnection,
  {
    readonly request: (input: ApiRequest) => Effect.Effect<ApiResult, DesktopError>;
    readonly notices: Stream.Stream<DesktopNotice>;
    readonly status: Effect.Effect<DesktopConnectionStatus>;
    readonly loginUrl: Effect.Effect<string | undefined, DesktopError>;
    readonly exportConnection: Effect.Effect<RemoteConnectionInfo, DesktopError>;
  }
>() {}
const { decode, json, readResult } = daemonResponses({
  invalidJson: "本地服务返回无效响应。",
  incompatible: "本地服务返回了不兼容的数据，请重新构建并重启服务。",
});

// LaunchServices can supply only system directories. Append user CLI locations for this child.
export const packagedDaemonPath = (inherited: string | undefined, userDirectory: string) =>
  [
    ...new Set([
      ...(inherited ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(delimiter).filter(Boolean),
      join(userDirectory, ".local", "bin"),
      join(userDirectory, ".opencode", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]),
  ].join(delimiter);

export const waitForDaemonStartup = (health: Effect.Effect<void, DesktopError>) =>
  health.pipe(
    Effect.retry({
      schedule: Schedule.spaced("100 millis"),
      while: (error) => error.code === "Unavailable",
    }),
    Effect.timeoutFail({
      duration: "60 seconds",
      onTimeout: () =>
        desktopError("Startup", "本地服务启动超时，请检查 Codex 安装与服务运行状态。"),
    }),
  );

export const LocalDesktopConnectionLive = (options: ConnectionOptions) =>
  Layer.scoped(
    DesktopConnection,
    Effect.gen(function* () {
      const directory = options.dataDirectory ?? join(homedir(), ".aut");
      const port = options.port ?? 4317;
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
        return yield* Effect.fail(desktopError("Configuration", "本地服务端口必须为 1–65535。"));
      const base = `http://127.0.0.1:${port}`;
      let token: string | undefined;
      const readToken = Effect.try({
        try: () => {
          const path = join(directory, "daemon-token");
          return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
        },
        catch: () => desktopError("Authentication", "无法读取本地服务凭据。"),
      });
      const fetchLocal = (path: string, init: RequestInit = {}) =>
        Effect.tryPromise({
          try: () =>
            fetch(base + path, {
              ...init,
              headers: {
                "content-type": "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
              },
              signal: AbortSignal.timeout(
                /^\/v1\/(?:tasks\/[^/?#]+\/session(?:\?|$)|mcp\/servers\/[^/?#]+\/(?:test|auth\/start)$)/.test(
                  path,
                )
                  ? 30_000
                  : 10_000,
              ),
              redirect: "error",
            }),
          catch: (error) =>
            desktopError(
              error instanceof Error &&
                "cause" in error &&
                typeof error.cause === "object" &&
                error.cause !== null &&
                "code" in error.cause &&
                error.cause.code === "ECONNREFUSED"
                ? "Unavailable"
                : "Transport",
              "无法连接本地服务，请检查服务端口与运行状态。",
            ),
        });
      const health = Effect.gen(function* () {
        token = yield* readToken;
        const response = yield* fetchLocal("/v1/health");
        if (response.status === 401)
          return yield* Effect.fail(
            desktopError(
              "Authentication",
              "本地服务鉴权失败；请确认数据目录与服务一致，现有凭据未被修改。",
            ),
          );
        if (!response.ok)
          return yield* Effect.fail(
            desktopError("Protocol", "此端口的服务不是兼容的 aut daemon。"),
          );
        yield* decode(HealthResponse, yield* json(response));
        if (!token || !/^[0-9a-f]{64}$/.test(token))
          return yield* Effect.fail(desktopError("Authentication", "本地服务凭据缺失或格式错误。"));
      });
      yield* health.pipe(
        Effect.catchIf(
          (error) => error.code === "Unavailable",
          () =>
            Effect.gen(function* () {
              yield* Effect.try({
                try: () => {
                  if (!existsSync(options.daemonEntry)) return false;
                  const child = spawn(options.executable, [options.daemonEntry], {
                    detached: true,
                    stdio: "ignore",
                    env: {
                      ...process.env,
                      AUT_DATA_DIR: directory,
                      AUT_PORT: String(port),
                      ...(options.transportBinary
                        ? { AUT_TRANSPORT_BINARY: options.transportBinary }
                        : {}),
                      ...(options.electronNode
                        ? {
                            ELECTRON_RUN_AS_NODE: "1",
                            PATH: packagedDaemonPath(process.env.PATH, homedir()),
                          }
                        : {}),
                    },
                  });
                  child.on("error", () => {});
                  child.unref();
                  return true;
                },
                catch: () => desktopError("Startup", "无法启动本地服务。"),
              }).pipe(
                Effect.filterOrFail(Boolean, () =>
                  desktopError("Startup", "缺少 daemon 构建产物，请先运行 pnpm build。"),
                ),
              );
              yield* waitForDaemonStartup(health);
            }),
        ),
      );
      const bus = yield* Effect.acquireRelease(PubSub.unbounded<DesktopNotice>(), PubSub.shutdown);
      let connected = false;
      const listen = Effect.acquireUseRelease(
        Effect.sync(
          () => new WebSocket(`ws://127.0.0.1:${port}/v1/events`, ["aut", `aut-token.${token}`]),
        ),
        (socket) =>
          Effect.async<void, DesktopError>((resume) => {
            const opened = () => {
              connected = true;
              Effect.runFork(PubSub.publish(bus, { type: "connection", connected: true }));
            };
            const message = (event: MessageEvent) =>
              Effect.runFork(
                decode(Schema.parseJson(DaemonEvent), String(event.data)).pipe(
                  Effect.flatMap((notice) => PubSub.publish(bus, notice)),
                  Effect.catchAll(() => Effect.void),
                ),
              );
            const closed = () => {
              connected = false;
              Effect.runFork(PubSub.publish(bus, { type: "connection", connected: false }));
              resume(Effect.fail(desktopError("Disconnected", "本地服务连接已断开。")));
            };
            socket.addEventListener("open", opened);
            socket.addEventListener("message", message);
            socket.addEventListener("close", closed);
            socket.addEventListener("error", closed);
            return Effect.sync(() => {
              socket.removeEventListener("open", opened);
              socket.removeEventListener("message", message);
              socket.removeEventListener("close", closed);
              socket.removeEventListener("error", closed);
            });
          }),
        (socket) => Effect.sync(() => socket.close()),
      );
      yield* listen.pipe(Effect.retry(Schedule.spaced("1 second")), Effect.forkScoped);
      return {
        status: Effect.sync(() => ({
          mode: "local" as const,
          name: "本机",
          phase: connected ? ("connected" as const) : ("connecting" as const),
          canLogin: false,
        })),
        loginUrl: Effect.succeed(undefined),
        exportConnection: Effect.gen(function* () {
          const response = yield* fetchLocal("/v1/remote/connection", { method: "POST" });
          if (!response.ok)
            return yield* Effect.fail(desktopError("Remote", "请先开启远程主机并完成登录。"));
          return yield* decode(RemoteConnectionInfo, yield* json(response, "无效的连接信息。"));
        }),
        request: (input) =>
          Effect.gen(function* () {
            const checked = yield* decode(ApiRequest, input);
            const response = yield* fetchLocal(checked.path, requestInit(checked));
            return yield* readResult(response);
          }),
        notices: Stream.fromPubSub(bus),
      };
    }),
  );

export const DesktopConnectionLive = (options: ConnectionOptions) =>
  options.remote
    ? Layer.scoped(
        DesktopConnection,
        remoteConnection(
          options.remote,
          options.transportDirectory ?? join(homedir(), ".aut-desktop-transport"),
        ),
      ).pipe(Layer.provide(RemoteTransportLive(options.transportBinary)))
    : LocalDesktopConnectionLive(options);
