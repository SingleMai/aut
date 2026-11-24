import type { AdapterError } from "@aut/protocol";
import { Effect, Layer } from "effect";
import { DecisionLog } from "./decision-log.js";
import { DecisionTree } from "./decision-tree/engine.js";
import { TreeError } from "./decision-tree/errors.js";
import { replyGateV1 } from "./decision-tree/reply-gate.js";
import { CoreError } from "./errors.js";
import { runIsolatedTurn, temporarySessionInput } from "./isolated-turn.js";
import { MessageFiles } from "./message-files.js";
import { reportTextForTruncation } from "./report-sources.js";
import { SessionReplyGate, type SessionReplyInput } from "./session-manager/ports.js";
import { Store } from "./store.js";

export const reportState = (report: string, rewrites: number) => ({
  report,
  rewrites,
  characters: Array.from(report.trim()).length,
  words: report.trim() ? report.trim().split(/\s+/u).length : 0,
  hasHan: /\p{Script=Han}/u.test(report),
});
const detailHint = "详情见任务面板";
export const truncateReport = (report: string): string => {
  const characterLimit = replyGateV1.thresholds.characters ?? 200;
  const wordLimit = replyGateV1.thresholds.words ?? 120;
  const limited = reportTextForTruncation(report)
    .trim()
    .split(/\s+/u)
    .slice(0, wordLimit - 1)
    .join(" ");
  const prefix = Array.from(limited)
    .slice(0, characterLimit - Array.from(detailHint).length - 2)
    .join("")
    .trimEnd();
  return prefix ? `${prefix}…\n${detailHint}` : detailHint;
};
const rewriteError = (message: string) => new TreeError({ code: "Rewrite", message });
const adapterError = (error: AdapterError) =>
  rewriteError(`The isolated rewrite failed (${error.code}).`);

export interface ReplyGateOptions {
  readonly rewriteTimeoutMs?: number;
}

export const SessionReplyGateLive = (options: ReplyGateOptions = {}) =>
  Layer.effect(
    SessionReplyGate,
    Effect.gen(function* () {
      const tree = yield* DecisionTree;
      const logs = yield* DecisionLog;
      const store = yield* Store;
      const files = yield* MessageFiles;
      const timeoutMs = options.rewriteTimeoutMs ?? 120_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
        return yield* Effect.fail(
          new CoreError({
            code: "Configuration",
            message: "The rewrite timeout must be a positive safe integer",
          }),
        );

      const rewrite = (input: SessionReplyInput, instructions: string, attempt: number) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* (
              input.adapter.capabilities.fork
                ? input.session.fork()
                : input.adapter.startSession(
                    temporarySessionInput(input.sessionInput, instructions),
                  )
            ).pipe(Effect.mapError(adapterError));
            const completed = yield* runIsolatedTurn(store, {
              session: child,
              taskId: input.task.id,
              eventPrefix: `rewrite:${input.reportEventId}:${attempt}`,
              input: {
                text: `${instructions}\n\n<report>\n${input.report}\n</report>`,
                messageIds: [],
              },
            }).pipe(Effect.mapError((error) => rewriteError(error.message)));
            return completed.report;
          }).pipe(
            Effect.interruptible,
            Effect.timeoutFail({
              duration: timeoutMs,
              onTimeout: () => rewriteError("The isolated rewrite timed out."),
            }),
          ),
        );

      return {
        check: (input: SessionReplyInput) =>
          Effect.gen(function* () {
            let current = input.report.trim();
            const attachments = yield* files.captureReport(
              input.report,
              input.sessionInput.cwd,
              input.reportEventId,
            );
            let attempts = 0;
            const degraded: string[] = [];
            const decision = yield* tree
              .run(replyGateV1, {
                eventRef: `report:${input.reportEventId}`,
                state: reportState(current, attempts),
                rewrite: {
                  rewrite: ({ instructions, attempt }) =>
                    Effect.gen(function* () {
                      attempts = attempt;
                      current = (yield* rewrite(input, instructions, attempt)).trim();
                      return reportState(current, attempts);
                    }).pipe(
                      Effect.tapError((error) =>
                        Effect.sync(() => {
                          degraded.push(error.message);
                        }),
                      ),
                    ),
                },
              })
              .pipe(
                Effect.mapError((error) =>
                  error._tag === "CoreError"
                    ? error
                    : new CoreError({
                        code: "InvalidRequest",
                        message: "The reply gate could not complete",
                      }),
                ),
              );
            if (!("gate" in decision.output) || decision.output.gate === "rewrite")
              return yield* Effect.fail(
                new CoreError({
                  code: "InvalidRequest",
                  message: "The reply gate produced an invalid terminal result",
                }),
              );
            const delivered =
              decision.output.gate === "deliver" ? current : truncateReport(current);
            yield* logs.complete(decision.decisionLogId, {
              ok: true,
              ...(degraded.length ? { degraded } : {}),
            });
            return { delivered, rewrites: attempts, ...attachments };
          }),
      };
    }),
  );
