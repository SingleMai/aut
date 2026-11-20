import type { Task } from "@aut/protocol";
import { Effect, Fiber, Queue } from "effect";
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { DesktopData } from "./desktop-data.js";
import { applySessionRead } from "./task-session-state.js";
import { TaskSessionView } from "./task-session-view.js";

export function TaskHistory({
  task,
  identity,
  active,
  revision,
  data,
  onAnswer,
}: {
  task: Task;
  identity: string;
  active: boolean;
  revision: number;
  data: DesktopData;
  onAnswer: () => void;
}) {
  const [{ response, latestError, earlierError }, finishRead] = useReducer(applySessionRead, {});
  const [busy, setBusy] = useState(false);
  const request = useRef<(before: string | null) => void>(undefined);
  const id = task.id;
  useLayoutEffect(() => {
    if (!active) return;
    const queue = Effect.runSync(Queue.unbounded<string | null>());
    const waiting = new Set<string | null>();
    const enqueue = (before: string | null) => {
      if (waiting.has(before)) return;
      waiting.add(before);
      queue.unsafeOffer(before);
    };
    request.current = enqueue;
    const unsubscribe = window.aut.onNotice((notice) => {
      if (
        notice.type === "event" &&
        notice.event.source === "session" &&
        notice.event.taskId === id
      )
        enqueue(null);
    });
    const read = Effect.gen(function* () {
      const before = yield* Queue.take(queue);
      waiting.delete(before);
      setBusy(true);
      const result = yield* Effect.either(data.readSession(id, identity, before ?? undefined));
      finishRead({ before, result });
      setBusy(false);
    });
    const fiber = Effect.runFork(Effect.forever(read));
    return () => {
      unsubscribe();
      request.current = undefined;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [active, data, id, identity]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each revision invalidates the visible session, including after a reconnect.
  useEffect(() => {
    if (active) request.current?.(null);
  }, [active, revision]);

  const retryEarlier =
    !latestError && response?.availability === "available" ? earlierError : undefined;
  const load = (earlier = false) => {
    const before = earlier ? response?.nextBefore : (retryEarlier?.before ?? null);
    if (before !== undefined) request.current?.(before);
  };
  return (
    <TaskSessionView
      {...{ task, response, busy, load, onAnswer }}
      error={latestError ?? retryEarlier?.message ?? ""}
    />
  );
}
