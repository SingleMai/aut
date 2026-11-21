// Claude process lifecycle and stream-json line handling adapted from OpenMausBot (Apache-2.0),
// server/drivers/claude.ts and server/procs.ts, commit
// 738ec88472a3b888ff7b7793755d89da613ed301. The transport is owned by aut and uses Effect Scope.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { AdapterError, type JsonValue } from "@aut/protocol";
import { Deferred, Effect, Fiber, Queue, Runtime, type Scope } from "effect";

export type ClaudeTransportNotice =
  | { readonly kind: "line"; readonly line: string }
  | { readonly kind: "exit"; readonly code: number | null }
  | { readonly kind: "error"; readonly error: AdapterError };

export interface ClaudeProcessOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stopTimeoutMs?: number;
}

export interface ClaudeTransport {
  readonly notices: Queue.Dequeue<ClaudeTransportNotice>;
  readonly send: (message: JsonValue) => Effect.Effect<void, AdapterError>;
  readonly stop: Effect.Effect<void, AdapterError>;
}

export interface ClaudeTransportFactory {
  readonly open: (
    options: ClaudeProcessOptions,
  ) => Effect.Effect<ClaudeTransport, AdapterError, Scope.Scope>;
}

const failure = (message: string) => new AdapterError({ code: "TransportError", message });

export const NodeClaudeTransport: ClaudeTransportFactory = {
  open: (options) =>
    Effect.gen(function* () {
      const notices = yield* Queue.unbounded<ClaudeTransportNotice>();
      const lines = yield* Queue.unbounded<
        string | { readonly exit: number | null } | { readonly error: AdapterError }
      >();
      const runtime = yield* Effect.runtime<never>();
      const run = Runtime.runFork(runtime);
      const exited = yield* Deferred.make<number | null>();
      let dead = false;
      let buffer = "";

      const child = yield* Effect.try({
        try: () =>
          spawn(options.command, [...options.args], {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
          }),
        catch: (cause) => failure(`Unable to spawn Claude: ${String(cause)}`),
      });

      const publishError = (cause: unknown) => {
        const error = failure(String(cause));
        run(Queue.offer(lines, { error }));
      };
      const publishLines = (data: string) => {
        buffer += data;
        if (buffer.length > 32 * 1024 * 1024) {
          publishError("Claude stream frame exceeds 32 MiB");
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
      child.stdout.on("data", publishLines);
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
              yield* Deferred.succeed(exited, line.exit);
              yield* Queue.offer(notices, { kind: "exit", code: line.exit });
            } else yield* Queue.offer(notices, { kind: "error", error: line.error });
            return;
          }
          yield* Queue.offer(notices, { kind: "line", line });
        }),
      ).pipe(Effect.interruptible, Effect.forkScoped);

      const send = (message: JsonValue) =>
        Effect.async<void, AdapterError>((resume) => {
          if (dead || child.stdin.destroyed) {
            resume(
              Effect.fail(
                new AdapterError({ code: "ProcessExited", message: "Claude process is closed" }),
              ),
            );
            return;
          }
          child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
            resume(error ? Effect.fail(failure(error.message)) : Effect.void),
          );
        });

      const signal = (value: NodeJS.Signals) =>
        Effect.try({
          try: () => {
            if (!dead && child.pid) process.kill(-child.pid, value);
          },
          catch: (cause) => failure(`Unable to terminate Claude: ${String(cause)}`),
        }).pipe(Effect.catchAll((error) => (dead ? Effect.void : Effect.fail(error))));

      const stop = Effect.suspend(() =>
        dead
          ? Effect.void
          : signal("SIGTERM").pipe(
              Effect.zipRight(Deferred.await(exited).pipe(Effect.interruptible)),
              Effect.timeoutFail({
                duration: options.stopTimeoutMs ?? 2_000,
                onTimeout: () => failure("Claude did not exit after SIGTERM"),
              }),
              Effect.catchAll(() =>
                signal("SIGKILL").pipe(
                  Effect.zipRight(Deferred.await(exited).pipe(Effect.interruptible)),
                  Effect.timeoutFail({
                    duration: 5_000,
                    onTimeout: () => failure("Claude did not exit after SIGKILL"),
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
      return { notices, send, stop };
    }).pipe(Effect.uninterruptible),
};

function cleanupListeners(child: ChildProcessWithoutNullStreams): void {
  child.stdout.removeAllListeners();
  child.stdin.removeAllListeners();
  child.removeAllListeners();
}
