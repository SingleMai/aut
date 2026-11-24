import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Classifier } from "@aut/classifier/interface";
import {
  BotConfig,
  ClassifierError,
  type Classifier as ClassifierShape,
  type DecisionRequest,
  type MainThreadMessage,
  MessageId,
  Task,
  TaskId,
  Timestamp,
} from "@aut/protocol";
import { Effect, Layer, Option, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { ConfigStore } from "../config-store.js";
import { DecisionLog } from "../decision-log.js";
import { type DecisionTree, DecisionTreeLive } from "../decision-tree/engine.js";
import { CoreLive } from "../index.js";
import { HandoffBuilder } from "../session-manager/ports.js";
import { Store } from "../store.js";
import { insertTaskWithSession } from "../task-registry.js";
import { buildHandoff, HandoffBuilderLive } from "./builder.js";
import { EXCERPT_HEADING, estimateTokens, renderExcerpt, renderHandoff } from "./render.js";

const bot = Schema.decodeUnknownSync(BotConfig)({
  id: "bot",
  name: "General",
  description: "General work",
  soul: "Private soul never injected by handoff",
  modelSelection: { instanceId: "test", model: "fixed" },
  cwd: "/tmp",
  system: "primary",
});
const task = Schema.decodeUnknownSync(Task)({
  id: "task",
  botId: "bot",
  title: "Synthetic task",
  status: "running",
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1,
  session: { instanceId: "test" },
  pendingRequestIds: [],
  queue: [],
  origin: { kind: "user" },
});
const message = (id: string, at: number, text = id): MainThreadMessage => ({
  id: MessageId.make(id),
  at: Timestamp.make(at),
  author: "user",
  kind: "text",
  text,
});
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const run = <A, E>(
  effect: Effect.Effect<A, E, Store | ConfigStore | DecisionLog | DecisionTree>,
  decide?: ClassifierShape["decide"],
) => {
  const directory = mkdtempSync(join(tmpdir(), "aut-handoff-"));
  directories.push(directory);
  const layer = DecisionTreeLive().pipe(
    Layer.provideMerge(CoreLive({ dataDirectory: directory })),
    Layer.provide(
      Layer.succeed(Classifier, {
        backend: "mock",
        model: "deterministic",
        decide:
          decide ??
          ((request) =>
            Effect.succeed({
              answers: Object.fromEntries(
                Object.keys(request.questions).map((key) => [
                  key,
                  { type: "noul" as const, noul: 1 },
                ]),
              ),
              latencyMs: 0,
            })),
      }),
    ),
  );
  return Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(layer))));
};
const seed = (
  messages: readonly MainThreadMessage[],
  bots: readonly BotConfig[] = [bot],
  tasks: readonly Task[] = [task],
) =>
  Effect.gen(function* () {
    yield* (yield* ConfigStore).writeBots(bots);
    yield* (yield* Store).transaction((tx) =>
      Effect.gen(function* () {
        for (const message of messages) yield* tx.insert("main_thread_messages", message);
        for (const value of tasks) yield* insertTaskWithSession(tx, value);
      }),
    );
  });

it("selects only the preceding twenty and batches them once, excluding requests and later arrivals", async () => {
  let captured: DecisionRequest | undefined;
  await run(
    Effect.gen(function* () {
      const previous = Array.from({ length: 25 }, (_, index) => message(`m${index}`, index));
      const first = message("request-a", 30, "First request, preserved verbatim.");
      const second = message("request-b", 31, "第二条用户原话");
      yield* seed([
        ...previous,
        first,
        message("between", 30, "Never part of the earlier request's context"),
        second,
        message("future", 40),
      ]);
      const result = yield* buildHandoff(
        { task, bot, messages: [second, first], mode: "new" },
        { excerptTokenBudget: 20_000 },
      );
      expect(result.packet.request.map((value) => value.messageId)).toEqual([
        "request-a",
        "request-b",
      ]);
      expect(result.packet.request.map((value) => value.text)).toEqual([first.text, second.text]);
      expect(result.packet.excerpts.map((value) => value.messageId)).toEqual(
        previous.slice(-20).map((value) => value.id),
      );
      expect(result.turn.messageIds).toEqual(["request-a", "request-b"]);
      expect(result.turn.text).not.toContain("future");
      expect(result.turn.text).not.toContain("Private soul");
      const log = yield* (yield* DecisionLog).get(result.decisionLogId);
      expect(Option.isSome(log) && log.value.execution.ok).toBe(true);
    }),
    (request) => {
      captured = request;
      return Effect.succeed({
        answers: Object.fromEntries(
          Object.keys(request.questions).map((key) => [key, { type: "noul" as const, noul: 0.8 }]),
        ),
        latencyMs: 0,
      });
    },
  );
  expect(Object.keys(captured?.questions ?? {})).toHaveLength(20);
  expect(JSON.stringify(captured)).not.toContain("Never part");
});

it("hands the exact attachment snapshot to a follow-up without injecting file contents", async () => {
  await run(
    Effect.gen(function* () {
      const file = {
        id: "a".repeat(64),
        sha256: "b".repeat(64),
        name: "data.csv",
        mime: "text/csv",
        size: 1234,
        path: "/tmp/snapshots/data.csv",
      };
      const request = { ...message("files", 1, "继续修改"), files: [file] };
      yield* seed([request]);
      const result = yield* buildHandoff({ task, bot, messages: [request], mode: "send" });
      expect(result.packet.request[0]?.files).toEqual([file]);
      expect(result.turn.text).toContain(file.path);
      expect(result.turn.text).toContain("read only");
      expect(result.turn.text).toContain("继续修改");
    }),
  );
});

it("keeps UTF-8 excerpt metadata within budget without truncating the user request", async () => {
  await run(
    Effect.gen(function* () {
      const previous = message("context", 1, "中文上下文😀");
      const request = message("request", 2, "长原话".repeat(1_000));
      yield* seed([previous, request]);
      const cost =
        estimateTokens(EXCERPT_HEADING) +
        estimateTokens(
          `${renderExcerpt({ messageId: previous.id, at: previous.at, author: "user", text: previous.text })}\n`,
        );
      const included = yield* buildHandoff(
        { task, bot, messages: [request], mode: "new" },
        { excerptTokenBudget: cost },
      );
      expect(included.packet.excerpts).toHaveLength(1);
      expect(
        estimateTokens(
          `${EXCERPT_HEADING}${included.packet.excerpts.map(renderExcerpt).join("\n")}`,
        ),
      ).toBeLessThanOrEqual(cost);
      expect(included.packet.request[0]?.text).toBe(request.text);
      const omitted = yield* buildHandoff(
        { task, bot, messages: [request], mode: "new" },
        { excerptTokenBudget: cost - 1 },
      );
      expect(omitted.packet.excerpts).toEqual([]);
      expect(omitted.turn.text).toContain(request.text);
    }),
  );
});

it("falls back to at most two budgeted recent messages without fabricating relevance", async () => {
  await run(
    Effect.gen(function* () {
      const request = message("request", 4);
      yield* seed([message("old", 1), message("recent-a", 2), message("recent-b", 3), request]);
      const result = yield* buildHandoff({ task, bot, messages: [request], mode: "send" });
      expect(result.packet.excerpts.map((value) => value.messageId)).toEqual([
        "recent-a",
        "recent-b",
      ]);
      expect(result.packet.excerpts.every((value) => !Object.hasOwn(value, "relevance"))).toBe(
        true,
      );
      expect(result.turn.text).toContain("follow-up");
      expect(result.packet.relatedTasks).toEqual([]);
      const log = yield* (yield* DecisionLog).get(result.decisionLogId);
      expect(Option.isSome(log) && log.value.execution.degraded?.[0]).toContain(
        "Classifier unavailable",
      );
      const zero = yield* buildHandoff(
        { task, bot, messages: [request], mode: "send" },
        { excerptTokenBudget: 0 },
      );
      expect(zero.packet.excerpts).toEqual([]);
      expect(zero.turn.text).toContain("read_main_thread");
    }),
    () =>
      Effect.fail(new ClassifierError({ code: "TransportError", message: "Synthetic failure" })),
  );
});

it("uses fixed snapshots for multi-message requests, task references and slow-brain summaries", async () => {
  await run(
    Effect.gen(function* () {
      const slowBot: BotConfig = { ...bot, system: "primary" };
      const slowTask: Task = { ...task, origin: { kind: "coordination", decisionLogId: "route" } };
      const related: Task = {
        ...task,
        id: TaskId.make("related"),
        title: "Earlier task",
        status: "idle",
        lastReport: {
          full: "Private full report never injected",
          delivered: "A prior result",
          rewrites: 0,
        },
      };
      const context: MainThreadMessage = {
        ...message("context", 1, "Context text"),
        author: { botId: bot.id, taskId: related.id },
        taskId: related.id,
      };
      const request = message("request", 2, "Please continue.");
      const second = message("request-next", 3, "Also keep both original requests intact.");
      yield* seed([context, request, second], [slowBot], [slowTask, related]);
      yield* (yield* DecisionLog).write({
        id: "route",
        at: Timestamp.make(1),
        tree: "inbound",
        treeVersion: "1",
        input: { eventRef: "request", state: {}, dynamicOptions: {} },
        classifierCalls: [],
        path: ["classify", "slow"],
        output: {
          op: "escalate",
          reason: "Ambiguous routing requires deliberate review",
          decisionLogId: "route",
          messageIds: [request.id],
        },
        execution: { ok: true },
      });
      const result = yield* buildHandoff({
        task: slowTask,
        bot: slowBot,
        messages: [request, second],
        mode: "new",
      });
      expect(result.packet.excerpts[0]?.author).toBe("General (bot bot; task related)");
      expect(result.packet.excerpts[0]?.relevance).toBe(1);
      expect(result.packet.relatedTasks).toEqual([
        { taskId: "related", bot: "General", status: "idle", title: "Earlier task" },
      ]);
      expect(result.packet.decisionSummary).toContain("Ambiguous routing");
      const direct = yield* buildHandoff({
        task: { ...slowTask, origin: { kind: "user", decisionLogId: "route" } },
        bot: slowBot,
        messages: [request],
        mode: "new",
      });
      expect(direct.packet.decisionSummary).toBeUndefined();
      expect(result.turn.text).not.toContain("Private full report");
      expect(renderHandoff(result.packet)).toMatchSnapshot();
      const portResult = yield* (yield* HandoffBuilder).build({
        task: slowTask,
        bot: slowBot,
        messages: [request, second],
        mode: "send",
      });
      expect(portResult.text).toContain("follow-up");
      expect(portResult.text).not.toContain("[Routing decision]");
    }).pipe(Effect.provide(HandoffBuilderLive())),
  );
});

it("rejects missing request references or invalid budgets instead of injecting supplied text", async () => {
  await run(
    Effect.gen(function* () {
      const request = message("request", 1);
      yield* seed([request]);
      for (const input of [
        { task, bot, messages: [message("missing", 2)], mode: "new" as const },
        { task, bot, messages: [request, request], mode: "new" as const },
      ])
        expect((yield* buildHandoff(input).pipe(Effect.either))._tag).toBe("Left");
      expect(
        (yield* buildHandoff(
          { task, bot, messages: [request], mode: "new" },
          { excerptTokenBudget: -1 },
        ).pipe(Effect.either))._tag,
      ).toBe("Left");
      const result = yield* buildHandoff({
        task,
        bot,
        messages: [{ ...request, text: "Forged replacement" }],
        mode: "new",
      });
      expect(result.packet.request[0]?.text).toBe("request");
    }),
  );
});

it.each([
  { name: "clock rollback", firstAt: 1_000, secondAt: 0 },
  { name: "equal timestamps", firstAt: 5, secondAt: 5 },
])("preserves Store insertion order across pages with $name", async ({ firstAt, secondAt }) => {
  await run(
    Effect.gen(function* () {
      const older = [message("older-a", 100), message("older-b", 50)];
      const first = message("first-request", firstAt, "First original request");
      const second = message("second-request", secondAt, "Second original request");
      const between = Array.from({ length: 105 }, (_, index) =>
        message(`between-${index}`, 5, "Later context must not leak"),
      );
      yield* seed([...older, first, ...between, second, message("future", 0)]);
      const result = yield* buildHandoff({ task, bot, messages: [second, first], mode: "new" });
      expect(result.packet.request.map((value) => value.messageId)).toEqual([first.id, second.id]);
      expect(result.packet.request.map((value) => value.at)).toEqual([firstAt, secondAt]);
      expect(result.packet.excerpts.map((value) => value.messageId)).toEqual([
        "older-a",
        "older-b",
      ]);
      expect(result.turn.text).not.toContain("Later context must not leak");
      expect(result.turn.text).not.toContain("future");
    }),
  );
});

it("rejects persisted bot, chief or card messages as original user requests", async () => {
  let classified = 0;
  await run(
    Effect.gen(function* () {
      const rejected: MainThreadMessage[] = [
        { ...message("bot-report", 1), author: { botId: bot.id, taskId: task.id }, kind: "reply" },
        { ...message("chief-ack", 2), author: "chief", kind: "ack" },
        { ...message("user-card", 3), kind: "question-card" },
      ];
      yield* seed(rejected);
      for (const request of rejected) {
        const result = yield* buildHandoff({ task, bot, messages: [request], mode: "new" }).pipe(
          Effect.either,
        );
        expect(result._tag === "Left" && result.left.message).toContain("original user text");
      }
    }),
    () => {
      classified += 1;
      return Effect.die("Must not classify rejected references");
    },
  );
  expect(classified).toBe(0);
});
