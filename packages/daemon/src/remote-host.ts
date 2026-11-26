import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  type RemoteConnectionInfo,
  RemoteHostConfig,
  RemoteHostInput,
  type RemoteHostStatus,
  RemoteToken,
} from "@aut/protocol";
import { RemoteTransport, type TransportError } from "@aut/transport";
import { Context, Effect, Fiber, Layer, PubSub, Schedule, Schema, Scope, Stream } from "effect";
import { DaemonError, decode, io } from "./errors.js";
import { Ownership } from "./ownership.js";

const StoredHost = Schema.Struct({
  ...RemoteHostConfig.fields,
  token: Schema.optional(RemoteToken),
}).pipe(Schema.filter((value) => !value.enabled || value.token !== undefined));
export class RemoteHost extends Context.Tag("aut/RemoteHost")<
  RemoteHost,
  {
    readonly status: Effect.Effect<RemoteHostStatus>;
    readonly matches: (token: string | undefined) => boolean;
    readonly configure: (
      input: typeof RemoteHostInput.Type,
    ) => Effect.Effect<RemoteHostStatus, DaemonError>;
    readonly connection: Effect.Effect<RemoteConnectionInfo, DaemonError>;
    readonly start: (port: number) => Effect.Effect<void>;
    readonly revocations: Stream.Stream<void>;
  }
>() {}

export const RemoteHostLive = Layer.scoped(
  RemoteHost,
  Effect.gen(function* () {
    const owner = yield* Ownership;
    const transport = yield* RemoteTransport;
    const scope = yield* Scope.Scope;
    const path = join(owner.directory, "remote-host.private.json");
    const saved = yield* io("Could not read remote host settings", () =>
      existsSync(path) ? readFileSync(path, "utf8") : undefined,
    );
    let stored: typeof StoredHost.Type =
      saved === undefined
        ? { id: randomUUID(), name: hostname().slice(0, 80) || "我的 Mac", enabled: false }
        : yield* decode(Schema.parseJson(StoredHost), saved);
    const publicConfig = () => ({ id: stored.id, name: stored.name, enabled: stored.enabled });
    let state: RemoteHostStatus = {
      ...publicConfig(),
      state: stored.enabled ? "connecting" : "disabled",
    };
    let port: number | undefined;
    let worker: Fiber.RuntimeFiber<never, TransportError> | undefined;
    const lock = yield* Effect.makeSemaphore(1);
    const revoked = yield* Effect.acquireRelease(PubSub.unbounded<void>(), PubSub.shutdown);
    const restart = Effect.gen(function* () {
      if (worker) {
        yield* Fiber.interrupt(worker);
        worker = undefined;
      }
      state = { ...publicConfig(), state: stored.enabled ? "connecting" : "disabled" };
      if (!stored.enabled || port === undefined) return;
      const run = Effect.suspend(() => {
        state = { ...publicConfig(), state: "connecting" };
        return transport.run(
          {
            version: 1,
            mode: "host",
            directory: join(owner.directory, "transport-host"),
            localPort: port as number,
          },
          (event) =>
            Effect.sync(() => {
              if (event.type === "login")
                state = { ...publicConfig(), state: "login", loginUrl: event.url };
              if (event.type === "ready")
                state = { ...publicConfig(), state: "ready", nodeId: event.nodeId };
              if (event.type === "error")
                state = { ...publicConfig(), state: "error", message: "远程连接中断，正在重试。" };
            }),
        );
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            state = { ...publicConfig(), state: "error", message: error.message };
          }),
        ),
        Effect.retry(Schedule.spaced("3 seconds")),
      );
      worker = yield* Effect.forkIn(run, scope);
    });
    return {
      status: Effect.sync(() => state),
      matches: (token) =>
        stored.enabled &&
        stored.token !== undefined &&
        token !== undefined &&
        /^[0-9a-f]{64}$/.test(token) &&
        timingSafeEqual(Buffer.from(token), Buffer.from(stored.token)),
      configure: (input) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const checked = yield* decode(RemoteHostInput, input);
            const next: typeof StoredHost.Type = {
              id: stored.id,
              name: checked.name,
              enabled: checked.enabled,
              ...(checked.enabled
                ? {
                    token:
                      checked.rotate || !stored.token
                        ? randomBytes(32).toString("hex")
                        : stored.token,
                  }
                : {}),
            };
            const json = yield* Schema.encode(Schema.parseJson(StoredHost))(next).pipe(
              Effect.mapError(
                () =>
                  new DaemonError({ code: "Validation", message: "Invalid remote host settings" }),
              ),
            );
            yield* io("Could not save remote host settings", () => {
              const temporary = `${path}.${randomUUID()}.tmp`;
              try {
                writeFileSync(temporary, json, { mode: 0o600, flag: "wx" });
                renameSync(temporary, path);
              } finally {
                rmSync(temporary, { force: true });
              }
            });
            stored = next;
            yield* PubSub.publish(revoked, undefined);
            yield* restart;
            return state;
          }),
        ),
      connection: Effect.suspend(() =>
        state.state === "ready" && state.nodeId && stored.token
          ? Effect.succeed({
              version: 1 as const,
              hostId: stored.id,
              name: stored.name,
              nodeId: state.nodeId,
              token: stored.token,
            })
          : Effect.fail(new DaemonError({ code: "Conflict", message: "Remote host is not ready" })),
      ),
      start: (localPort) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            port = localPort;
            yield* restart;
          }),
        ),
      revocations: Stream.fromPubSub(revoked),
    };
  }),
);
