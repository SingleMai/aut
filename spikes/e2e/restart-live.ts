// Opt-in native restart probe. Only the synthetic worker's current turn is interrupted.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Effect } from "effect";
import {
  AcceptedResponse,
  BotResponse,
  MessageResponse,
  TaskSessionResponse,
} from "../../packages/protocol/dist/index.js";
import { assert, configure, fixtureDirectory, withDaemon, writeEvidence } from "./support.ts";
const directory = fixtureDirectory();
const cliVersion = execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required");
console.log(JSON.stringify({ stage: "starting", directory }));
const result = await Effect.runPromise(
  withDaemon(directory, (api) =>
    Effect.gen(function* () {
      const bot = yield* configure(api, directory);
      yield* api.request(`/v1/bots/${bot.id}`, BotResponse, "PUT", {
        ...bot,
        soul: `${bot.soul} Initial echo: reply 已就绪. When the active user instruction is START_WAIT, emit commentary containing WAITING_MARKER, then run sleep 60 and finish. If the current turn is replaced by a new instruction, follow only that new instruction and never repeat the wait.`,
      });
      yield* api.request("/v1/messages", MessageResponse, "POST", {
        id: "first-echo",
        text: "请回声助手新建一项回声测试，简短回复已就绪。",
      });
      const message = (yield* api.wait(api.messages, (rows) =>
        rows.some((row) => row.kind === "reply"),
      )).find((row) => row.kind === "reply")!;
      const taskId = message.taskId!;
      const session = api.request(
        `/v1/tasks/${encodeURIComponent(taskId)}/session`,
        TaskSessionResponse,
      );
      const before = yield* session;
      const quote = (text: string) =>
        api.request("/v1/actions", AcceptedResponse, "POST", {
          type: "quote-reply",
          quotedMessageId: message.id,
          text,
        });
      yield* quote("继续这项回声测试，执行等待步骤 START_WAIT。");
      yield* api.wait(
        api.events,
        (rows) =>
          rows
            .map(({ event: e }) =>
              e.source === "session" && e.taskId === taskId && e.event.kind === "message.delta"
                ? e.event.text
                : "",
            )
            .join("")
            .includes("WAITING_MARKER"),
        "90 seconds",
      );
      yield* assert(
        (yield* api.tasks).find((t) => t.id === taskId)?.status === "running",
        "The worker already finished",
      );
      console.log(JSON.stringify({ stage: "waiting-in-native-turn" }));
      const runningAt = Date.now();
      yield* quote("请把这一轮从头重做：中断当前的等待，重新开始一轮，回复「重启完成」。");
      const response = (yield* api.wait(
        api.messages,
        (rows) =>
          rows.some((row) =>
            row.card?.options.some(
              (o) => o.op?.op === "send" && o.op.taskId === taskId && o.op.delivery === "restart",
            ),
          ) || rows.some((row) => row.kind === "ack" && row.at > runningAt),
        "45 seconds",
      )).find((row) =>
        row.card?.options.some(
          (o) => o.op?.op === "send" && o.op.taskId === taskId && o.op.delivery === "restart",
        ),
      );
      if (response?.card) {
        const restartOption = response.card.options.find(
          (o) => o.op?.op === "send" && o.op.taskId === taskId && o.op.delivery === "restart",
        )!;
        yield* api.request("/v1/actions", AcceptedResponse, "POST", {
          type: "card-choice",
          cardId: response.card.id,
          optionId: restartOption.id,
        });
      }
      const decisions = yield* api.wait(
        api.logs,
        (logs) =>
          logs.some(
            (log) =>
              log.output &&
              "op" in log.output &&
              log.output.op === "send" &&
              log.output.delivery === "restart" &&
              log.output.taskId === taskId,
          ),
        "45 seconds",
      );
      const op = decisions.find(
        (log) =>
          log.output &&
          "op" in log.output &&
          log.output.op === "send" &&
          log.output.delivery === "restart",
      )!;
      const completed = yield* api.wait(
        api.messages,
        (rows) =>
          rows.some(
            (row) => row.taskId === taskId && row.kind === "reply" && row.text.includes("重启完成"),
          ),
        "180 seconds",
      );
      const reply = completed.find(
        (row) => row.taskId === taskId && row.kind === "reply" && row.text.includes("重启完成"),
      )!;
      yield* api.wait(api.tasks, (rows) =>
        rows.some((t) => t.id === taskId && t.status === "idle"),
      );
      const after = yield* session;
      const added = after.history.turns.filter(
        (turn) => !before.history.turns.some((t) => turn.id === t.id),
      );
      const logs = (yield* api.logs).filter((log) => log.tree === "inbound");
      yield* assert(
        added.length === 2 &&
          added.some((t) => t.status === "interrupted") &&
          added.some((t) => t.status === "completed") &&
          JSON.stringify(before.task.session.cursor) ===
            JSON.stringify(after.task.session.cursor) &&
          after.task.queue.length === 0 &&
          !logs.find((l) => l.id === op.id)?.execution.degraded?.length,
        "Restart must interrupt one turn, finish another and preserve the native session",
      );
      return {
        at: new Date().toISOString(),
        cliVersion,
        model: bot.modelSelection.model,
        decisionId: op.id,
        confirmedByCard: Boolean(response),
        turns: added.map(({ id, status }) => ({ id, status })),
        sameSession: true,
        reply: reply.text,
        decisionLogs: logs,
      };
    }),
  ).pipe(Effect.timeout("6 minutes")),
);
const path = process.env.AUT_E2E_RESULT ?? join(directory, "restart.json");
await Effect.runPromise(writeEvidence(path, result));
console.log(JSON.stringify({ stage: "complete", path }));
