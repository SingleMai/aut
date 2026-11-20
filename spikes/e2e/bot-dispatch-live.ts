// Opt-in native validation using only synthetic requests and an isolated aut directory.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import {
  AcceptedResponse,
  BotResponse,
  BotsResponse,
  ConfigResponse,
  MessageResponse,
  RouteTestResponse,
  TaskSessionResponse,
  type MainThreadMessage,
} from "../../packages/protocol/dist/index.js";
import { assert, configure, fixtureDirectory, withDaemon, writeEvidence } from "./support.ts";

if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const directory = fixtureDirectory();
const cliVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
console.log(JSON.stringify({ stage: "starting", directory, cliVersion }));
const run = withDaemon(directory, (api) =>
  Effect.gen(function* () {
    const worker = yield* configure(api, directory);
    const bots = api.request("/v1/bots", BotsResponse);
    const manual = (yield* api.request(`/v1/bots/${worker.id}`, BotResponse, "PUT", {
      ...worker,
      name: "目录管理员",
      description: "根据用户要求新建普通 Bot，配置或登记助手，管理助手目录。",
      soul: "Use the aut create_bot MCP tool when asked to create a bot. Use provided fields, leave optional settings at their defaults, and report the result in one short Chinese sentence. For other synthetic tasks give a one-sentence response.",
    })).bot;
    const send = (id: string, text: string) =>
      api.request("/v1/messages", MessageResponse, "POST", { id, text });
    const action = (body: unknown) => api.request("/v1/actions", AcceptedResponse, "POST", body);
    const waitMessage = (predicate: (message: MainThreadMessage) => boolean) =>
      api
        .wait(api.messages, (rows) => rows.some(predicate), "180 seconds")
        .pipe(Effect.map((rows) => rows.find(predicate)!));
    const initial = yield* send(
      "catalog-request",
      "请目录管理员新建一个 Bot，ID 为 star-catalog，名称为星表助手，专长是按星座整理观测清单，长期指令是用中文简短回答。",
    );
    const dispatched = yield* waitMessage(
      (m) => m.kind === "ack" && m.dispatch?.botId === manual.id,
    );
    yield* assert(dispatched.decisionLogId, "Missing dispatch acknowledgement");
    const firstTask = `task:${dispatched.decisionLogId}`;
    const firstReply = yield* waitMessage((m) => m.kind === "reply" && m.taskId === firstTask);
    const created = (yield* bots).bots.find((b) => b.id === "star-catalog");
    yield* assert(
      created?.name === "星表助手" &&
        !created.system &&
        created.cwd === manual.cwd &&
        created.modelSelection.model === manual.modelSelection.model &&
        created.mcpServers.length === 0,
      "The ordinary Agent did not create the requested bot with inherited defaults",
    );
    const toolProof = (id: string) =>
      api.request(`/v1/tasks/${encodeURIComponent(id)}/session`, TaskSessionResponse).pipe(
        Effect.flatMap((page) =>
          Effect.gen(function* () {
            const tool = page.history.turns
              .flatMap((turn) => turn.items)
              .find((item) => item.tool?.name === "aut.create_bot" && item.status === "completed");
            yield* assert(tool?.tool, "No completed create_bot call in the native session");
            return {
              taskId: id,
              itemId: tool!.id,
              tool: tool!.tool!.name,
              result: tool!.tool!.output,
            };
          }),
        ),
      );
    const workerProof = yield* toolProof(firstTask);
    console.log(
      JSON.stringify({
        stage: "worker-created",
        taskId: firstTask,
        ackMs: dispatched.at - initial.message.at,
      }),
    );
    const routed = yield* api.request("/v1/route-test", RouteTestResponse, "POST", {
      text: "帮我按星座整理今晚的天文观测清单。",
    });
    yield* assert(
      routed.selectedBotId === created!.id,
      "The Chinese specialty did not select the newly created bot",
    );

    const settings = yield* api.request("/v1/config", ConfigResponse);
    yield* api.request("/v1/config", ConfigResponse, "PUT", {
      ...settings,
      classifier: { primary: { ...settings.classifier!.primary, backend: "offline-fixture" } },
    });
    yield* send(
      "slow-create",
      "请创建一个普通 Bot，ID 为 tide-tables，名称为潮汐助手，专长为整理潮汐表，长期指令为用中文回答。",
    );
    const card = yield* waitMessage(
      (m) => m.kind === "clarify-card" && m.card?.options.some((o) => o.id === "none") === true,
    );
    yield* api.request("/v1/config", ConfigResponse, "PUT", settings);
    yield* action({ type: "card-choice", cardId: card.card!.id, optionId: "none" });
    const slowTask = (yield* api.wait(api.tasks, (rows) =>
      rows.some((task) => task.origin.kind === "coordination"),
    )).find((task) => task.origin.kind === "coordination")!;
    yield* waitMessage((m) => m.kind === "reply" && m.taskId === slowTask.id);
    const slowBot = (yield* bots).bots.find((b) => b.id === "tide-tables");
    yield* assert(
      slowBot?.name === "潮汐助手" && !slowBot.system,
      "The slow-brain Agent did not create an ordinary bot",
    );
    const slowProof = yield* toolProof(slowTask.id);
    console.log(JSON.stringify({ stage: "slow-created", taskId: slowTask.id }));
    const slowReceipt = yield* waitMessage((m) =>
      m.taskId === slowTask.id && m.botCreation?.botId === slowBot!.id && m.botCreation.status === "available",
    );
    const undoCreation = api.request(`/v1/messages/${encodeURIComponent(slowReceipt.id)}/undo-bot-creation`, MessageResponse, "POST");
    const undone = (yield* undoCreation).message;
    const repeated = (yield* undoCreation).message;
    yield* assert(undone.id === slowReceipt.id && undone.botCreation?.status === "undone" &&
      repeated.id === undone.id && repeated.botCreation?.status === "undone" && !(yield* bots).bots.some((b) => b.id === slowBot!.id),
      "Undo did not remove just the unused bot and preserve its original receipt");

    // Use an independent request for correction, so rerouting never replays a creation request.
    yield* send("catalog-work", "请星表助手为一项新的独立任务列出猎户座的两颗亮星。");
    const original = yield* waitMessage(
      (m) => m.kind === "ack" && m.dispatch?.botId === created!.id,
    );
    const originalTask = `task:${original.decisionLogId}`;
    yield* waitMessage((m) => m.kind === "reply" && m.taskId === originalTask);
    const usedReceipt = yield* waitMessage((m) =>
      m.taskId === firstTask && m.botCreation?.botId === created!.id && m.botCreation.status === "used",
    );
    yield* api.request("/v1/config", ConfigResponse, "PUT", {
      ...settings,
      classifier: { primary: { ...settings.classifier!.primary, backend: "offline-fixture" } },
    });
    yield* action({
      type: "quote-reply",
      quotedMessageId: firstReply.id,
      text: "继续刚才那条目录记录。",
    });
    const offline = yield* waitMessage(
      (m) => m.kind === "clarify-card" && m.card?.options.some((o) => o.id === firstTask) === true,
    );
    yield* assert(
      !offline.card!.options.some((o) => o.id === originalTask),
      "Offline quoted continuation offered the newer task",
    );
    yield* api.request("/v1/config", ConfigResponse, "PUT", settings);

    yield* action({
      type: "correct-dispatch",
      decisionLogId: original.decisionLogId,
      change: { kind: "reroute", botId: manual.id },
    });
    const changed = yield* waitMessage(
      (m) => m.decisionLogId === original.decisionLogId && m.dispatch?.status === "reroute",
    );
    const correctedLog = (yield* api.logs).find((log) => log.id === changed.decisionLogId)!;
    const follow = yield* waitMessage(
      (m) => m.kind === "ack" && m.decisionLogId === correctedLog.correction?.decisionLogId,
    );
    yield* action({
      type: "correct-dispatch",
      decisionLogId: follow.decisionLogId,
      change: { kind: "undo" },
    });
    yield* waitMessage(
      (m) => m.decisionLogId === follow.decisionLogId && m.dispatch?.status === "undo",
    );
    const tasks = yield* api.tasks;
    yield* assert(
      tasks.some((t) => t.id === `task:${follow.decisionLogId}` && t.status === "cancelled") &&
        tasks.some((t) => t.id === originalTask && t.status === "idle"),
      "Reroute and undo did not preserve the original",
    );
    const cancelText = "请取消这个任务。";
    yield* action({ type: "quote-reply", quotedMessageId: firstReply.id, text: cancelText });
    yield* api.wait(
      api.tasks,
      (rows) => rows.some((t) => t.id === firstTask && t.status === "cancelled"),
      "60 seconds",
    );
    const decisions = (yield* api.logs).filter((log) => log.tree === "inbound");
    const naturalCancel = decisions.find(
      (log) =>
        log.output &&
        "op" in log.output &&
        log.output.op === "control" &&
        log.output.taskId === firstTask &&
        log.output.action === "cancel",
    );
    yield* assert(
      naturalCancel?.classifierCalls.length,
      "A classified natural-language cancellation is missing",
    );
    return {
      at: new Date().toISOString(),
      cliVersion,
      model: manual.modelSelection.model,
      workerProof,
      slowProof,
      creationReceipts: { undone, repeatedStatus: repeated.botCreation!.status, used: usedReceipt },
      routeTest: routed,
      dispatchAcknowledgementMs: dispatched.at - initial.message.at,
      offlineOptionIds: offline.card!.options.map((o) => o.id),
      originalDecision: original.decisionLogId,
      rerouteDecision: follow.decisionLogId,
      naturalCancelDecision: naturalCancel!.id,
      decisionLogs: decisions,
    };
  }),
);
const result = await Effect.runPromise(run.pipe(Effect.timeout("15 minutes")));
const output = process.env.AUT_E2E_RESULT ?? join(directory, "bot-dispatch.json");
await Effect.runPromise(writeEvidence(output, result));
console.log(JSON.stringify({ stage: "complete", output }));
