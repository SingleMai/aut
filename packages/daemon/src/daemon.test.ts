import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  botConfigDigest,
  ConfigStore,
  CoreLive,
  insertTaskWithSession,
  MainThread,
  SessionManager,
  Store,
  TaskRegistry,
} from "@aut/core";
import {
  BotConfig,
  BotId,
  BotsResponse,
  DaemonEvent,
  MessageId,
  MessagePageResponse,
  ReportResponse,
  RequestId,
  RequestResponse,
  Task,
  TaskId,
  TaskListResponse,
  TaskSessionResponse,
} from "@aut/protocol";
import { Context, Effect, Either, Exit, Layer, Option, Schema, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { Administration } from "./admin.js";
import { HttpServer } from "./http.js";
import { DaemonApiLive, DaemonLive } from "./index.js";

const directories: string[] = [];
const closes: Array<() => Promise<void>> = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "aut-daemon-"));
  directories.push(path);
  return path;
};
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

const start = async (dataDirectory = directory()) => {
  const scope = await Effect.runPromise(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
  closes.push(close);
  const context = await Effect.runPromise(
    Layer.buildWithScope(DaemonApiLive({ dataDirectory, port: 0 }), scope),
  );
  const server = Context.get(context, HttpServer);
  const token = readFileSync(join(dataDirectory, "daemon-token"), "utf8");
  const base = `http://${server.host}:${server.port}`;
  return {
    dataDirectory,
    token,
    base,
    close,
    run: <A, E>(
      effect: Effect.Effect<A, E, Layer.Layer.Success<ReturnType<typeof DaemonApiLive>>>,
    ) => Effect.runPromise(effect.pipe(Effect.provide(context))),
    request: (path: string, method = "GET", value?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }),
  };
};

const config = {
  harnessInstances: [
    {
      id: "local",
      name: "Existing provider",
      kind: "codex",
      command: "/existing/codex",
      args: ["app-server"],
      env: { KEEP: "value" },
    },
  ],
};
const bot = Schema.decodeUnknownSync(BotConfig)({
  id: "b1",
  name: "Research",
  description: "Research work",
  soul: "Keep soul",
  cwd: "/existing/project",
  modelSelection: { instanceId: "local", model: "existing-model" },
});
const task = (id: string, status: Task["status"]) =>
  Schema.decodeUnknownSync(Task)({
    id,
    botId: "b1",
    title: id,
    status,
    createdAt: 1,
    updatedAt: 2,
    lastActivityAt: 2,
    session: { instanceId: "local", cursor: { kind: "codex", data: { threadId: `native-${id}` } } },
    pendingRequestIds: status === "waiting_user" ? ["request-1"] : [],
    queue: [],
    origin: { kind: "user" },
  });

describe("local HTTP API", () => {
  it("binds creation undo to the original receipt across restart, concurrent clicks and ID reuse", async () => {
    const first = await start();
    await first.request("/v1/config", "PUT", config);
    await first.run(
      Effect.flatMap(Administration, (admin) => admin.createBot(bot, TaskId.make("creator"))),
    );
    const [receipt] = Schema.decodeUnknownSync(MessagePageResponse)(
      await (await first.request("/v1/messages")).json(),
    ).messages;
    if (!receipt) throw new Error("Missing creation receipt");
    expect(receipt).toMatchObject({
      taskId: "creator",
      botCreation: { botId: bot.id, status: "available" },
    });
    const url = `/v1/messages/${receipt.id}/undo-bot-creation`;
    await first.close();
    const daemon = await start(first.dataDirectory);
    const results = await Promise.all([daemon.request(url, "POST"), daemon.request(url, "POST")]);
    for (const response of results) {
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        message: { id: receipt.id, botCreation: { status: "undone" } },
      });
    }
    expect(await (await daemon.request("/v1/bots")).json()).toEqual({ bots: [] });
    expect((await daemon.request("/v1/bots", "POST", bot)).status).toBe(201);
    expect((await daemon.request(url, "POST")).status).toBe(200);
    expect(await (await daemon.request("/v1/bots")).json()).toEqual({ bots: [bot] });
    expect((await daemon.request(`/v1/messages/${bot.id}/undo-bot-creation`, "POST")).status).toBe(
      404,
    );
    expect((await (await daemon.request("/v1/messages")).json()).messages).toHaveLength(1);
  });

  it("expires a receipt after a config change, manual replacement or first task", async () => {
    const daemon = await start();
    await daemon.request("/v1/config", "PUT", config);
    const children = ["edited", "deleted", "used"].map((id) => ({ ...bot, id: BotId.make(id) }));
    for (const child of children)
      await daemon.run(
        Effect.flatMap(Administration, (admin) => admin.createBot(child, TaskId.make("creator"))),
      );
    const [edited, removed, used] = children as [BotConfig, BotConfig, BotConfig];
    await daemon.request("/v1/bots/edited", "PUT", { ...edited, soul: "Changed" });
    await daemon.request("/v1/bots/edited", "PUT", edited);
    await daemon.request("/v1/bots/deleted", "DELETE");
    await daemon.request("/v1/bots", "POST", removed);
    await daemon.run(
      Effect.flatMap(TaskRegistry, (tasks) =>
        tasks.create({ ...task("first-use", "created"), botId: used.id }),
      ),
    );
    const { messages } = Schema.decodeUnknownSync(MessagePageResponse)(
      await (await daemon.request("/v1/messages")).json(),
    );
    expect(messages.map((m) => m.botCreation?.status)).toEqual(["changed", "removed", "used"]);
    for (const receipt of messages)
      expect(
        (await daemon.request(`/v1/messages/${receipt.id}/undo-bot-creation`, "POST")).status,
      ).toBe(409);
    expect(
      Schema.decodeUnknownSync(BotsResponse)(await (await daemon.request("/v1/bots")).json()).bots,
    ).toHaveLength(3);
  });

  it("orders first task registration against creation undo without leaving an orphaned task", async () => {
    const path = directory();
    await Effect.runPromise(
      Effect.gen(function* () {
        const configs = yield* ConfigStore;
        yield* configs.writeConfig(config);
        yield* configs.writeBots([{ ...bot, system: "primary", id: BotId.make("aut") }]);
      }).pipe(Effect.provide(CoreLive({ dataDirectory: path }))),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const main = yield* MainThread;
        const admin = yield* Administration;
        const sessions = yield* SessionManager;
        const tasks = yield* TaskRegistry;
        const input = yield* main.append({
          id: MessageId.make("assign"),
          at: 1,
          author: "user",
          kind: "text",
          text: "A task",
        });
        yield* admin.createBot(bot, TaskId.make("creator"));
        const receipt = (yield* main.page()).find(
          (message) => message.botCreation?.botId === bot.id,
        );
        if (!receipt) throw new Error("Missing creation receipt");
        const [undo, dispatch] = yield* Effect.all(
          [
            Effect.either(admin.undoBotCreation(receipt.id)),
            Effect.either(
              sessions.register(
                { op: "new", botId: bot.id, requestMessageIds: [input.id] },
                "concurrent",
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const used = Either.isRight(dispatch);
        expect(Either.isLeft(undo)).toBe(used);
        expect((yield* admin.bots).some((candidate) => candidate.id === bot.id)).toBe(used);
        expect(yield* tasks.list({ botId: bot.id })).toHaveLength(used ? 1 : 0);
        expect(Option.getOrThrow(yield* main.get(receipt.id)).botCreation?.status).toBe(
          used ? "used" : "undone",
        );
      }).pipe(Effect.provide(DaemonLive({ dataDirectory: path, port: 0 }))),
    );
  });

  it("recovers interrupted creates and undos on either side of the bot file rename", async () => {
    const first = await start();
    const ids = ["creation-before", "creation-after", "undo-before", "undo-after"] as const;
    await first.run(
      Effect.gen(function* () {
        const store = yield* Store;
        const configs = ids.map((id) => ({ ...bot, id: BotId.make(id) }));
        yield* (yield* ConfigStore).writeBots(
          configs.filter((b) => ["creation-after", "undo-before"].includes(b.id)),
        );
        yield* store.transaction((tx) =>
          Effect.forEach(configs, (child) => {
            const creation = {
              id: child.id,
              taskId: TaskId.make("creator"),
              messageId: MessageId.make(`receipt-${child.id}`),
              name: child.name,
              configDigest: botConfigDigest(child),
              at: 1,
              phase: child.id.startsWith("undo") ? ("undoing" as const) : ("creating" as const),
            };
            return tx.insert("bot_creations", creation);
          }),
        );
      }),
    );
    await first.close();
    const reopened = await start(first.dataDirectory);
    const { messages } = Schema.decodeUnknownSync(MessagePageResponse)(
      await (await reopened.request("/v1/messages")).json(),
    );
    expect(messages.map((m) => [m.botCreation?.botId, m.botCreation?.status])).toEqual([
      ["creation-after", "available"],
      ["undo-before", "available"],
      ["undo-after", "undone"],
    ]);
    expect(
      (await reopened.request("/v1/messages/receipt-undo-before/undo-bot-creation", "POST")).status,
    ).toBe(200);
  });

  it("validates session history queries and distinguishes pending/failed reads from missing tasks", async () => {
    const daemon = await start();
    await daemon.run(
      Effect.gen(function* () {
        const tasks = yield* TaskRegistry;
        yield* tasks.create({ ...task("pending", "created"), session: { instanceId: "local" } });
        yield* (yield* Store).transaction((tx) =>
          insertTaskWithSession(tx, task("unavailable", "idle")),
        );
      }),
    );
    expect((await daemon.request("/v1/tasks/missing/session")).status).toBe(404);
    const pending = await daemon.request("/v1/tasks/pending/session");
    expect(pending.status).toBe(200);
    expect(Schema.decodeUnknownSync(TaskSessionResponse)(await pending.json())).toMatchObject({
      availability: "pending",
      history: { turns: [] },
      hasEarlier: false,
    });
    const unavailable = Schema.decodeUnknownSync(TaskSessionResponse)(
      await (await daemon.request("/v1/tasks/unavailable/session")).json(),
    );
    expect(unavailable.availability).toBe("unavailable");
    expect(unavailable.message).toContain("重试");
    for (const query of [
      "limit=0",
      "limit=21",
      "limit=1.5",
      "limit=bad",
      "before=",
      "extra=x",
      "limit=1&limit=2",
    ])
      expect((await daemon.request(`/v1/tasks/pending/session?${query}`)).status).toBe(400);
  });

  it("reads and pages a persisted native session through an isolated read-only process", async () => {
    const daemon = await start();
    const command = join(daemon.dataDirectory, "native-reader.mjs");
    const audit = join(daemon.dataDirectory, "native-requests.jsonl");
    const nativeTurns = Array.from({ length: 12 }, (_, index) => ({
      id: `turn-${index}`,
      status: "completed",
      items: [
        {
          id: `user-${index}`,
          type: "userMessage",
          content: [{ type: "text", text: `Request ${index}` }],
        },
        {
          id: `tool-${index}`,
          type: "commandExecution",
          status: "completed",
          command: "pwd",
          aggregatedOutput: "/tmp/fixture",
          exitCode: 0,
        },
        {
          id: `reply-${index}`,
          type: "agentMessage",
          phase: "final_answer",
          text: `Result ${index}`,
        },
      ],
    }));
    writeFileSync(
      command,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const audit = ${JSON.stringify(audit)};
const turns = ${JSON.stringify(nativeTurns)};
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(audit, JSON.stringify(request) + "\\n");
  if (request.id === undefined) return;
  const result = request.method === "initialize" ? {} : request.method === "thread/read" ? { thread: { id: request.params.threadId, turns } } : undefined;
  process.stdout.write(JSON.stringify(result === undefined ? { id: request.id, error: { code: -1, message: "Mutating RPC forbidden" } } : { id: request.id, result }) + "\\n");
});
`,
      { mode: 0o700 },
    );
    const saved = task("native", "idle");
    await daemon.run(
      Effect.gen(function* () {
        yield* (yield* ConfigStore).writeConfig({
          harnessInstances: [
            { id: "local", name: "Read-only fixture", kind: "codex", command, args: [] },
          ],
        });
        yield* (yield* Store).transaction((tx) => insertTaskWithSession(tx, saved));
      }),
    );
    const latestResponse = await daemon.request("/v1/tasks/native/session");
    expect(latestResponse.status).toBe(200);
    const latest = Schema.decodeUnknownSync(TaskSessionResponse)(await latestResponse.json());
    expect(latest.availability).toBe("available");
    expect(latest.history.turns.map((turn) => turn.id)).toEqual(
      nativeTurns.slice(2).map((turn) => turn.id),
    );
    expect(latest.history.turns[0]?.items[1]).toMatchObject({
      id: "tool-2",
      kind: "tool",
      tool: { input: "pwd", output: "/tmp/fixture", exitCode: 0 },
    });
    expect(latest.nextBefore).toBe("turn-2");
    const earlier = Schema.decodeUnknownSync(TaskSessionResponse)(
      await (await daemon.request("/v1/tasks/native/session?before=turn-2&limit=1")).json(),
    );
    expect(earlier.history.turns.map((turn) => turn.id)).toEqual(["turn-1"]);
    expect(earlier.hasEarlier).toBe(true);
    expect((await daemon.request("/v1/tasks/native/session?before=missing")).status).toBe(404);
    const methods = readFileSync(audit, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).method);
    expect(methods).toEqual(
      Array.from({ length: 3 }, () => ["initialize", "initialized", "thread/read"]).flat(),
    );
    const after = await daemon.run(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.transaction((tx) =>
          Effect.all({
            task: tx.get("tasks", saved.id),
            events: tx.list("events"),
            messages: tx.list("main_thread_messages"),
          }),
        );
      }),
    );
    expect(Option.getOrThrow(after.task)).toEqual(saved);
    expect(after.events).toEqual([]);
    expect(after.messages).toEqual([]);
  }, 15_000);

  it("retrieves historical reports only from the referenced successful completion event", async () => {
    const daemon = await start();
    await daemon.run(
      Effect.gen(function* () {
        yield* (yield* Store).transaction((tx) =>
          Effect.gen(function* () {
            for (const [id, text] of [
              ["older", "Original complete report"],
              ["newer", "New complete report"],
            ] as const)
              yield* tx.insert("events", {
                id,
                at: 1,
                event: {
                  source: "session",
                  kind: "turn.completed",
                  taskId: TaskId.make("task"),
                  event: { kind: "turn.completed", turnId: id, ok: true, finalReport: text },
                },
              });
            yield* tx.insert("events", {
              id: "interrupted",
              at: 1,
              event: {
                source: "session",
                kind: "turn.completed",
                taskId: TaskId.make("task"),
                event: {
                  kind: "turn.completed",
                  turnId: "stopped",
                  ok: false,
                  stopReason: "interrupted",
                },
              },
            });
            yield* tx.insert("events", {
              id: "input",
              at: 1,
              event: {
                source: "user",
                kind: "message",
                messageId: MessageId.make("private-user-message"),
              },
            });
          }),
        );
      }),
    );
    const response = await daemon.request(`/v1/reports/${encodeURIComponent("event:older")}`);
    expect(response.status).toBe(200);
    expect(Schema.decodeUnknownSync(ReportResponse)(await response.json())).toEqual({
      ref: "event:older",
      text: "Original complete report",
    });
    for (const ref of ["event:missing", "task:task", "event:interrupted", "event:input"])
      expect((await daemon.request(`/v1/reports/${encodeURIComponent(ref)}`)).status).toBe(404);
  });
  it("requires a private persistent token and validates health/errors", async () => {
    const daemon = await start();
    expect((await fetch(`${daemon.base}/v1/health`)).status).toBe(401);
    expect((await fetch(`${daemon.base}/v1/health?token=${daemon.token}`)).status).toBe(401);
    expect(
      (
        await fetch(`${daemon.base}/v1/health`, {
          headers: { authorization: `Bearer ${"é".repeat(64)}` },
        })
      ).status,
    ).toBe(401);
    expect((await daemon.request("/v1/health?unknown=true")).status).toBe(400);
    expect((await daemon.request("/v1/bots?token=not-supported")).status).toBe(400);
    expect((await daemon.request("/v1/messages?limit=1&limit=2")).status).toBe(400);
    const health = await daemon.request("/v1/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
    const missing = await daemon.request("/unknown");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "NotFound", message: "Unknown API route" },
    });
    expect(statSync(join(daemon.dataDirectory, "daemon-token")).mode & 0o777).toBe(0o600);
    const token = daemon.token;
    await daemon.close();
    expect(existsSync(join(daemon.dataDirectory, "daemon-lock.sqlite"))).toBe(true);
    expect((await start(daemon.dataDirectory)).token).toBe(token);
  });

  it("validates routing tests and logs unconfigured classification without changing the main thread", async () => {
    const daemon = await start();
    expect((await daemon.request("/v1/route-test", "POST", { text: "" })).status).toBe(400);
    expect((await daemon.request("/v1/route-test", "POST", { text: "Request" })).status).toBe(503);
    await daemon.run(
      Effect.gen(function* () {
        yield* (yield* ConfigStore).writeBots([bot]);
      }),
    );
    expect((await daemon.request("/v1/route-test", "POST", { text: "Request" })).status).toBe(503);
    const saved = await daemon.run(
      Effect.gen(function* () {
        return yield* (yield* Store).transaction((tx) =>
          Effect.gen(function* () {
            return {
              logs: yield* tx.list("decision_logs"),
              messages: yield* tx.list("main_thread_messages"),
              tasks: yield* tx.list("tasks"),
            };
          }),
        );
      }),
    );
    expect(saved.logs).toHaveLength(2);
    expect(saved.logs[1]?.classifierCalls[0]?.error).toContain("NotConfigured");
    expect(saved.messages).toEqual([]);
    expect(saved.tasks).toEqual([]);
  });

  it("deduplicates concurrent stable IDs without duplicate messages or events and pages by insertion order", async () => {
    const daemon = await start();
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        daemon.request("/v1/messages", "POST", { id: "same", text: "Hello" }),
      ),
    );
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(7);
    const conflict = await daemon.request("/v1/messages", "POST", {
      id: "same",
      text: "Different",
    });
    expect(conflict.status).toBe(409);
    await daemon.request("/v1/messages", "POST", { id: "second", text: "Second" });
    await daemon.request("/v1/messages", "POST", { id: "third", text: "Third" });
    const newest = Schema.decodeUnknownSync(MessagePageResponse)(
      await (await daemon.request("/v1/messages?limit=2")).json(),
    );
    expect(newest.messages.map((value: { id: string }) => value.id)).toEqual(["second", "third"]);
    const older = Schema.decodeUnknownSync(MessagePageResponse)(
      await (await daemon.request("/v1/messages?before=second&limit=2")).json(),
    );
    expect(older.messages.map((value: { id: string }) => value.id)).toEqual(["same"]);
    const stored = await daemon.run(
      Effect.gen(function* () {
        return yield* (yield* Store).transaction((tx) => tx.list("events"));
      }),
    );
    expect(stored).toHaveLength(3);
    expect(stored[0]?.event).toEqual({ source: "user", kind: "message", messageId: "same" });
  });

  it("validates bodies/queries and limits the body to one MiB", async () => {
    const daemon = await start();
    for (const value of [{ text: "" }, { text: 1 }, { text: "Hi", unknown: true }])
      expect((await daemon.request("/v1/messages", "POST", value)).status).toBe(400);
    expect((await daemon.request("/v1/messages?limit=51")).status).toBe(400);
    expect((await daemon.request("/v1/messages?unknown=x")).status).toBe(400);
    expect((await daemon.request("/v1/tasks?status=not-a-status")).status).toBe(400);
    expect(
      (await daemon.request("/v1/messages", "POST", { text: "a".repeat(1024 * 1024) })).status,
    ).toBe(413);
    const malformed = await fetch(`${daemon.base}/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.token}` },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect((await daemon.request("/v1/health")).status).toBe(200);
  });

  it("exposes the stored answer only for confirmed question delivery", async () => {
    const daemon = await start();
    const taskId = TaskId.make("readback-task");
    const answer = {
      perQuestion: [{ questionId: "q", optionIds: ["a"], text: "Additional detail" }],
    };
    const phases = [
      undefined,
      "registered",
      "submitting",
      "indeterminate",
      "queued",
      "delivered",
    ] as const;
    for (const kind of ["question", "permission"] as const) {
      for (const phase of phases) {
        const id = RequestId.make(`${kind}-${phase ?? "unclaimed"}`);
        const fields = { id, taskId, openedAt: 1, raw: null };
        const request =
          kind === "question"
            ? {
                ...fields,
                kind,
                questions: [
                  {
                    id: "q",
                    text: "Choose",
                    options: [{ id: "a", label: "First" }],
                    multiSelect: false,
                    allowFreeText: true,
                  },
                ],
              }
            : { ...fields, kind, permission: { tool: "read", summary: "Read" }, questions: [] };
        await daemon.run(
          Effect.gen(function* () {
            yield* (yield* Store).transaction((tx) =>
              tx.insert("session_requests", {
                id,
                taskId,
                request,
                // Closing a card alone is never evidence that its answer was delivered.
                state: "answered",
                ...(phase
                  ? {
                      answerClaim: {
                        claimId: "claim",
                        decisionLogId: "decision",
                        updatedAt: 2,
                        phase,
                        answer,
                      },
                    }
                  : {}),
              }),
            );
          }),
        );
        const path = `/v1/requests/${id}`;
        const res = await daemon.request(path);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
          request,
          ...(phase ? { answerState: phase } : {}),
          ...(kind === "question" && phase === "delivered" ? { deliveredAnswer: answer } : {}),
        });
        if (kind === "question" && phase === "delivered")
          expect((await fetch(`${daemon.base}${path}`)).status).toBe(401);
      }
    }
  });

  it("persists UI actions and serves actual task and question records", async () => {
    const daemon = await start();
    const request = {
      id: RequestId.make("r1"),
      taskId: TaskId.make("t1"),
      kind: "question" as const,
      openedAt: 1,
      questions: [{ id: "q", text: "Choose", multiSelect: false, allowFreeText: true }],
      raw: null,
    };
    await daemon.run(
      Effect.gen(function* () {
        yield* (yield* TaskRegistry).create(task("t1", "created"));
        yield* (yield* Store).transaction((tx) =>
          tx.insert("session_requests", {
            id: request.id,
            taskId: request.taskId,
            request,
            state: "open",
          }),
        );
      }),
    );
    expect((await daemon.request("/v1/tasks/t1")).status).toBe(200);
    expect((await daemon.request("/v1/tasks/missing")).status).toBe(404);
    expect(
      Schema.decodeUnknownSync(TaskListResponse)(
        await (await daemon.request("/v1/tasks?status=created&botId=b1")).json(),
      ).tasks,
    ).toHaveLength(1);
    expect(
      Schema.decodeUnknownSync(RequestResponse)(
        await (await daemon.request("/v1/requests/r1")).json(),
      ).request,
    ).toEqual(request);
    expect((await daemon.request("/v1/requests/missing")).status).toBe(404);
    const action = {
      type: "question-answer",
      cardId: "card-1",
      requestId: "r1",
      answer: { perQuestion: [{ questionId: "q", text: "Blue" }] },
    };
    expect((await daemon.request("/v1/actions", "POST", action)).status).toBe(202);
    const events = await daemon.run(
      Effect.gen(function* () {
        return yield* (yield* Store).transaction((tx) => tx.list("events"));
      }),
    );
    expect(events[0]?.event).toEqual({ source: "user", kind: "ui-action", action });
  });

  it("persists quote text with its action before later messages and rolls back unknown references", async () => {
    const daemon = await start();
    await daemon.run(
      Effect.gen(function* () {
        const thread = yield* MainThread;
        yield* thread.append({
          id: MessageId.make("quoted"),
          at: 1,
          author: "chief",
          kind: "reply",
          text: "Original",
          taskId: TaskId.make("target"),
        });
      }),
    );
    expect(
      (
        await daemon.request("/v1/actions", "POST", {
          type: "quote-reply",
          quotedMessageId: "quoted",
          text: "User original text",
        })
      ).status,
    ).toBe(202);
    await daemon.request("/v1/messages", "POST", { id: "later", text: "Later" });
    const snapshot = await daemon.run(
      Effect.gen(function* () {
        return yield* (yield* Store).transaction((tx) =>
          Effect.gen(function* () {
            return {
              events: yield* tx.list("events"),
              messages: yield* tx.list("main_thread_messages"),
            };
          }),
        );
      }),
    );
    const event = snapshot.events.find(
      (record) => record.event.source === "user" && record.event.kind === "ui-action",
    );
    expect(event).toBeDefined();
    expect(snapshot.messages[1]).toEqual({
      id: `quote:${event?.id}`,
      at: event?.at,
      author: "user",
      kind: "text",
      text: "User original text",
      taskId: "target",
    });
    expect(snapshot.messages.map((record) => record.id)).toEqual([
      "quoted",
      `quote:${event?.id}`,
      "later",
    ]);
    expect(
      (
        await daemon.request("/v1/actions", "POST", {
          type: "quote-reply",
          quotedMessageId: "missing",
          text: "Invalid",
        })
      ).status,
    ).toBe(404);
    const count = await daemon.run(
      Effect.gen(function* () {
        return yield* (yield* Store).transaction((tx) => tx.list("events"));
      }),
    );
    expect(count).toHaveLength(2);
    expect(
      (
        await daemon.request("/v1/actions", "POST", {
          type: "quote-reply",
          quotedMessageId: "later",
          text: "No task",
        })
      ).status,
    ).toBe(202);
    const messages = Schema.decodeUnknownSync(MessagePageResponse)(
      await (await daemon.request("/v1/messages")).json(),
    ).messages;
    expect(messages[messages.length - 1]?.taskId).toBeUndefined();
  });

  it("manages bots/config while preserving provider references and protecting system bots", async () => {
    const daemon = await start();
    expect((await daemon.request("/v1/bots", "POST", bot)).status).toBe(409);
    expect((await daemon.request("/v1/config", "PUT", config)).status).toBe(200);
    expect((await daemon.request("/v1/bots", "POST", { ...bot, system: "primary" })).status).toBe(
      409,
    );
    expect((await daemon.request("/v1/bots", "POST", bot)).status).toBe(201);
    expect((await daemon.request("/v1/bots", "POST", bot)).status).toBe(409);
    expect((await daemon.request("/v1/bots/b1", "PUT", { ...bot, name: "Updated" })).status).toBe(
      200,
    );
    expect((await daemon.request("/v1/bots/b1", "PUT", { ...bot, id: "changed" })).status).toBe(
      409,
    );
    expect((await daemon.request("/v1/config", "PUT", { harnessInstances: [] })).status).toBe(409);
    expect(await (await daemon.request("/v1/config")).json()).toEqual(config);
    expect(
      Schema.decodeUnknownSync(BotsResponse)(await (await daemon.request("/v1/bots")).json())
        .bots[0]?.cwd,
    ).toBe(bot.cwd);
    expect((await daemon.request("/v1/bots/b1", "DELETE")).status).toBe(200);
    await daemon.run(
      Effect.gen(function* () {
        yield* (yield* ConfigStore).writeBots([{ ...bot, system: "primary" }]);
      }),
    );
    expect((await daemon.request("/v1/bots/b1", "DELETE")).status).toBe(409);
    expect((await daemon.request("/v1/bots/b1", "PUT", bot)).status).toBe(409);
    await daemon.run(
      Effect.gen(function* () {
        yield* (yield* ConfigStore).writeBots([bot]);
        yield* (yield* TaskRegistry).create(task("retained", "created"));
      }),
    );
    expect((await daemon.request("/v1/bots/b1", "DELETE")).status).toBe(409);
  });
});

describe("ownership and restart recovery", () => {
  it("rejects duplicate connections and processes, and releases ownership after a real crash", async () => {
    const daemon = await start();
    await expect(start(daemon.dataDirectory)).rejects.toThrow("exclusive daemon ownership");
    expect((await daemon.request("/v1/health")).status).toBe(200);
    const script = `
      const { DatabaseSync } = require("node:sqlite");
      const connection = new DatabaseSync(process.argv[1]);
      try { connection.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE"); }
      catch { connection.close(); process.exit(7); }
      process.stdout.write("ready");
      process.stdin.resume();
    `;
    const lockPath = join(daemon.dataDirectory, "daemon-lock.sqlite");
    const denied = spawnSync(process.execPath, ["-e", script, lockPath], { encoding: "utf8" });
    expect(denied.status).toBe(7);
    await daemon.close();
    const child = spawn(process.execPath, ["-e", script, lockPath], { stdio: "pipe" });
    try {
      expect(String((await once(child.stdout, "data"))[0])).toBe("ready");
      await expect(start(daemon.dataDirectory)).rejects.toThrow("exclusive daemon ownership");
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      expect((await exited)[1]).toBe("SIGKILL");
      const restarted = await start(daemon.dataDirectory);
      expect((await restarted.request("/v1/health")).status).toBe(200);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("recovers only active tasks, expires open questions/cards and preserves cursors without repeated notices", async () => {
    const path = directory();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* Store;
          yield* store.transaction((tx) =>
            Effect.gen(function* () {
              for (const status of [
                "created",
                "running",
                "waiting_user",
                "reporting",
                "idle",
                "failed",
                "interrupted",
                "cancelled",
                "archived",
              ] as const)
                yield* insertTaskWithSession(tx, task(status, status));
              const waiting = TaskId.make("waiting_user");
              const id = RequestId.make("request-1");
              yield* tx.insert("session_requests", {
                id,
                taskId: waiting,
                state: "open",
                request: {
                  id,
                  taskId: waiting,
                  kind: "question",
                  openedAt: 1,
                  raw: null,
                  questions: [{ id: "q", text: "Choose", multiSelect: false, allowFreeText: true }],
                },
              });
              yield* tx.insert("main_thread_messages", {
                id: MessageId.make("card"),
                at: 1,
                author: "chief",
                kind: "question-card",
                text: "Choose",
                taskId: waiting,
                card: {
                  id: "c1",
                  requestId: id,
                  prompt: "Choose",
                  options: [],
                  multiSelect: false,
                  allowFreeText: true,
                  state: "open",
                },
              });
            }),
          );
        }).pipe(Effect.provide(CoreLive({ dataDirectory: path }))),
      ),
    );
    const daemon = await start(path);
    const tasks = Schema.decodeUnknownSync(TaskListResponse)(
      await (await daemon.request("/v1/tasks")).json(),
    ).tasks;
    for (const state of ["created", "running", "waiting_user", "reporting"]) {
      const recovered = tasks.find((value) => value.id === state);
      expect(recovered?.status).toBe("interrupted");
      expect(recovered?.pendingRequestIds).toEqual([]);
      expect(recovered?.session.cursor?.data).toEqual({ threadId: `native-${state}` });
    }
    for (const state of ["idle", "failed", "interrupted", "cancelled", "archived"])
      expect(tasks.find((value) => value.id === state)?.status).toBe(state);
    const before = await daemon.run(
      Effect.gen(function* () {
        const store = yield* Store;
        return yield* store.transaction((tx) =>
          Effect.gen(function* () {
            return {
              messages: yield* tx.list("main_thread_messages"),
              requests: yield* tx.list("session_requests"),
            };
          }),
        );
      }),
    );
    expect(before.messages.filter((value) => value.kind === "notice")).toHaveLength(4);
    expect(before.messages.find((value) => value.id === "card")?.card?.state).toBe("expired");
    expect(before.requests[0]?.state).toBe("expired");
    await daemon.close();
    const again = await start(path);
    const messages = await again.run(
      Effect.gen(function* () {
        return yield* (yield* MainThread).page();
      }),
    );
    expect(messages.filter((value) => value.kind === "notice")).toHaveLength(4);
  });
});

describe("WebSocket event stream", () => {
  it("supports browser token subprotocols, sends persisted events and closes connections with scope", async () => {
    const daemon = await start();
    const socket = new WebSocket(`${daemon.base.replace("http:", "ws:")}/v1/events`, [
      "aut",
      `aut-token.${daemon.token}`,
    ]);
    await once(socket, "open");
    expect(socket.protocol).toBe("aut");
    const frames: DaemonEvent[] = [];
    const received = new Promise<void>((resolve) =>
      socket.on("message", (data) => {
        frames.push(Schema.decodeUnknownSync(Schema.parseJson(DaemonEvent))(String(data)));
        if (frames.length === 2) resolve();
      }),
    );
    await daemon.request("/v1/messages", "POST", { id: "ws-message", text: "Hello WS" });
    await received;
    expect(frames).toContainEqual({
      type: "event",
      event: {
        source: "user",
        kind: "message",
        messageId: "ws-message",
      },
    });
    expect(frames).toContainEqual({ type: "changed", resources: ["messages"] });
    const closed = once(socket, "close");
    await daemon.close();
    await closed;
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("notifies clients about chief outputs, task state and atomic configuration changes", async () => {
    const daemon = await start();
    const socket = new WebSocket(`${daemon.base.replace("http:", "ws:")}/v1/events`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    await once(socket, "open");
    const receive = async (operation: () => Promise<unknown>, resources: string[]) => {
      const pending = once(socket, "message");
      await operation();
      const [data] = await pending;
      expect(Schema.decodeUnknownSync(Schema.parseJson(DaemonEvent))(String(data))).toEqual({
        type: "changed",
        resources,
      });
    };
    await receive(
      () =>
        daemon.run(
          Effect.gen(function* () {
            yield* (yield* MainThread).append({
              id: MessageId.make("chief-ack"),
              at: 1,
              author: "chief",
              kind: "ack",
              text: "Acknowledged",
            });
          }),
        ),
      ["messages"],
    );
    expect(
      Schema.decodeUnknownSync(MessagePageResponse)(
        await (await daemon.request("/v1/messages")).json(),
      ).messages[0]?.kind,
    ).toBe("ack");
    await receive(
      () =>
        daemon.run(
          Effect.gen(function* () {
            yield* (yield* TaskRegistry).create(task("ws-task", "created"));
          }),
        ),
      ["tasks"],
    );
    await receive(
      () =>
        daemon.run(
          Effect.gen(function* () {
            yield* (yield* TaskRegistry).transition(TaskId.make("ws-task"), {
              type: "turn.started",
            });
          }),
        ),
      ["tasks"],
    );
    await receive(() => daemon.request("/v1/config", "PUT", config), ["config"]);
    await receive(() => daemon.request("/v1/bots", "POST", bot), ["bots"]);
    const closed = once(socket, "close");
    socket.close();
    await closed;
  });

  it("rejects missing authentication and token query strings; accepts header authentication", async () => {
    const daemon = await start();
    for (const suffix of ["", `?token=${daemon.token}`]) {
      const status = await new Promise<number>((resolve) => {
        const socket = new WebSocket(`${daemon.base.replace("http:", "ws:")}/v1/events${suffix}`);
        socket.on("error", () => {});
        socket.once("unexpected-response", (_, response) => {
          response.resume();
          socket.terminate();
          resolve(response.statusCode ?? 0);
        });
      });
      expect([401, 404]).toContain(status);
    }
    const socket = new WebSocket(`${daemon.base.replace("http:", "ws:")}/v1/events`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.close();
    await closed;
    expect(
      (await daemon.request("/v1/messages", "POST", { text: "After disconnect" })).status,
    ).toBe(201);
  });
});
