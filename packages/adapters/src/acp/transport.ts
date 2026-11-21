// ACP process and JSON-RPC request routing adapted from OpenMausBot (Apache-2.0),
// server/drivers/acp/host.ts and server/procs.ts, commit
// 738ec88472a3b888ff7b7793755d89da613ed301. The process remains owned by aut.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { AdapterError, type JsonValue } from "@aut/protocol";
import { Deferred, Effect, Fiber, Queue, Runtime, type Scope } from "effect";
import { decodeLine, type RpcMessage } from "./wire.js";

export type AcpTransportNotice =
  | { readonly kind: "message"; readonly message: RpcMessage }
  | { readonly kind: "exit"; readonly code: number | null }
  | { readonly kind: "error"; readonly error: AdapterError };

export interface AcpProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly rpcTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

export interface AcpTransport {
  readonly notices: Queue.Dequeue<AcpTransportNotice>;
  readonly request: (method: string, params: JsonValue) => Effect.Effect<JsonValue, AdapterError>;
  readonly send: (message: RpcMessage) => Effect.Effect<void, AdapterError>;
  readonly stop: Effect.Effect<void, AdapterError>;
}

export interface AcpTransportFactory {
  readonly open: (
    options: AcpProcessOptions,
  ) => Effect.Effect<AcpTransport, AdapterError, Scope.Scope>;
}

const failure = (message: string) => new AdapterError({ code: "TransportError", message });

export const NodeAcpTransport: AcpTransportFactory = {
  open: (options) =>
    Effect.gen(function* () {
      const notices = yield* Queue.unbounded<AcpTransportNotice>();
      const lines = yield* Queue.unbounded<
        string | { readonly exit: number | null } | { readonly error: AdapterError }
      >();
      const runtime = yield* Effect.runtime<never>();
      const run = Runtime.runFork(runtime);
      const exited = yield* Deferred.make<number | null>();
      const pending = new Map<number, Deferred.Deferred<JsonValue, AdapterError>>();
      let serial = 0;
      let dead = false;
      let buffer = "";

      const failAll = (error: AdapterError) =>
        Effect.gen(function* () {
          for (const deferred of pending.values()) yield* Deferred.fail(deferred, error);
          pending.clear();
        });

      const child = yield* Effect.try({
        try: () =>
          spawn(options.command, [...options.args], {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          }),
        catch: (cause) => failure(`Unable to spawn ACP agent: ${String(cause)}`),
      });

      const publishError = (cause: unknown) => {
        const error = failure(String(cause));
        run(Queue.offer(lines, { error }));
      };
      const onData = (data: string) => {
        buffer += data;
        if (buffer.length > 32 * 1024 * 1024) {
          publishError("ACP frame exceeds 32 MiB");
          buffer = "";
          return;
        }
        const complete = buffer.split("\n");
        buffer = complete.pop() ?? "";
        run(
          Queue.offerAll(
            lines,
            complete.filter((line) => line.trim().length > 0),
          ),
        );
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", onData);
      child.stderr.resume();
      child.on("error", publishError);
      child.stdin.on("error", publishError);
      child.on("close", (code) => {
        dead = true;
        run(Queue.offer(lines, { exit: code }));
      });

      const reader = yield* Effect.forever(
        Effect.gen(function* () {
          const line = yield* Queue.take(lines);
          if (typeof line !== "string") {
            if ("exit" in line) {
              yield* failAll(
                new AdapterError({ code: "ProcessExited", message: "ACP agent process exited" }),
              );
              yield* Deferred.succeed(exited, line.exit);
              yield* Queue.offer(notices, { kind: "exit", code: line.exit });
            } else {
              yield* failAll(line.error);
              yield* Queue.offer(notices, { kind: "error", error: line.error });
            }
            return;
          }
          const decoded = yield* Effect.either(decodeLine(line));
          if (decoded._tag === "Left") {
            yield* failAll(decoded.left);
            yield* Queue.offer(notices, { kind: "error", error: decoded.left });
            return;
          }
          const message = decoded.right;
          if (typeof message.id === "number" && message.method === undefined) {
            const waiter = pending.get(message.id);
            if (!waiter) return;
            pending.delete(message.id);
            if (message.error) {
              yield* Deferred.fail(
                waiter,
                new AdapterError({
                  code: "ProtocolError",
                  message: message.error.message,
                  detail: { rpcCode: message.error.code },
                }),
              );
            } else if (message.result !== undefined) {
              yield* Deferred.succeed(waiter, message.result);
            } else {
              yield* Deferred.fail(waiter, failure("ACP response has neither result nor error"));
            }
          } else yield* Queue.offer(notices, { kind: "message", message });
        }),
      ).pipe(Effect.interruptible, Effect.forkScoped);

      const send = (message: RpcMessage) =>
        Effect.async<void, AdapterError>((resume) => {
          if (dead || child.stdin.destroyed) {
            resume(
              Effect.fail(
                new AdapterError({ code: "ProcessExited", message: "ACP agent is closed" }),
              ),
            );
            return;
          }
          child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
            resume(error ? Effect.fail(failure(error.message)) : Effect.void),
          );
        });

      const request = (method: string, params: JsonValue) =>
        Effect.gen(function* () {
          const id = ++serial;
          const deferred = yield* Deferred.make<JsonValue, AdapterError>();
          pending.set(id, deferred);
          return yield* send({ id, method, params }).pipe(
            Effect.zipRight(Deferred.await(deferred)),
            Effect.timeoutFail({
              duration: options.rpcTimeoutMs ?? 300_000,
              onTimeout: () => failure(`ACP ${method} timed out`),
            }),
            Effect.ensuring(Effect.sync(() => pending.delete(id))),
          );
        });

      const signal = (value: NodeJS.Signals) =>
        Effect.try({
          try: () => {
            if (!dead && child.pid) process.kill(-child.pid, value);
          },
          catch: (cause) => failure(`Unable to terminate ACP agent: ${String(cause)}`),
        }).pipe(Effect.catchAll((error) => (dead ? Effect.void : Effect.fail(error))));

      const stop = Effect.suspend(() =>
        dead
          ? Effect.void
          : signal("SIGTERM").pipe(
              Effect.zipRight(Deferred.await(exited).pipe(Effect.interruptible)),
              Effect.timeoutFail({
                duration: options.stopTimeoutMs ?? 2_000,
                onTimeout: () => failure("ACP agent did not exit after SIGTERM"),
              }),
              Effect.catchAll(() =>
                signal("SIGKILL").pipe(
                  Effect.zipRight(Deferred.await(exited).pipe(Effect.interruptible)),
                  Effect.timeoutFail({
                    duration: 5_000,
                    onTimeout: () => failure("ACP agent did not exit after SIGKILL"),
                  }),
                ),
              ),
              Effect.asVoid,
            ),
      );

      yield* Effect.addFinalizer(() =>
        stop.pipe(
          Effect.catchAll((error) => Effect.logError(error.message)),
          Effect.ensuring(Fiber.interrupt(reader)),
          Effect.ensuring(Effect.sync(() => cleanupListeners(child))),
          Effect.ensuring(Queue.shutdown(lines)),
          Effect.ensuring(Queue.shutdown(notices)),
        ),
      );
      return { notices, request, send, stop };
    }).pipe(Effect.uninterruptible),
};

function cleanupListeners(child: ChildProcessWithoutNullStreams): void {
  child.stdout.removeAllListeners();
  child.stdin.removeAllListeners();
  child.removeAllListeners();
}
