// Real concurrent tasks, ambiguous references and drain-time grouping.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import {
  AcceptedResponse,
  BotResponse,
  MessageResponse,
  RequestResponse,
  TaskSessionResponse,
  type MainThreadMessage,
} from "../../packages/protocol/dist/index.js";
import { assert, configure, fixtureDirectory, withDaemon, writeEvidence } from "./support.ts";
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
const directory = fixtureDirectory();
const cliVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
console.log(JSON.stringify({ stage: "starting", directory, cliVersion }));
const result = await Effect.runPromise(
  withDaemon(directory, (api) =>
    Effect.gen(function* () {
      const bot = yield* configure(api, directory);
      yield* api.request(`/v1/bots/${bot.id}`, BotResponse, "PUT", {
        ...bot,
        name: "色卡助手",
        description: "处理色卡校对、色卡分区和颜色回声验证。",
        soul: `This is a synthetic acceptance fixture. For the initial request for a regional color card, use request_user_input to ask exactly one question with id fixture_tone, header Tone, text Which fixture tone?, options Warm and Cool. After an explicit answer reply briefly with that tone. For queued follow-up instructions echo every provided marker in original order. Never ask other questions.`,
      });
      const send = (id: string, text: string) =>
        api.request("/v1/messages", MessageResponse, "POST", { id, text });
      const action = (body: unknown) => api.request("/v1/actions", AcceptedResponse, "POST", body);
      const waitMsg = (matches: (row: MainThreadMessage) => boolean) =>
        api
          .wait(api.messages, (rows) => rows.some(matches), "150 seconds")
          .pipe(Effect.map((rows) => rows.find(matches)!));
      const byEvent = (eventRef: string) =>
        api
          .wait(api.logs, (logs) =>
            logs.some((log) => log.input.eventRef === eventRef && log.execution.ok),
          )
          .pipe(Effect.map((rows) => rows.find((log) => log.input.eventRef === eventRef)!));
      const taskPhase = (id: string, status: string) =>
        api.wait(api.tasks, (rows) =>
          rows.some((task) => task.id === id && task.status === status),
        );
      const start = (id: string, area: string) =>
        Effect.gen(function* () {
          yield* send(id, `请色卡助手新建一项独立工作，校对${area}色卡。`);
          const log = yield* byEvent(`message:${id}`);
          yield* assert(
            log.output &&
              "op" in log.output &&
              log.output.op === "new" &&
              log.output.botId === bot.id,
            "Expected an independent color-card worker",
          );
          const taskId = `task:${log.id}`;
          const card = yield* waitMsg(
            (row) => row.taskId === taskId && row.kind === "question-card",
          );
          return { taskId, card };
        });
      const north = yield* start("north-card", "北区");
      const south = yield* start("south-card", "南区");
      const simultaneous = (yield* api.tasks)
        .filter((t) => t.status === "waiting_user")
        .map((t) => t.id);
      yield* assert(simultaneous.length === 2, "Both workers must be awaiting their own question");
      console.log(JSON.stringify({ stage: "two-native-workers" }));
      yield* send("ambiguous-card", "我想取消一个色卡任务，但还没指定是哪一个。");
      const ambiguous = yield* byEvent("message:ambiguous-card");
      const choices =
        ambiguous.output && "op" in ambiguous.output && ambiguous.output.op === "clarify"
          ? ambiguous.output.card.options
          : [];
      yield* assert(
        ambiguous.classifierCalls.some((call) => call.response) &&
          choices.some((o) => o.id === north.taskId) &&
          choices.some((o) => o.id === south.taskId),
        "An ambiguous live request did not offer both tasks",
      );
      yield* assert(
        (yield* api.tasks).every((task) => task.status === "waiting_user"),
        "The ambiguous reference changed a task",
      );
      yield* send("last-control", "取消刚才新建的那个任务。");
      const control = yield* byEvent("message:last-control");
      let confirmedByCard = false;
      if (control.output && "op" in control.output && control.output.op === "clarify") {
        const cancel = control.output.card.options.find(
          (o) => o.op?.op === "control" && o.op.taskId === south.taskId && o.op.action === "cancel",
        );
        yield* assert(cancel, "The live clarification did not offer the recent task");
        yield* action({
          type: "card-choice",
          cardId: control.output.card.id,
          optionId: cancel!.id,
        });
        confirmedByCard = true;
      }
      yield* taskPhase(south.taskId, "cancelled");
      yield* taskPhase(north.taskId, "waiting_user");
      console.log(JSON.stringify({ stage: "ambiguous-and-cancel", confirmedByCard }));
      const quote = (text: string) =>
        action({ type: "quote-reply", quotedMessageId: north.card.id, text });
      const markers = ["北区甲", "北区乙"];
      for (const marker of markers) yield* quote(`请在当前回合完成后追加一条记录：${marker}。`);
      yield* api.wait(
        api.tasks,
        (rows) => rows.find((task) => task.id === north.taskId)?.queue.length === 2,
      );
      const queueTask = (yield* api.tasks).find((task) => task.id === north.taskId)!;
      const queuedIds = queueTask.queue.flatMap((group) => group.messageIds);
      yield* assert(queuedIds.length === 2, "Expected two original queued message IDs");
      const card = north.card.card!;
      const req = yield* api.request(
        `/v1/requests/${encodeURIComponent(card.requestId!)}`,
        RequestResponse,
      );
      const [question] = req.request.questions;
      yield* assert(
        req.request.questions.length === 1 &&
          question?.id === "fixture_tone" &&
          question.text === "Which fixture tone?" &&
          JSON.stringify(question.options?.map((o) => o.label)) === '["Warm","Cool"]',
        "Unexpected native question; stopping before sending any answer",
      );
      yield* action({
        type: "question-answer",
        cardId: card.id,
        requestId: card.requestId,
        answer: {
          perQuestion: [{ questionId: question!.id, optionIds: [question!.options![0]!.id] }],
        },
      });
      const replies = yield* api.wait(
        api.messages,
        (rows) =>
          rows.filter((row) => row.taskId === north.taskId && row.kind === "reply").length >= 2,
        "180 seconds",
      );
      const last = replies
        .filter((row) => row.taskId === north.taskId && row.kind === "reply")
        .at(-1)!;
      const session = () =>
        api.request(`/v1/tasks/${encodeURIComponent(north.taskId)}/session`, TaskSessionResponse);
      const turns = (yield* session()).history.turns;
      const merged = turns.filter((turn) =>
        turn.items.some(
          (item) => item.kind === "user" && markers.every((marker) => item.text.includes(marker)),
        ),
      );
      yield* assert(
        turns.length === 2 &&
          merged.length === 1 &&
          last.text.indexOf(markers[0]) >= 0 &&
          last.text.indexOf(markers[1]) > last.text.indexOf(markers[0]),
        "The two queued messages did not drain in order in one native turn",
      );
      const logs = (yield* api.logs).filter((log) => log.tree === "inbound");
      return {
        at: new Date().toISOString(),
        cliVersion,
        model: bot.modelSelection.model,
        simultaneous,
        ambiguousDecision: ambiguous.id,
        cancelDecision: control.id,
        cancelConfirmedByCard: confirmedByCard,
        queuedMessageIds: queuedIds,
        mergedTurn: merged[0]!.id,
        mergedReport: last.text,
        decisionLogs: logs,
      };
    }),
  ).pipe(Effect.timeout("12 minutes")),
);
const path = process.env.AUT_E2E_RESULT ?? join(directory, "concurrent-delivery.json");
await Effect.runPromise(writeEvidence(path, result));
console.log(JSON.stringify({ stage: "complete", path }));
