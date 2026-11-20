// Opt-in, synthetic main-thread acceptance. All mutations use the public desktop API.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import {
  AcceptedResponse,
  BotResponse,
  BotsResponse,
  MessageResponse,
} from "../../packages/protocol/dist/index.js";
import { assert, configurePrimary, createEcho, fixtureDirectory, withDaemon, writeEvidence } from "./support.ts";

if (!process.env.TYPESAFE_API_KEY)
  throw new Error("TYPESAFE_API_KEY is required for this opt-in live acceptance probe");
const cliVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
const dataDirectory = fixtureDirectory();
console.log(JSON.stringify({ stage: "starting", dataDirectory, cliVersion }));
const result = await Effect.runPromise(
  withDaemon(dataDirectory, (api) =>
    Effect.gen(function* () {
      const primary = yield* configurePrimary(api);
      const freshBots = (yield* api.request("/v1/bots", BotsResponse)).bots;
      yield* assert(freshBots.length === 1 && freshBots[0]?.name === "aut", "Fresh installation must expose just aut");
      const direct = yield* api.request("/v1/messages", MessageResponse, "POST", {
        id: "primary-direct", text: "请计算 37 加 48 的结果，用一句中文回答。",
      });
      const directReplies = yield* api.wait(api.messages, (rows) => rows.some((m) => m.kind === "reply"), "180 seconds");
      const directReply = directReplies.find((m) => m.kind === "reply");
      const directTask = (yield* api.tasks).find((task) => task.id === directReply?.taskId);
      yield* assert(directTask?.botId === primary.id && directTask.origin.kind === "user" && directReply?.text.includes("85"), "The only installed assistant did not perform ordinary work");
      const directAck = directReplies.find((m) => m.dispatch?.botId === primary.id);
      yield* assert(directAck, "Missing direct dispatch acknowledgement");
      const directAckMs = directAck!.at - direct.message.at;
      const priorMessages = new Set(directReplies.map((row) => row.id));
      console.log(JSON.stringify({ stage: "primary-work-completed", directAckMs }));
      const echo = yield* createEcho(api, dataDirectory, primary);
      const messageId = "e2e-slow-coordination";
      yield* api.request(`/v1/bots/${echo.id}`, BotResponse, "PUT", {
        ...echo,
        soul: `${echo.soul}\nThis synthetic fixture tests role separation. When the original request includes SLOW_COORDINATION_FIXTURE, your assigned worker task is only to report in Chinese: 回声任务已完成，协调链路验证通过。 Do not propose routes or repeat the slow-brain coordination instructions.`,
      });
      yield* api.request(`/v1/bots/${primary.id}`, BotResponse, "PUT", {
        ...primary,
        cwd: dataDirectory,
        modelSelection: { ...primary.modelSelection, effort: "low" },
        soul: `${primary.soul}\nSynthetic fixture SLOW_COORDINATION_FIXTURE: use only the aut MCP tools. Read the original main-thread message e2e-slow-coordination and list current tasks. Then call propose_route exactly once with {"op":{"op":"new","botId":"${echo.id}","requestMessageIds":["${messageId}"]},"rationale":"The user requested a separate echo verification worker after coordination."}. Do not send this proposal through shell commands, direct HTTP or files. If accepted, report briefly in Chinese that the echo task was submitted and that submission is not completion. Do not ask questions; the fixture supplies all inputs.`,
      });
      console.log(JSON.stringify({ stage: "configured", model: echo.modelSelection.model }));
      const submittedAt = Date.now();
      yield* api.request("/v1/messages", MessageResponse, "POST", {
        id: messageId,
        text: "我想先讨论并协调两件事：一是想清楚这次联合需求该如何拆分，二是让回声助手单独完成回声验证。请慢脑先想一想并通过提议工具把具体验证工作交给回声助手，别把派活当成完成。SLOW_COORDINATION_FIXTURE。",
      });
      const admitted = yield* api.wait(
        api.messages,
        (messages) => messages.some((message) => !priorMessages.has(message.id) && message.author === "chief"),
      );
      const initialResponse = admitted.find((message) => !priorMessages.has(message.id) && message.author === "chief");
      let usedClarification = false;
      if (initialResponse?.kind === "clarify-card" && initialResponse.card) {
        yield* assert(initialResponse.card.options.some((option) => option.id === "none"), "The clarification has no visible slow-brain choice");
        usedClarification = true;
        yield* api.request("/v1/actions", AcceptedResponse, "POST", {
          type: "card-choice", cardId: initialResponse.card.id, optionId: "none",
        });
      }
      const acknowledgements = yield* api.wait(
        api.messages,
        (messages) => messages.some((message) => message.kind === "ack" && message.text === "我想想"),
      );
      const slowAcknowledgement = acknowledgements.find((message) => message.kind === "ack" && message.text === "我想想");
      const acknowledgementMs = Date.now() - submittedAt;
      console.log(JSON.stringify({ stage: "slow-acknowledged", acknowledgementMs, usedClarification }));
      const proposed = yield* api.wait(
        api.logs,
        (logs) => logs.some((log) => log.path.includes("propose_route") && log.execution.ok),
        "180 seconds",
      );
      const proposal = proposed.find((log) => log.path.includes("propose_route") && log.execution.ok);
      yield* assert(proposal?.input.eventRef.startsWith("mcp:"), "The route proposal did not enter via native MCP");
      yield* assert(proposal?.output && "op" in proposal.output && proposal.output.op === "new" && proposal.output.botId === echo.id, "The slow brain did not propose the intended worker");
      console.log(JSON.stringify({ stage: "proposal-accepted", decisionLogId: proposal!.id }));
      const tasks = yield* api.wait(
        api.tasks,
        (tasks) => tasks.some((task) => task.botId === echo.id && task.status === "idle") && tasks.some((task) => task.botId === primary.id && task.origin.kind === "coordination" && task.status === "idle"),
        // Both independent sessions can each run two native rewrite forks before becoming idle.
        "6 minutes",
      );
      const worker = tasks.find((task) => task.botId === echo.id);
      const slowTask = tasks.find((task) => task.botId === primary.id && task.origin.kind === "coordination");
      yield* assert(worker && slowTask && worker.id !== slowTask.id, "The proposal did not create a separate normal task");
      yield* assert(slowTask!.origin.kind === "coordination" && slowTask!.origin.decisionLogId === slowAcknowledgement?.decisionLogId, "The slow task lost its immutable source decision");
      const messages = yield* api.messages;
      const workerReply = messages.find((message) => message.kind === "reply" && message.taskId === worker!.id);
      const slowReply = messages.find((message) => message.kind === "reply" && message.taskId === slowTask!.id);
      yield* assert(workerReply?.text.includes("协调链路验证通过"), "The proposed worker did not produce the expected report");
      yield* assert(slowReply && slowReply.text.length <= 200, "The slow-brain report did not pass the shared reply path");
      const events = yield* api.events;
      yield* assert(!events.some((entry) => entry.event.source === "session" && entry.event.event.kind === "request.opened" && entry.event.event.request.kind === "question"), "The fully specified fixture unexpectedly required user input");
      const logs = yield* api.logs;
      yield* assert(logs.filter((log) => log.path.includes("propose_route")).length === 1, "The worker proposal was submitted more than once");
      yield* assert(logs.some((log) => log.tree === "reply-gate" && log.execution.ok), "The reply gate was bypassed");
      return { at: new Date().toISOString(), cliVersion, model: echo.modelSelection.model, dataDirectory, primaryBotId: primary.id, directTaskId: directTask!.id, directAckMs, acknowledgementMs, usedClarification, tasks, messages, decisionLogs: logs, nativeQuestionCount: 0 };
    }),
  ).pipe(Effect.timeout("10 minutes")),
);
const output = process.env.AUT_E2E_RESULT ?? join(dataDirectory, "slow-brain-result.json");
await Effect.runPromise(writeEvidence(output, result));
console.log(JSON.stringify({ stage: "complete", output, taskCount: result.tasks.length, acknowledgementMs: result.acknowledgementMs }));
