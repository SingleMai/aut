import { type ChildProcess, spawn } from "node:child_process";
import { TransportConfig, TransportEvent } from "@aut/protocol";
import { Context, Data, Effect, Either, Layer, Option, Queue, Runtime, Schema } from "effect";

export class TransportError extends Data.TaggedError("TransportError")<{
  readonly message: string;
}> {}
const failure = (message: string) => new TransportError({ message });
export const transportEnvironment = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "TMPDIR",
    "PATH",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ])
    if (source[key] !== undefined) env[key] = source[key];
  env.TS_BIND_TO_INTERFACE_BY_ROUTE = "1";
  env.TS_NO_LOGS_NO_SUPPORT = "true";
  return env;
};
export class RemoteTransport extends Context.Tag("aut/RemoteTransport")<
  RemoteTransport,
  {
    readonly run: (
      config: TransportConfig,
      receive: (event: TransportEvent) => Effect.Effect<void>,
    ) => Effect.Effect<never, TransportError>;
  }
>() {}

type HelperResult = Either.Either<TransportEvent, TransportError>;
const decodeEvent = Schema.decodeUnknownEither(Schema.parseJson(TransportEvent), {
  onExcessProperty: "error",
});

function spawnHelper(binary: string, publish: (result: HelperResult) => void) {
  const child = spawn(binary, [], {
    stdio: ["pipe", "pipe", "ignore"],
    env: transportEnvironment(process.env),
  });
  const fail = (message: string) => publish(Either.left(failure(message)));
  let pending = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    if (pending.length > 65536) {
      fail("远程连接组件返回的数据过大。");
      return;
    }
    let end = pending.indexOf("\n");
    while (end >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line)
        publish(decodeEvent(line).pipe(Either.mapLeft(() => failure("远程连接组件版本不兼容。"))));
      end = pending.indexOf("\n");
    }
  });
  child.once("error", () => fail("无法启动远程连接组件。"));
  // The last complete stdout event must reach the queue before the disconnect notice.
  child.once("close", () => fail("远程连接组件已退出，正在重新连接。"));
  child.stdin.on("error", () => fail("无法配置远程连接组件。"));
  return child;
}

function stopHelper(child: ChildProcess) {
  const running = () =>
    child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  return Effect.gen(function* () {
    if (!running()) return;
    const exited = Effect.async<void>((resume) => {
      const done = () => resume(Effect.void);
      if (!running()) return done();
      child.once("exit", done);
      return Effect.sync(() => {
        child.off("exit", done);
      });
    }).pipe(Effect.interruptible);
    child.kill("SIGTERM");
    // The scope masks interruption during cleanup. Only the exit wait may time out.
    const graceful = yield* exited.pipe(Effect.timeoutOption("3 seconds"));
    if (Option.isSome(graceful)) return;
    if (!child.kill("SIGKILL")) return;
    yield* exited.pipe(
      Effect.timeout("5 seconds"),
      Effect.catchTag("TimeoutException", () =>
        Effect.logError("Remote helper did not exit after SIGKILL."),
      ),
    );
  });
}

export const RemoteTransportLive = (binary?: string) =>
  Layer.succeed(RemoteTransport, {
    run: (config, receive) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (!binary)
            return yield* Effect.fail(failure("未找到远程连接组件，请使用完整的 aut 应用。"));
          const input = yield* Schema.encode(Schema.parseJson(TransportConfig))(config).pipe(
            Effect.mapError(() => failure("远程连接配置无效。")),
          );
          const events = yield* Effect.acquireRelease(
            Queue.unbounded<HelperResult>(),
            Queue.shutdown,
          );
          const runtime = yield* Effect.runtime<never>();
          const run = Runtime.runFork(runtime);
          const child = yield* Effect.acquireRelease(
            Effect.try({
              try: () => spawnHelper(binary, (result) => run(Queue.offer(events, result))),
              catch: () => failure("无法启动远程连接组件。"),
            }),
            stopHelper,
          );
          child.stdin.write(`${input}\n`);
          return yield* Effect.forever(
            Queue.take(events).pipe(
              Effect.flatMap((event) =>
                Either.match(event, { onLeft: Effect.fail, onRight: receive }),
              ),
            ),
          );
        }),
      ),
  });
