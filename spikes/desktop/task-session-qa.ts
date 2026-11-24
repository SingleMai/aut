// Isolated task-session UI fixture using the real HTTP API, reader and WebSocket notices.
// All session records are synthetic. No harness process or model is started.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Data, Deferred, Effect, Layer, Option, Queue, Schema } from "effect";
import {
  ConfigStore,
  CoreLive,
  EventBus,
  HarnessResolver,
  insertTaskWithSession,
  saveTask,
  SessionReaderLive,
  Store,
  StoredSessionSnapshotSourceLive,
} from "../../packages/core/dist/index.js";
import {
  AdministrationLive,
  AdmissionInboxLive,
  AuthenticationLive,
  ConfiguredTreeLive,
  HttpServer,
  HttpServerLive,
  InboundGatewayLive,
  McpOAuthLive,
  McpSupervisorLive,
  OwnershipLive,
  RecoveryLive,
  RouteTestLive,
  SecretReaderLive,
  SecretStoreLive,
} from "../../packages/daemon/dist/index.js";
import {
  AdapterError,
  BotId,
  type HarnessAdapter,
  MessageId,
  RequestId,
  type SessionContext,
  SessionHistory,
  type SessionItem,
  type SessionTurn,
  TaskId,
} from "../../packages/protocol/dist/index.js";

class FixtureError extends Data.TaggedError("FixtureError")<{ readonly message: string }> {}

const directory = mkdtempSync(join(tmpdir(), "aut-task-session-qa-"));
const now = Date.now();
const botId = BotId.make("qa-session-bot");
const taskId = TaskId.make("qa-session-full");
const requestId = RequestId.make("qa-session-question");
const parityTaskId = TaskId.make("qa-tool-parity");
const parityTurnId = "qa-parity-turn-1";
const parityLiveItemId = "qa-parity-live-command";
const currentTurnId = "qa-turn-12";
const liveItemId = "qa-live-command";
const longInput = [
  "[aut handoff packet — synthetic fixture]",
  "Task: 检查任务的完整工作会话",
  "User message: 请保留工具过程，先和 OpenMausBot 的交互对齐。",
  "Relevant context:",
  ...Array.from(
    { length: 28 },
    (_, index) => `  ${index + 1}. 合成交接上下文：这里不是用户逐字原话；展开应能查看完整文本。`,
  ),
  "END_OF_HANDOFF_PACKET",
].join("\n");
const commandOutput = [
  "Synthetic verification output; no command was executed.",
  ...Array.from(
    { length: 100 },
    (_, index) => `check ${String(index + 1).padStart(3, "0")}: passed`,
  ),
  "END_OF_COMMAND_OUTPUT",
].join("\n");

const historicalTurns: SessionTurn[] = Array.from({ length: 11 }, (_, index) => {
  const number = index + 1;
  const id = `qa-turn-${String(number).padStart(2, "0")}`;
  const at = now - (13 - number) * 60_000;
  const status =
    number === 9
      ? "failed"
      : number === 5
        ? "interrupted"
        : number === 11
          ? "unknown"
          : "completed";
  const items: SessionItem[] = [
    {
      id: `${id}-user`,
      kind: "user",
      status: "completed",
      text: `第 ${number} 轮委托：检查会话里的第 ${number} 项工作。`,
      startedAt: at,
    },
    {
      id: `${id}-progress`,
      kind: "assistant",
      status: "completed",
      phase: "commentary",
      text: `第 ${number} 轮过程：正在阅读上下文并检查工具结果。`,
      startedAt: at + 1000,
    },
    {
      id: `${id}-tool`,
      kind: "tool",
      status,
      text: "",
      tool: {
        name: "commandExecution",
        input: `printf 'fixture-turn-${number}'`,
        output: number === 9 ? "Synthetic failure: exit status 1" : `fixture-turn-${number}`,
        ...(number === 9 ? { exitCode: 1 } : status === "completed" ? { exitCode: 0 } : {}),
      },
    },
    {
      id: `${id}-result`,
      kind: "assistant",
      status,
      phase: "final",
      text: `第 ${number} 轮结果：合成记录完整保留。\n<script>window.__taskSessionUnsafe = true</script>`,
      startedAt: at + 4000,
    },
  ];
  return {
    id,
    status,
    startedAt: at,
    ...(status === "completed" ? { completedAt: at + 5000 } : {}),
    ...(number === 9 ? { error: "合成失败记录：文件校验未通过。" } : {}),
    items,
  };
});

const initialCurrent: SessionTurn = {
  id: currentTurnId,
  status: "running",
  startedAt: now - 20_000,
  items: [
    {
      id: "qa-current-input",
      kind: "user",
      status: "completed",
      text: longInput,
      startedAt: now - 20_000,
    },
    {
      id: "qa-current-progress",
      kind: "assistant",
      status: "completed",
      phase: "commentary",
      text: "我已整理历史回合，正在检查命令、文件变更与 MCP 工具的展示。以下内容均为本地合成验收数据。",
      startedAt: now - 19_000,
    },
    {
      id: "qa-command-complete",
      kind: "tool",
      status: "completed",
      text: "",
      tool: {
        name: "commandExecution",
        input: "pnpm test -- task-session\n# Synthetic command, never executed",
        output: commandOutput,
        exitCode: 0,
      },
    },
    {
      id: "qa-file-change",
      kind: "tool",
      status: "completed",
      text: "已记录合成文件修改。",
      tool: {
        name: "fileChange",
        input: "apps/desktop/src/task-session-view.tsx",
        output:
          "*** Begin Patch\n+ readonly session transcript\n+ preserve expanded tools\n*** End Patch",
      },
    },
    {
      id: "qa-mcp-failed",
      kind: "tool",
      status: "failed",
      text: "工具返回了明确失败。",
      tool: {
        name: "mcp__fixture__read_document",
        input: '{"documentId":"synthetic-plan"}',
        output: '{"error":"Fixture document not found","code":"NOT_FOUND"}',
      },
    },
    {
      id: "qa-unknown-tool",
      kind: "tool",
      status: "unknown",
      text: "历史记录未确认完成状态。",
      tool: {
        name: "mcp__fixture__unknown_result",
        input: '{"check":"honest-status"}',
        output: "",
      },
    },
    {
      id: "qa-current-question-note",
      kind: "assistant",
      status: "completed",
      phase: "commentary",
      text: "有一个界面选择等你确认；异步问题未回答时，当前会话仍可继续记录工作。",
    },
    {
      id: liveItemId,
      kind: "tool",
      status: "running",
      text: "",
      tool: {
        name: "commandExecution",
        input: "synthetic-live-check --watch",
        output: `${commandOutput}\nLIVE_UPDATE_0`,
      },
    },
  ],
};
let history: SessionHistory = Schema.decodeUnknownSync(SessionHistory)({
  turns: [...historicalTurns, initialCurrent],
});
// The same statuses and ordering used by the upstream grouping fixtures, projected through aut's API.
let parityHistory: SessionHistory = Schema.decodeUnknownSync(SessionHistory)({
  turns: [
    {
      id: parityTurnId,
      status: "running",
      startedAt: now - 20_000,
      items: [
        {
          id: "qa-parity-input",
          kind: "user",
          status: "completed",
          startedAt: now - 20_000,
          text: "请检查工具展示：成功步骤要聚合，失败原因保持可见，最终回答留在外面。",
        },
        {
          id: "qa-parity-progress",
          kind: "assistant",
          status: "completed",
          phase: "commentary",
          startedAt: now - 19_000,
          text: "PARITY_PROGRESS：我会先检查成功步骤的分组，然后保留失败与未确认项。以下全是合成数据。",
        },
        ...[
          ["qa-parity-command-1", "commandExecution", "pnpm test -- synthetic-first"],
          ["qa-parity-command-2", "commandExecution", "pnpm test -- synthetic-second"],
          ["qa-parity-edit", "fileChange", "fixture/readonly.ts"],
          ["qa-parity-search", "webSearch", '{"query":"synthetic local fixture"}'],
          ["qa-parity-read", "Read", "fixture/README.md"],
          ["qa-parity-write", "Write", "fixture/result.txt"],
        ].map(([id, name, input], index) => ({
          id,
          kind: "tool",
          status: "completed",
          startedAt: now - 18_000 + index * 1000,
          text: "",
          tool: {
            name,
            input,
            output: index === 0 ? commandOutput : "SYNTHETIC_SUCCESS: no tool was executed.",
          },
        })),
        {
          id: "qa-parity-failed",
          kind: "tool",
          status: "failed",
          text: "",
          startedAt: now - 11_000,
          tool: {
            name: "mcp__fixture__read_document",
            input: '{"documentId":"synthetic-plan"}',
            output:
              '{"error":"PARITY_PROBLEM：文档不存在，请检查文档 ID 后重试。","code":"NOT_FOUND"}',
          },
        },
        {
          id: "qa-parity-unknown",
          kind: "tool",
          status: "unknown",
          text: "",
          startedAt: now - 10_000,
          tool: {
            name: "mcp__fixture__unknown_result",
            input: '{"check":"honest-status"}',
            output: "",
          },
        },
        {
          id: "qa-parity-progress-2",
          kind: "assistant",
          status: "completed",
          phase: "commentary",
          startedAt: now - 9_000,
          text: "PARITY_PROGRESS_2：失败原因与未确认状态应留在成功步骤组之外。",
        },
        {
          id: parityLiveItemId,
          kind: "tool",
          status: "running",
          text: "",
          startedAt: now - 8_000,
          tool: { name: "commandExecution", input: "synthetic-live-parity --watch", output: "" },
        },
      ],
    },
  ],
});
let updates = 0;
let reads = 0;
let startAttempts = 0;
let available = true;
let nativeContext: SessionContext = { usage: { tokens: 104000, window: 200000 } };
let holdNextRead = false;
let heldRead: Deferred.Deferred<void> | undefined;
const replacementHistory: SessionHistory = {
  turns: [
    {
      id: "qa-replacement-turn",
      status: "completed",
      items: [
        {
          id: "qa-replacement-result",
          kind: "assistant",
          status: "completed",
          phase: "final",
          text: "NEW_SESSION_ONLY：此记录属于切换后的会话。",
        },
      ],
    },
  ],
};

const blockedExecution = Effect.sync(() => {
  startAttempts += 1;
}).pipe(
  Effect.zipRight(
    Effect.fail(
      new AdapterError({
        code: "NotSupported",
        message: "Synthetic fixture never executes a harness",
      }),
    ),
  ),
);
const adapter = (instanceId: string): HarnessAdapter => ({
  kind: "fixture",
  capabilities: {
    resume: false,
    fork: false,
    steer: false,
    nativeFullAccess: false,
    transcript: false,
    sessionHistory: instanceId !== "qa-unsupported",
    sessionContext: instanceId !== "qa-unsupported",
    questions: { native: true, multiQuestion: true, multiSelect: true, freeText: true },
  },
  startSession: () => blockedExecution,
  resumeSession: () => blockedExecution,
  readSession: (cursor) =>
    Effect.gen(function* () {
      reads += 1;
      if (!available || instanceId === "qa-unavailable")
        return yield* Effect.fail(
          new AdapterError({ code: "TransportError", message: "Synthetic read unavailable" }),
        );
      const snapshot =
        cursor.data === "empty"
          ? { turns: [] }
          : cursor.data === "parity"
            ? parityHistory
            : cursor.data === "replacement"
              ? replacementHistory
              : history;
      if (holdNextRead) {
        holdNextRead = false;
        heldRead = yield* Deferred.make<void>();
        yield* Effect.sync(() =>
          console.log(JSON.stringify({ readHeld: true, cursor: cursor.data })),
        );
        yield* Deferred.await(heldRead);
      }
      const contextTurnId = cursor.data === "parity" ? parityTurnId : currentTurnId;
      const compaction = nativeContext.compaction
        ? { ...nativeContext.compaction, turnId: contextTurnId }
        : undefined;
      return {
        ...snapshot,
        context: { ...nativeContext, ...(compaction ? { compaction } : {}) },
        turns: snapshot.turns.map((turn) =>
          turn.id !== contextTurnId || !compaction
            ? turn
            : {
                ...turn,
                items: [
                  ...turn.items,
                  {
                    id: compaction.itemId,
                    kind: "note" as const,
                    noteKind: "context-compaction" as const,
                    text: "",
                    status: compaction.status,
                  },
                ],
              },
        ),
      };
    }),
});

// Keep the production API graph while replacing only the harness resolver with synthetic data.
const options = { dataDirectory: directory, port: 0 };
const core = Layer.merge(CoreLive(options), AdmissionInboxLive).pipe(
  Layer.provideMerge(OwnershipLive(options)),
);
const tree = ConfiguredTreeLive.pipe(
  Layer.provideMerge(
    Layer.merge(core, SecretReaderLive.pipe(Layer.provideMerge(SecretStoreLive(options)))),
  ),
);
const services = Layer.mergeAll(
  AuthenticationLive,
  RecoveryLive,
  InboundGatewayLive,
  AdministrationLive,
  RouteTestLive,
).pipe(
  Layer.provideMerge(
    McpSupervisorLive.pipe(Layer.provide(McpOAuthLive), Layer.provideMerge(tree)),
  ),
);
const readers = SessionReaderLive.pipe(
  Layer.provideMerge(
    Layer.merge(
      Layer.succeed(HarnessResolver, {
        resolve: (instanceId) => Effect.succeed(adapter(instanceId)),
      }),
      StoredSessionSnapshotSourceLive,
    ).pipe(Layer.provideMerge(services)),
  ),
);
const fixtureRuntime = HttpServerLive(0).pipe(Layer.provideMerge(readers));

const commandNames = [
  "context-start",
  "context-complete",
  "context-usage",
  "context-window-unknown",
  "audit",
  "tick",
  "finish",
  "unavailable",
  "available",
  "bury-question",
  "activity",
  "report",
  "hold-read",
  "switch-session",
  "release-read",
] as const;
const Command = Schema.Struct({ command: Schema.Literal(...commandNames) });
const freePort = Effect.async<number, FixtureError>((resume) => {
  const server = createServer();
  server.once("error", () =>
    resume(Effect.fail(new FixtureError({ message: "Cannot allocate preview port" }))),
  );
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : 0;
    server.close(() =>
      resume(
        port
          ? Effect.succeed(port)
          : Effect.fail(new FixtureError({ message: "Missing preview port" })),
      ),
    );
  });
  return Effect.sync(() => server.close());
});

const program = Effect.scoped(
  Effect.gen(function* () {
    const store = yield* Store;
    const config = yield* ConfigStore;
    const bus = yield* EventBus;
    yield* config.writeConfig({
      harnessInstances: ["qa-supported", "qa-unsupported", "qa-unavailable"].map((id) => ({
        id,
        name: id,
        kind: "codex",
        command: "fixture-never-executes",
        args: [],
      })),
    });
    yield* config.writeBots([
      {
        id: botId,
        name: "会话验收助手",
        description: "Synthetic session UI checks.",
        soul: "Never execute a harness in this fixture.",
        cwd: directory,
        modelSelection: { instanceId: "qa-supported", model: "fixture-only" },
      },
    ]);
    yield* store.transaction((tx) =>
      Effect.gen(function* () {
        for (const [id, title, instanceId, cursor] of [
          [taskId, "完整工作会话 · 12 轮", "qa-supported", "full"],
          ["qa-session-pending", "尚未建立的会话", "qa-supported", undefined],
          ["qa-session-unsupported", "不支持历史读取", "qa-unsupported", "unsupported"],
          ["qa-session-unavailable", "暂时无法读取", "qa-unavailable", "unavailable"],
          ["qa-session-empty", "没有回合的会话", "qa-supported", "empty"],
          [parityTaskId, "工具规则一致性 · 单轮", "qa-supported", "parity"],
        ] as const) {
          yield* insertTaskWithSession(tx, {
            id: TaskId.make(id),
            botId,
            title,
            status: id === taskId ? "waiting_user" : id === parityTaskId ? "running" : "idle",
            createdAt: now - 900_000,
            updatedAt: now,
            lastActivityAt: now,
            session: {
              instanceId,
              ...(cursor ? { cursor: { kind: "fixture", data: cursor } } : {}),
            },
            pendingRequestIds: id === taskId ? [requestId] : [],
            queue: [],
            origin: { kind: "user" },
            ...(id === taskId
              ? {
                  lastReport: {
                    full: "ORIGINAL_REPORT：此最近报告用于检查展开与焦点保留。",
                    delivered: "合成报告",
                    rewrites: 0,
                  },
                }
              : {}),
          });
        }
        const request = {
          id: requestId,
          taskId,
          kind: "question" as const,
          openedAt: now,
          raw: null,
          questions: [
            {
              id: "display",
              text: "工作会话是否默认保留工具过程？",
              options: [
                { id: "full", label: "保留完整过程" },
                { id: "compact", label: "仅展示结果" },
              ],
              multiSelect: false,
              allowFreeText: true,
            },
          ],
        };
        yield* tx.insert("session_requests", { id: requestId, taskId, request, state: "open" });
        yield* tx.insert("main_thread_messages", {
          id: MessageId.make("qa-session-origin"),
          at: now - 30_000,
          author: "user",
          kind: "text",
          text: "先把任务详情做成完整工作会话，保留工具过程。",
          taskId,
        });
        yield* tx.insert("main_thread_messages", {
          id: MessageId.make("qa-session-question-message"),
          at: now,
          author: { botId, taskId },
          kind: "question-card",
          text: "请选择会话展示范围",
          taskId,
          card: {
            id: "qa-session-question-card",
            requestId,
            prompt: "请选择会话展示范围",
            state: "open",
            options: [],
            multiSelect: false,
            allowFreeText: true,
          },
        });
      }),
    );
    const audit = store.transaction((tx) =>
      Effect.gen(function* () {
        const events = yield* tx.list("events", { limit: Number.MAX_SAFE_INTEGER });
        const messages = yield* tx.list("main_thread_messages", { limit: Number.MAX_SAFE_INTEGER });
        return {
          reads,
          startAttempts,
          updates,
          available,
          readHeld: heldRead !== undefined,
          messageCount: messages.length,
          turnCount: history.turns.length,
          parityTurnCount: parityHistory.turns.length,
          parityItemCount: parityHistory.turns.flatMap((turn) => turn.items).length,
          liveItemCount: history.turns
            .flatMap((turn) => turn.items)
            .filter((item) => item.id === liveItemId).length,
          userActions: events.filter((entry) => entry.event.source === "user"),
        };
      }),
    );
    const commands = yield* Effect.acquireRelease(Queue.unbounded<string>(), Queue.shutdown);
    const reader = yield* Effect.acquireRelease(
      Effect.sync(() => createInterface({ input: process.stdin })),
      (reader) => Effect.sync(() => reader.close()),
    );
    reader.on("line", (line) => Effect.runFork(Queue.offer(commands, line)));
    yield* Effect.forever(
      Queue.take(commands).pipe(
        Effect.flatMap((line) =>
          Effect.gen(function* () {
            const command = yield* Schema.decodeUnknown(Schema.parseJson(Command))(line, {
              onExcessProperty: "error",
            });
            if (command.command === "tick" || command.command === "finish") {
              const finished = command.command === "finish";
              updates += 1;
              history = {
                turns: history.turns.map((turn) =>
                  turn.id !== currentTurnId
                    ? turn
                    : {
                        ...turn,
                        status: finished ? "completed" : "running",
                        ...(finished ? { completedAt: Date.now() } : {}),
                        items: [
                          ...turn.items
                            .filter((item) => item.id !== "qa-current-final")
                            .map((item) =>
                              item.id !== liveItemId
                                ? item
                                : {
                                    ...item,
                                    status: finished
                                      ? ("completed" as const)
                                      : ("running" as const),
                                    tool: {
                                      name: "commandExecution",
                                      input: "synthetic-live-check --watch",
                                      output: `${commandOutput}\nLIVE_UPDATE_${updates}`,
                                      ...(finished ? { exitCode: 0 } : {}),
                                    },
                                  },
                            ),
                          ...(finished
                            ? [
                                {
                                  id: "qa-current-final",
                                  kind: "assistant" as const,
                                  status: "completed" as const,
                                  phase: "final" as const,
                                  text: "验收完成：历史、工具步骤和最终结果都保留在同一工作会话。\nEND_OF_CURRENT_RESULT",
                                },
                              ]
                            : []),
                        ],
                      },
                ),
              };
              history = yield* Schema.decodeUnknown(SessionHistory)(history);
              parityHistory = yield* Schema.decodeUnknown(SessionHistory)({
                turns: parityHistory.turns.map((turn) => ({
                  ...turn,
                  status: finished ? "completed" : "running",
                  ...(finished ? { completedAt: Date.now() } : {}),
                  items: [
                    ...turn.items
                      .filter((item) => item.id !== "qa-parity-final")
                      .map((item) =>
                        item.id !== parityLiveItemId
                          ? item
                          : {
                              ...item,
                              status: finished ? "completed" : "running",
                              tool: {
                                name: "commandExecution",
                                input: "synthetic-live-parity --watch",
                                output: `${commandOutput}\nPARITY_LIVE_UPDATE_${updates}`,
                                ...(finished ? { exitCode: 0 } : {}),
                              },
                            },
                      ),
                    ...(finished
                      ? [
                          {
                            id: "qa-parity-final",
                            kind: "assistant",
                            status: "completed",
                            phase: "final",
                            text: "PARITY_FINAL：成功步骤已归组，进度、失败原因、未确认状态和最终结果仍在外面。",
                            completedAt: Date.now(),
                          },
                        ]
                      : []),
                  ],
                })),
              });
              yield* store.transaction((tx) =>
                Effect.gen(function* () {
                  const found = yield* tx.get("tasks", parityTaskId);
                  if (Option.isSome(found))
                    yield* saveTask(tx, {
                      ...found.value,
                      status: finished ? "idle" : "running",
                      updatedAt: Date.now(),
                      lastActivityAt: Date.now(),
                    });
                }),
              );
            }
            if (command.command === "unavailable") available = false;
            if (command.command === "available") available = true;
            if (command.command === "context-start" || command.command === "context-complete")
              nativeContext = {
                compaction: {
                  turnId: currentTurnId,
                  itemId: "qa-context-compaction",
                  status: command.command === "context-start" ? "running" : "completed",
                },
              };
            if (command.command === "context-usage")
              nativeContext = { ...nativeContext, usage: { tokens: 24000, window: 200000 } };
            if (command.command === "context-window-unknown")
              nativeContext = { ...nativeContext, usage: { tokens: 24000 } };
            if (command.command === "bury-question") {
              yield* store.transaction((tx) =>
                Effect.gen(function* () {
                  for (let index = 0; index < 60; index++)
                    yield* tx.insert("main_thread_messages", {
                      id: MessageId.make(`qa-later-notice-${crypto.randomUUID()}`),
                      at: Date.now() + index,
                      author: "chief",
                      kind: "notice",
                      text: `合成后续记录 ${index + 1}：将待答问题移到首次 50 条分页之外。`,
                    });
                }),
              );
            }
            if (
              command.command === "activity" ||
              command.command === "report" ||
              command.command === "switch-session"
            ) {
              yield* store.transaction((tx) =>
                Effect.gen(function* () {
                  const found = yield* tx.get("tasks", taskId);
                  if (Option.isNone(found))
                    return yield* Effect.fail(
                      new FixtureError({ message: "Missing synthetic task" }),
                    );
                  yield* saveTask(tx, {
                    ...found.value,
                    updatedAt: Date.now(),
                    lastActivityAt: Date.now(),
                    ...(command.command === "report"
                      ? {
                          lastReport: {
                            full: "UPDATED_REPORT：报告变化后仍应保留展开和键盘焦点。",
                            delivered: "更新后的合成报告",
                            rewrites: 0,
                          },
                        }
                      : {}),
                    ...(command.command === "switch-session"
                      ? {
                          session: {
                            instanceId: "qa-supported",
                            cursor: { kind: "fixture", data: "replacement" },
                          },
                        }
                      : {}),
                  });
                }),
              );
            }
            if (command.command === "hold-read") holdNextRead = true;
            if (command.command === "release-read" && heldRead) {
              yield* Deferred.succeed(heldRead, undefined);
              heldRead = undefined;
            }
            if (["tick", "finish", "unavailable", "available"].includes(command.command) || command.command.startsWith("context-")) {
              const event = {
                source: "session" as const,
                kind: "session.changed" as const,
                taskId,
                event: {
                  kind: "session.changed" as const,
                  turnId: currentTurnId,
                  itemId: liveItemId,
                },
              };
              yield* bus.publish(event);
              yield* bus.publish(event);
              yield* bus.publish({
                ...event,
                taskId: parityTaskId,
                event: { ...event.event, turnId: parityTurnId, itemId: parityLiveItemId },
              });
            }
            const receipt = yield* audit;
            yield* Effect.sync(() => {
              writeFileSync(
                join(directory, "audit.json"),
                `${JSON.stringify(receipt, null, 2)}\n`,
                { mode: 0o600 },
              );
              console.log(JSON.stringify({ command: command.command, ...receipt }));
            });
          }).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => console.log(JSON.stringify({ error: String(error) }))),
            ),
          ),
        ),
      ),
    ).pipe(Effect.forkScoped);
    const server = yield* HttpServer;
    const previewPort = yield* freePort;
    const preview = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const child = spawn(process.execPath, [resolve("apps/desktop/scripts/preview.mjs")], {
          env: {
            ...process.env,
            AUT_DATA_DIR: directory,
            AUT_PORT: String(server.port),
            AUT_PREVIEW_PORT: String(previewPort),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
        child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
        return child;
      }),
      (child) =>
        Effect.sync(() => {
          if (child.exitCode === null) child.kill("SIGTERM");
        }),
    );
    const receipt = {
      directory,
      apiPort: server.port,
      previewPort,
      url: `http://127.0.0.1:${previewPort}`,
      fixturePid: process.pid,
      previewPid: preview.pid,
      taskId,
      currentTurnId,
      liveItemId,
      requestId,
      parityTaskId,
      parityTurnId,
      parityLiveItemId,
      commands: commandNames,
    };
    yield* Effect.sync(() => {
      writeFileSync(join(directory, "runtime.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
        mode: 0o600,
      });
      console.log(JSON.stringify(receipt));
    });
    yield* Effect.async<void>((resume) => {
      const stop = () => resume(Effect.void);
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      return Effect.sync(() => {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      });
    });
  }).pipe(Effect.provide(fixtureRuntime)),
);

await Effect.runPromise(program);
