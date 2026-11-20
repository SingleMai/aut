import { it } from "@effect/vitest";
import { Effect, Queue } from "effect";
import { expect } from "vitest";
import { NodeTransport } from "./transport.js";

const open = (script: string, rpcTimeoutMs = 1_000) =>
  NodeTransport.open({
    command: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    rpcTimeoutMs,
  });
const loop = (body: string) =>
  `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);${body}});`;

it.scopedLive("uses native newline RPC and preserves terminal-before-exit ordering", () =>
  Effect.gen(function* () {
    const transport = yield* open(
      loop(
        `process.stdout.write(JSON.stringify({id:m.id,result:{pid:process.pid}})+'\\n');process.stdout.write(JSON.stringify({method:'terminal',params:{}})+'\\n',()=>process.exit(0));`,
      ),
    );
    expect(yield* transport.request("test", {})).toHaveProperty("pid");
    expect(yield* Queue.take(transport.notices)).toMatchObject({
      kind: "message",
      message: { method: "terminal" },
    });
    expect(yield* Queue.take(transport.notices)).toMatchObject({ kind: "exit", code: 0 });
    expect((yield* transport.request("after-exit", {}).pipe(Effect.flip)).code).toBe(
      "ProcessExited",
    );
  }),
);

it.scopedLive("bounds an unanswered RPC without inventing an acknowledgement", () =>
  Effect.gen(function* () {
    const transport = yield* open(loop(""), 50);
    const error = yield* transport.request("unanswered", {}).pipe(Effect.flip);
    expect(error.code).toBe("TransportError");
    expect(error.message).toContain("timed out");
  }),
);

it.scopedLive("fails a pending RPC promptly when its child exits", () =>
  Effect.gen(function* () {
    const transport = yield* open(loop("process.exit(3);"));
    expect((yield* transport.request("exit", {}).pipe(Effect.flip)).code).toBe("ProcessExited");
    expect(yield* Queue.take(transport.notices)).toEqual({ kind: "exit", code: 3 });
  }),
);

it.scopedLive("reports malformed protocol data and fails waiting RPCs", () =>
  Effect.gen(function* () {
    const transport = yield* open(loop("process.stdout.write('not-json\\n');"));
    expect((yield* transport.request("bad", {}).pipe(Effect.flip)).code).toBe("ProtocolError");
    expect(yield* Queue.take(transport.notices)).toMatchObject({ kind: "error" });
  }),
);

it.live("Scope cleanup confirms child death before returning", () =>
  Effect.gen(function* () {
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* open(
          loop(`process.stdout.write(JSON.stringify({id:m.id,result:process.pid})+'\\n');`),
        );
        return yield* transport.request("pid", {});
      }),
    );
    expect(typeof result).toBe("number");
    let alive = false;
    if (typeof result === "number") {
      try {
        process.kill(result, 0);
        alive = true;
      } catch {
        /* The scoped child is gone. */
      }
    }
    expect(alive).toBe(false);
  }),
);

it.scopedLive("missing executables fail acquisition RPC without hanging", () =>
  Effect.gen(function* () {
    const transport = yield* NodeTransport.open({
      command: "/aut-codex-missing-fixture",
      args: [],
      cwd: process.cwd(),
      rpcTimeoutMs: 100,
    });
    expect((yield* transport.request("initialize", {}).pipe(Effect.flip)).code).toMatch(
      /TransportError|ProcessExited/,
    );
  }),
);

it.live("closes a completely idle child and reader without receiving any messages", () =>
  Effect.scoped(open("setInterval(()=>{},1000);")).pipe(Effect.asVoid),
);

it.live("escalates cleanup when a child ignores SIGTERM", () =>
  Effect.gen(function* () {
    const pid = yield* Effect.scoped(
      Effect.gen(function* () {
        const transport = yield* open(
          "process.on('SIGTERM',()=>{});" +
            loop(`process.stdout.write(JSON.stringify({id:m.id,result:process.pid})+'\\n');`),
        );
        return yield* transport.request("pid", {});
      }),
    );
    let alive = false;
    if (typeof pid === "number") {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        /* Reaped after SIGKILL. */
      }
    }
    expect(alive).toBe(false);
  }),
);
