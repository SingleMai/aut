import {
  DaemonEvent,
  type DesktopConnectionStatus,
  HealthResponse,
  RemoteConnectionInfo,
  RemoteIdentity,
} from "@aut/protocol";
import { RemoteTransport } from "@aut/transport";
import { Deferred, Effect, PubSub, Schedule, Schema, Stream } from "effect";
import { WebSocket } from "ws";
import { ApiRequest, type DesktopNotice } from "./bridge.js";
import { daemonResponses, requestInit } from "./daemon-response.js";
import { type DesktopError, desktopError } from "./desktop-error.js";

const { decode, json, readResult } = daemonResponses({
  invalidJson: "主机响应无效。",
  incompatible: "主机返回了不兼容的数据，请更新两端 aut。",
});

// Building this service never waits for a network or starts a local daemon.
export const remoteConnection = (input: RemoteConnectionInfo, directory: string) =>
  Effect.gen(function* () {
    const profile = yield* decode(RemoteConnectionInfo, input);
    const transport = yield* RemoteTransport;
    const bus = yield* Effect.acquireRelease(PubSub.unbounded<DesktopNotice>(), PubSub.shutdown);
    let base: string | undefined;
    let generation = 0;
    let verified = false;
    let loginUrl: string | undefined;
    let state: DesktopConnectionStatus = {
      mode: "remote",
      name: profile.name,
      phase: "connecting",
      canLogin: false,
    };
    const update = (phase: DesktopConnectionStatus["phase"], message?: string) =>
      Effect.gen(function* () {
        const wasConnected = state.phase === "connected";
        state = {
          mode: "remote",
          name: profile.name,
          phase,
          canLogin: !!loginUrl,
          ...(message ? { message } : {}),
        };
        yield* PubSub.publish(bus, { type: "target", status: state });
        if (wasConnected !== (phase === "connected"))
          yield* PubSub.publish(bus, { type: "connection", connected: phase === "connected" });
      });
    const fetchRemote = (endpoint: string, path: string, init: RequestInit = {}) =>
      Effect.tryPromise({
        try: (signal) =>
          fetch(endpoint + path, {
            ...init,
            redirect: "error",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${profile.token}`,
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          }),
        catch: () =>
          desktopError(
            "Disconnected",
            "暂时无法连接执行主机。已接收的任务仍由主机处理，请稍后重试。",
          ),
      });
    const health = (endpoint: string) =>
      Effect.gen(function* () {
        const response = yield* fetchRemote(endpoint, "/v1/health");
        if (response.status === 401)
          return yield* Effect.fail(
            desktopError("Authentication", "连接信息已失效，请从 Pro 重新复制。"),
          );
        if (!response.ok) return yield* Effect.fail(desktopError("Protocol", "执行主机不可用。"));
        yield* decode(HealthResponse, yield* json(response));
        const identityResponse = yield* fetchRemote(endpoint, "/v1/remote/identity");
        if (!identityResponse.ok)
          return yield* Effect.fail(
            desktopError("Identity", "无法验证执行主机身份，请更新 Pro 上的 aut。"),
          );
        const identity = yield* decode(RemoteIdentity, yield* json(identityResponse));
        if (identity.hostId !== profile.hostId)
          return yield* Effect.fail(
            desktopError("Identity", "执行主机身份与连接信息不符，请重新配对。"),
          );
      }).pipe(
        Effect.timeoutFail({
          duration: "10 seconds",
          onTimeout: () => desktopError("Disconnected", "执行主机暂时离线，正在重连。"),
        }),
      );

    yield* transport
      .run({ version: 1, mode: "client", directory, peerNodeId: profile.nodeId }, (event) =>
        Effect.gen(function* () {
          generation++;
          verified = false;
          if (event.type === "login") {
            base = undefined;
            loginUrl = event.url;
            yield* update("login", "请登录与 Pro 相同的 Tailscale 账户和网络。");
          } else if (event.type === "ready") {
            loginUrl = undefined;
            base = `http://127.0.0.1:${event.port}`;
            yield* update("connecting");
          } else {
            base = undefined;
            yield* update("error", "远程连接中断，正在重试。");
          }
        }),
      )
      .pipe(
        Effect.tapError((error) =>
          Effect.gen(function* () {
            generation++;
            base = undefined;
            verified = false;
            loginUrl = undefined;
            yield* update("error", error.message);
          }),
        ),
        Effect.retry(Schedule.spaced("3 seconds")),
        Effect.forkScoped,
      );

    const session = Effect.scoped(
      Effect.gen(function* () {
        const endpoint = base;
        const currentGeneration = generation;
        if (!endpoint) return yield* Effect.fail(desktopError("Waiting", "等待远程连接。"));
        yield* health(endpoint);
        if (base !== endpoint || currentGeneration !== generation)
          return yield* Effect.fail(desktopError("Waiting", "连接已更新。"));
        verified = true;
        const opened = yield* Deferred.make<void>();
        const socket = yield* Effect.acquireRelease(
          Effect.try({
            try: () => {
              const socket = new WebSocket(`${endpoint.replace("http:", "ws:")}/v1/events`, [
                "aut",
                `aut-token.${profile.token}`,
              ]);
              // A connecting socket can report an error after its scoped listeners detach.
              socket.on("error", () => {});
              return socket;
            },
            catch: () => desktopError("Disconnected", "无法连接实时状态。"),
          }),
          (socket) =>
            Effect.sync(() => {
              verified = false;
              socket.terminate();
            }),
        );
        const listen = Effect.async<never, DesktopError>((resume) => {
          const open = () => {
            if (currentGeneration !== generation) {
              socket.terminate();
              return;
            }
            return Effect.runFork(
              Deferred.succeed(opened, undefined).pipe(Effect.zipRight(update("connected"))),
            );
          };
          const message = (event: WebSocket.MessageEvent) =>
            currentGeneration === generation &&
            Effect.runFork(
              decode(Schema.parseJson(DaemonEvent), String(event.data)).pipe(
                Effect.flatMap((value) => PubSub.publish(bus, value)),
                Effect.ignore,
              ),
            );
          const close = () =>
            resume(Effect.fail(desktopError("Disconnected", "与执行主机的连接已断开，正在重连。")));
          socket.addEventListener("open", open);
          socket.addEventListener("message", message);
          socket.addEventListener("close", close);
          socket.addEventListener("error", close);
          return Effect.sync(() => {
            socket.removeEventListener("open", open);
            socket.removeEventListener("message", message);
            socket.removeEventListener("close", close);
            socket.removeEventListener("error", close);
          });
        });
        const heartbeat = Effect.async<void, DesktopError>((resume) => {
          const pong = () => resume(Effect.void);
          socket.once("pong", pong);
          socket.ping(undefined, undefined, (error) => {
            if (error)
              resume(Effect.fail(desktopError("Disconnected", "实时连接中断，正在重连。")));
          });
          return Effect.sync(() => socket.off("pong", pong));
        }).pipe(
          Effect.timeoutFail({
            duration: "10 seconds",
            onTimeout: () => desktopError("Disconnected", "实时连接无响应，正在重连。"),
          }),
        );
        const monitor = Deferred.await(opened).pipe(
          Effect.timeoutFail({
            duration: "10 seconds",
            onTimeout: () => desktopError("Disconnected", "实时连接超时，正在重试。"),
          }),
          Effect.zipRight(
            Effect.forever(
              Effect.sleep("5 seconds").pipe(
                Effect.zipRight(
                  Effect.suspend(() =>
                    base === endpoint && currentGeneration === generation
                      ? Effect.all([health(endpoint), heartbeat], { concurrency: "unbounded" })
                      : Effect.fail(desktopError("Waiting", "连接已更新。")),
                  ),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.raceFirst(listen, monitor);
      }),
    );
    yield* session.pipe(
      Effect.tapError((error) =>
        Effect.gen(function* () {
          verified = false;
          if (error.code !== "Waiting" && base && !loginUrl)
            yield* update(error.code === "Disconnected" ? "disconnected" : "error", error.message);
        }),
      ),
      Effect.retry(Schedule.spaced("2 seconds")),
      Effect.forkScoped,
    );
    return {
      status: Effect.sync(() => state),
      loginUrl: Effect.sync(() => loginUrl),
      exportConnection: Effect.fail(desktopError("Forbidden", "请在执行主机本机复制连接信息。")),
      notices: Stream.fromPubSub(bus),
      request: (input: ApiRequest) =>
        Effect.gen(function* () {
          const checked = yield* decode(ApiRequest, input);
          const endpoint = base;
          if (!endpoint || !verified || state.phase !== "connected")
            return yield* Effect.fail(
              desktopError("Disconnected", "执行主机尚未连接。草稿已保留，请在连接恢复后重试。"),
            );
          const response = yield* fetchRemote(endpoint, checked.path, requestInit(checked));
          return yield* readResult(response);
        }),
    };
  });
