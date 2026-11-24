import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Classifier } from "@aut/classifier/interface";
import {
  BotConfig,
  ClassifierError,
  type HarnessAdapter,
  RequestId,
  type SessionEvent,
  type SessionHandle,
  Task,
  type TranscriptEntry,
  type TurnInput,
} from "@aut/protocol";
import { Effect, Layer, PubSub, Schema, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import { DecisionTreeLive } from "./decision-tree/engine.js";
import { CoreLive } from "./index.js";
import { reportState, SessionReplyGateLive, truncateReport } from "./reply-gate.js";
import { SessionReplyGate } from "./session-manager/ports.js";
import { Store } from "./store.js";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const bot = Schema.decodeUnknownSync(BotConfig)({
  id: "bot",
  name: "Bot",
  description: "General work",
  soul: "Private long term instructions",
  cwd: "/tmp",
  modelSelection: { instanceId: "local", model: "test" },
});
const task = Schema.decodeUnknownSync(Task)({
  id: "task",
  botId: bot.id,
  title: "Task",
  status: "reporting",
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1,
  session: { instanceId: "local" },
  pendingRequestIds: [],
  queue: [],
  origin: { kind: "user" },
});
type RewriteOutcome =
  | { text: string }
  | { failure: "question" | "exited" | "interrupted" | "never" | "empty" };
const execute = async (
  report: string,
  outcomes: RewriteOutcome[] = [],
  options: {
    fork?: boolean;
    readable?: number;
    classifierFails?: boolean;
    timeoutMs?: number;
    permission?: boolean;
    cwd?: string;
  } = {},
) => {
  const dataDirectory = mkdtempSync(join(tmpdir(), "aut-gate-"));
  directories.push(dataDirectory);
  const parentTurns: TurnInput[] = [];
  const childTurns: TurnInput[] = [];
  const approvals: unknown[] = [];
  const temporaryInstructions: string[] = [];
  const classified: string[] = [];
  let childrenClosed = 0;
  let childCount = 0;
  const originalTranscript: readonly TranscriptEntry[] = [
    { role: "user", text: "Original request" },
    { role: "assistant", text: report },
  ];
  const child = Effect.gen(function* () {
    const index = childCount++;
    const events = yield* Effect.acquireRelease(PubSub.unbounded<SessionEvent>(), (queue) =>
      Effect.sync(() => {
        childrenClosed++;
      }).pipe(Effect.zipRight(PubSub.shutdown(queue))),
    );
    const turnId = `rewrite-${index}`;
    const handle: SessionHandle = {
      cursor: { kind: "fake", data: { child: index } },
      events: Stream.fromPubSub(events),
      startTurn: (input) =>
        Effect.gen(function* () {
          childTurns.push(input);
          yield* PubSub.publish(events, { kind: "turn.started", turnId });
          if (options.permission) {
            const id = RequestId.make(`permission-${index}`);
            yield* PubSub.publish(events, {
              kind: "request.opened",
              request: {
                id,
                taskId: task.id,
                openedAt: 1,
                raw: null,
                kind: "permission",
                questions: [],
                permission: { tool: "test", summary: "Synthetic permission" },
              },
            });
            yield* PubSub.publish(events, {
              kind: "request.closed",
              requestId: id,
              reason: "answered",
            });
          }
          const outcome = outcomes[index] ?? { text: "已完成，结果可用。" };
          if ("text" in outcome)
            yield* PubSub.publish(events, {
              kind: "turn.completed",
              turnId,
              ok: true,
              finalReport: outcome.text,
            });
          else
            switch (outcome.failure) {
              case "never":
                break;
              case "exited":
                yield* PubSub.publish(events, { kind: "process.exited", code: 1 });
                break;
              case "empty":
                yield* PubSub.publish(events, {
                  kind: "turn.completed",
                  turnId,
                  ok: true,
                  finalReport: "",
                });
                break;
              case "interrupted":
                yield* PubSub.publish(events, {
                  kind: "turn.completed",
                  turnId,
                  ok: false,
                  stopReason: "interrupted",
                });
                break;
              case "question":
                yield* PubSub.publish(events, {
                  kind: "request.opened",
                  request: {
                    id: RequestId.make(`question-${index}`),
                    taskId: task.id,
                    kind: "question",
                    openedAt: 1,
                    raw: null,
                    questions: [
                      {
                        id: "q",
                        text: "Additional input?",
                        multiSelect: false,
                        allowFreeText: true,
                      },
                    ],
                  },
                });
                break;
            }
        }),
      respond: (_, answer) =>
        Effect.sync(() => {
          approvals.push(answer);
        }),
      interrupt: () => Effect.void,
      steer: () => Effect.succeed("refused"),
      fork: () => Effect.dieMessage("A rewrite must fork the original session"),
      transcript: () => Effect.succeed([]),
    };
    return handle;
  });
  const parent: SessionHandle = {
    cursor: { kind: "fake", data: { original: true } },
    events: Stream.never,
    startTurn: (input) =>
      Effect.sync(() => {
        parentTurns.push(input);
      }),
    fork: () => child,
    transcript: () => Effect.succeed(originalTranscript),
    steer: () => Effect.succeed("refused"),
    interrupt: () => Effect.void,
    respond: () => Effect.dieMessage("Rewrite requests must not use the original session"),
  };
  const adapter: HarnessAdapter = {
    kind: "fake",
    capabilities: {
      resume: true,
      fork: options.fork ?? true,
      steer: true,
      nativeFullAccess: true,
      transcript: true,
      questions: { native: true, multiQuestion: true, multiSelect: true, freeText: true },
    },
    startSession: (input) =>
      Effect.sync(() => {
        temporaryInstructions.push(input.instructions);
        expect(input.bot.soul).toBe("");
      }).pipe(Effect.zipRight(child)),
    resumeSession: () => Effect.dieMessage("Rewrite must not resume the original session"),
  };
  const classifier = Layer.succeed(Classifier, {
    backend: "mock",
    model: "mock-1",
    decide: (request) =>
      Effect.suspend(() => {
        const state = request.state as { report: string };
        classified.push(state.report);
        return options.classifierFails
          ? Effect.fail(
              new ClassifierError({ code: "Timeout", message: "Expected fixture timeout" }),
            )
          : Effect.succeed({
              answers: { readable: { type: "noul" as const, noul: options.readable ?? 0.9 } },
              latencyMs: 1,
            });
      }),
  });
  const tree = DecisionTreeLive().pipe(
    Layer.provideMerge(Layer.merge(CoreLive({ dataDirectory }), classifier)),
  );
  const gate = SessionReplyGateLive({ rewriteTimeoutMs: options.timeoutMs ?? 1_000 }).pipe(
    Layer.provideMerge(tree),
  );
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const before = yield* parent.transcript();
        const output = yield* (yield* SessionReplyGate).check({
          task,
          report,
          reportEventId: "report-event",
          session: parent,
          adapter,
          sessionInput: {
            taskId: task.id,
            bot,
            model: "test",
            cwd: options.cwd ?? "/tmp",
            instructions: bot.soul,
            mcpServers: [],
          },
        });
        const after = yield* parent.transcript();
        const saved = yield* (yield* Store).transaction((tx) =>
          Effect.gen(function* () {
            return {
              logs: yield* tx.list("decision_logs"),
              messages: yield* tx.list("main_thread_messages"),
              events: yield* tx.list("events", { limit: 100 }),
            };
          }),
        );
        return { output, before, after, ...saved };
      }).pipe(Effect.provide(gate)),
    ),
  );
  return {
    ...result,
    parentTurns,
    childTurns,
    classified,
    approvals,
    temporaryInstructions,
    childrenClosed,
    childCount,
  };
};

it("retains original file deliverables when a rewrite drops the link", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "aut-file-report-"));
  directories.push(cwd);
  const path = join(cwd, "report.csv");
  writeFileSync(path, "name,value\nalpha,42");
  const result = await execute(
    `${"这是一段很长的分析说明。".repeat(30)}\n[report.csv](${path})`,
    [{ text: "已完成分析。" }],
    { cwd },
  );
  expect(result.output.delivered).toBe("已完成分析。");
  expect(result.output.files).toHaveLength(1);
  expect(readFileSync(result.output.files?.[0]?.path ?? "", "utf8")).toBe("name,value\nalpha,42");
  expect(result.output.rewrites).toBe(1);
});

it.each([
  ["中".repeat(200), 0],
  ["中".repeat(201), 1],
  [Array(120).fill("word").join(" "), 0],
  [Array(121).fill("word").join(" "), 1],
] as const)("enforces the declared length boundary %#", async (report, rewrites) => {
  const result = await execute(report);
  expect(result.output.rewrites).toBe(rewrites);
  expect(result.childrenClosed).toBe(rewrites);
  expect(result.messages).toEqual([]);
  expect(result.logs[0]?.execution.ok).toBe(true);
});

it("accepts the readability threshold and isolates two failed rewrites from the original transcript", async () => {
  expect((await execute("已完成。", [], { readable: 0.6 })).output.rewrites).toBe(0);
  const result = await execute(
    "Technical initial report",
    [{ text: "First technical rewrite" }, { text: "Second technical rewrite" }],
    { readable: 0.599 },
  );
  expect(result.output.rewrites).toBe(2);
  expect(result.childrenClosed).toBe(2);
  expect(result.output.delivered).toContain("Second technical rewrite");
  expect(result.output.delivered).toContain("详情见任务面板");
  expect(result.before).toEqual(result.after);
  expect(result.parentTurns).toEqual([]);
  expect(result.classified).toHaveLength(3);
  expect(result.logs[0]?.path.filter((node) => node === "rewrite")).toHaveLength(2);
  expect(result.events.length).toBe(4);
});

it("uses a fresh temporary session with only the report when fork is unavailable", async () => {
  const report = "中".repeat(201);
  const result = await execute(report, [{ text: "已完成。" }], { fork: false });
  expect(result.output).toEqual({ delivered: "已完成。", rewrites: 1 });
  expect(result.temporaryInstructions).toHaveLength(1);
  expect(result.childTurns[0]?.text).toContain(report);
  expect(result.childTurns[0]?.text).not.toContain(bot.soul);
  expect(result.childTurns[0]?.messageIds).toEqual([]);
  expect(result.parentTurns).toEqual([]);
});

it.each(["question", "exited", "interrupted", "empty", "never"] as const)(
  "truncates after %s without answering questions or leaking a fork",
  async (failure) => {
    const result = await execute("中".repeat(250), [{ failure }], { timeoutMs: 30 });
    expect(result.output.delivered).toContain("详情见任务面板");
    expect(Array.from(result.output.delivered).length).toBeLessThanOrEqual(200);
    expect(result.output.rewrites).toBe(1);
    expect(result.approvals).toEqual([]);
    expect(result.childrenClosed).toBe(1);
    expect(result.logs[0]?.execution.degraded).toHaveLength(1);
    expect(result.before).toEqual(result.after);
  },
);

it("audits the adapter's permission approval once and still checks the rewritten report", async () => {
  const result = await execute("中".repeat(250), [{ text: "处理完成。" }], { permission: true });
  expect(result.approvals).toEqual([]);
  expect(result.events.map(({ event }) => event.kind)).toEqual([
    "turn.started",
    "request.opened",
    "request.closed",
    "turn.completed",
  ]);
  expect(result.output.delivered).toBe("处理完成。");
  expect(result.classified).toEqual(["处理完成。"]);
});

it("does not bypass the gate when the classifier is unavailable", async () => {
  const result = await execute("Short report", [{ text: "First" }, { text: "Second" }], {
    classifierFails: true,
  });
  expect(result.output.rewrites).toBe(2);
  expect(result.output.delivered).toContain("详情见任务面板");
  expect(result.logs[0]?.classifierCalls).toHaveLength(3);
  expect(result.logs[0]?.classifierCalls.every((call) => call.error?.includes("Timeout"))).toBe(
    true,
  );
});

it("counts Unicode code points and keeps the truncation suffix inside both limits", () => {
  expect(reportState("中😀", 0).characters).toBe(2);
  for (const report of ["中😀".repeat(200), Array(150).fill("English").join(" "), ""]) {
    const text = truncateReport(report);
    expect(Array.from(text).length).toBeLessThanOrEqual(200);
    expect(text.trim().split(/\s+/u).length).toBeLessThanOrEqual(120);
    expect(text.endsWith("详情见任务面板")).toBe(true);
  }
});

it("never cuts a source URL into a broken link in the terminal fallback", async () => {
  const url = `https://modelcontextprotocol.io/docs/${"long-path/".repeat(40)}intro`;
  for (const report of [`文档：${url}`, `[官方文档](${url})\n${"长报告".repeat(100)}`]) {
    const result = await execute(report, [{ text: report }, { text: report }], { readable: 0.1 });
    expect(result.output.rewrites).toBe(2);
    expect(result.output.delivered).not.toContain("https:");
    expect(result.output.delivered).not.toContain("long-path");
    expect(result.output.delivered).toContain("详情见任务面板");
    expect(Array.from(result.output.delivered).length).toBeLessThanOrEqual(200);
    expect(result.before).toEqual(result.after);
  }
});
