// Local desktop QA fixture: real API, synthetic pending question, no external model calls.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { DaemonApiLive, HttpServer } from "../../packages/daemon/dist/index.js";
import { Store } from "../../packages/core/dist/index.js";
import { MessageId, RequestId, SessionRequest, TaskId } from "../../packages/protocol/dist/index.js";

const directory = mkdtempSync(join(tmpdir(), "aut-desktop-settings-"));
const program = Effect.scoped(Effect.gen(function* () {
  const request = Schema.decodeUnknownSync(SessionRequest)({
    id: RequestId.make("qa-registered"), taskId: TaskId.make("qa-task"), kind: "question", openedAt: Date.now(), raw: null,
    questions: [{ id: "color", text: "合成测试：选择颜色", options: [{ id: "blue", label: "蓝色" }, { id: "green", label: "绿色" }], multiSelect: false, allowFreeText: true }],
  });
  yield* (yield* Store).transaction((tx) => Effect.gen(function* () {
    yield* tx.insert("session_requests", { id: request.id, taskId: request.taskId, request, state: "open", answerClaim: { claimId: "qa-claim", answer: { perQuestion: [{ questionId: "color", optionIds: ["blue"] }] }, decisionLogId: "qa-log", phase: "registered", updatedAt: Date.now() } });
    yield* tx.insert("main_thread_messages", { id: MessageId.make("qa-question-card"), at: Date.now(), author: "chief", kind: "question-card", text: "请回答合成测试问题", card: { id: "qa-card", requestId: request.id, prompt: "请回答合成测试问题", state: "open", options: [], multiSelect: false, allowFreeText: true } });
  }));
  const server = yield* HttpServer;
  console.log(JSON.stringify({ directory, port: server.port }));
  yield* Effect.async<void>((resume) => {
    const stop = () => resume(Effect.void);
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    return Effect.sync(() => { process.off("SIGTERM", stop); process.off("SIGINT", stop); });
  });
}).pipe(Effect.provide(DaemonApiLive({ dataDirectory: directory, port: 0 }))));
await Effect.runPromise(program);
