import type { DesktopConnectionStatus, RemoteConnectionInfo } from "@aut/protocol";
import { Effect, Layer, PubSub, Stream } from "effect";
import type { DesktopNotice } from "./bridge.js";
import {
  type ConnectionOptions,
  DesktopConnection,
  DesktopConnectionLive,
  DesktopError,
} from "./connection.js";

// The window must be usable while a fresh Air discovers that no local CLI is installed.
// Local authentication/startup policy remains in DesktopConnectionLive.
export const DesktopShellConnectionLive = (options: ConnectionOptions) =>
  options.remote
    ? DesktopConnectionLive(options)
    : Layer.scoped(
        DesktopConnection,
        Effect.gen(function* () {
          const bus = yield* Effect.acquireRelease(
            PubSub.unbounded<DesktopNotice>(),
            PubSub.shutdown,
          );
          let current: typeof DesktopConnection.Service | undefined;
          let state: DesktopConnectionStatus = {
            mode: "local",
            name: "本机",
            phase: "connecting",
            canLogin: false,
          };
          const unavailable = () =>
            new DesktopError({
              code: "Startup",
              message: state.message ?? "本机服务正在启动。你可以先在设置中连接另一台主机。",
            });
          yield* Effect.gen(function* () {
            current = yield* DesktopConnection;
            yield* current.notices.pipe(
              Stream.runForEach((notice) =>
                Effect.gen(function* () {
                  if (notice.type === "connection") {
                    state = {
                      mode: "local",
                      name: "本机",
                      phase: notice.connected ? "connected" : "disconnected",
                      canLogin: false,
                    };
                    yield* PubSub.publish(bus, { type: "target", status: state });
                  }
                  yield* PubSub.publish(bus, notice);
                }),
              ),
            );
          }).pipe(
            Effect.provide(DesktopConnectionLive(options)),
            Effect.catchAll((error) =>
              Effect.gen(function* () {
                state = {
                  mode: "local",
                  name: "本机",
                  phase: "error",
                  canLogin: false,
                  message: error.message,
                };
                yield* PubSub.publish(bus, { type: "target", status: state });
                yield* PubSub.publish(bus, { type: "connection", connected: false });
              }),
            ),
            Effect.forkScoped,
          );
          return {
            status: Effect.suspend(() => (current ? current.status : Effect.succeed(state))),
            notices: Stream.fromPubSub(bus),
            loginUrl: Effect.succeed(undefined),
            exportConnection: Effect.suspend(
              (): Effect.Effect<RemoteConnectionInfo, DesktopError> =>
                current ? current.exportConnection : Effect.fail(unavailable()),
            ),
            request: (input) =>
              Effect.suspend(() => (current ? current.request(input) : Effect.fail(unavailable()))),
          };
        }),
      );
