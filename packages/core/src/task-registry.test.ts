import { RequestId, Task, type TaskStatus } from "@aut/protocol";
import { Effect, Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { resolveTaskTransition, type TaskTransition, transitionTask } from "./task-registry.js";

const requestId = RequestId.make("request-1");
const events: readonly TaskTransition[] = [
  { type: "turn.started" },
  { type: "request.opened", requestId },
  { type: "request.answered", requestId },
  { type: "turn.completed", ok: true },
  { type: "gate.done" },
  { type: "turn.failed" },
  { type: "daemon.restart" },
  { type: "cancel" },
  { type: "retry" },
  { type: "resume" },
  { type: "archive" },
  { type: "turn.completed", ok: false, stopReason: "interrupted", restart: true },
  { type: "turn.completed", ok: false, stopReason: "interrupted", restart: false },
];

// Expected cells transcribed from protocol.md, including both interruption outcomes.
const expected: Record<TaskStatus, readonly (TaskStatus | null)[]> = {
  created: [
    "running",
    null,
    null,
    null,
    null,
    "failed",
    "interrupted",
    "cancelled",
    null,
    null,
    null,
    null,
    null,
  ],
  running: [
    null,
    "waiting_user",
    null,
    "reporting",
    null,
    "failed",
    "interrupted",
    "cancelled",
    null,
    null,
    null,
    "idle",
    "interrupted",
  ],
  waiting_user: [
    null,
    "waiting_user",
    "running",
    "reporting",
    null,
    "failed",
    "interrupted",
    "cancelled",
    null,
    null,
    null,
    "idle",
    "interrupted",
  ],
  reporting: [
    null,
    null,
    null,
    null,
    "idle",
    null,
    "interrupted",
    "cancelled",
    null,
    null,
    null,
    null,
    null,
  ],
  idle: [
    "running",
    null,
    null,
    null,
    null,
    null,
    null,
    "cancelled",
    null,
    null,
    "archived",
    null,
    null,
  ],
  failed: [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "cancelled",
    "running",
    null,
    "archived",
    null,
    null,
  ],
  interrupted: [
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    "cancelled",
    null,
    "running",
    "archived",
    null,
    null,
  ],
  cancelled: [null, null, null, null, null, null, null, null, null, null, "archived", null, null],
  archived: [null, null, null, null, null, null, null, null, null, null, null, null, null],
};

const cells = Object.entries(expected).flatMap(([status, row]) =>
  events.map((event, index) => ({
    status: status as TaskStatus,
    event,
    target: row[index] ?? null,
    label: `${status}/${event.type}/${index}`,
  })),
);

export const taskFixture = (
  status: TaskStatus = "created",
  pendingRequestIds: readonly RequestId[] = [],
) =>
  Schema.decodeUnknownSync(Task)({
    id: "task-1",
    botId: "bot-1",
    title: "0",
    status,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    session: { instanceId: "local" },
    pendingRequestIds,
    queue: [],
    origin: { kind: "user" },
  });

describe("documented task state matrix", () => {
  it.each(cells)("$label", async ({ status, event, target }) => {
    const result = await Effect.runPromise(Effect.either(resolveTaskTransition(status, event, 0)));
    if (target === null) {
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) expect(result.left.code).toBe("InvalidTransition");
    } else expect(result).toEqual(Either.right(target));
  });

  it("keeps waiting until the last independently pending request is answered", async () => {
    const second = RequestId.make("request-2");
    const running = taskFixture("running");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const first = yield* transitionTask(running, { type: "request.opened", requestId }, 2);
        const both = yield* transitionTask(first, { type: "request.opened", requestId: second }, 3);
        const partial = yield* transitionTask(both, { type: "request.answered", requestId }, 4);
        const complete = yield* transitionTask(
          partial,
          { type: "request.answered", requestId: second },
          5,
        );
        return { partial, complete };
      }),
    );
    expect(result.partial.status).toBe("waiting_user");
    expect(result.partial.pendingRequestIds).toEqual([second]);
    expect(result.complete.status).toBe("running");
    expect(result.complete.pendingRequestIds).toEqual([]);
    expect(result.complete.lastActivityAt).toBe(5);
  });

  it("rejects duplicate question opening and answers for unknown requests", async () => {
    const task = taskFixture("waiting_user", [requestId]);
    for (const event of [
      { type: "request.opened", requestId },
      { type: "request.answered", requestId: RequestId.make("unknown") },
    ] as const) {
      const result = await Effect.runPromise(Effect.either(transitionTask(task, event, 2)));
      expect(Either.isLeft(result) && result.left.code).toBe("InvalidRequest");
    }
  });

  it.each([
    { type: "turn.completed", ok: true },
    { type: "turn.completed", ok: false, stopReason: "interrupted", restart: true },
    { type: "turn.completed", ok: false, stopReason: "interrupted", restart: false },
    { type: "turn.failed" },
    { type: "daemon.restart" },
    { type: "cancel" },
  ] satisfies TaskTransition[])(
    "clears pending requests on $type without inventing answers",
    async (event) => {
      const result = await Effect.runPromise(
        transitionTask(taskFixture("waiting_user", [requestId]), event, 2),
      );
      expect(result.pendingRequestIds).toEqual([]);
    },
  );

  it("rejects missing interruption intent and invalid pending counts", async () => {
    const invalid = { type: "turn.completed", ok: false, stopReason: "interrupted" };
    expect(Schema.is((await import("./task-registry.js")).TaskTransition)(invalid)).toBe(false);
    const result = await Effect.runPromise(
      Effect.either(
        resolveTaskTransition("waiting_user", { type: "request.answered", requestId }, -1),
      ),
    );
    expect(Either.isLeft(result) && result.left.code).toBe("Validation");
  });
});
