import type { Task, TaskSessionResponse } from "@aut/protocol";
import type { Either } from "effect";
import type { UiError } from "./api.js";
import { t } from "./i18n.js";

export const sessionIdentity = (task: Task) =>
  JSON.stringify([task.id, task.session], (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, record[key]]),
    );
  });

// Latest snapshots replace overlapping turns; older pages cannot overwrite live updates.
export const mergeSessionPage = (
  previous: TaskSessionResponse | undefined,
  next: TaskSessionResponse,
  earlier: boolean,
): TaskSessionResponse => {
  if (!previous || sessionIdentity(previous.task) !== sessionIdentity(next.task)) return next;
  if (next.availability !== "available")
    return {
      ...next,
      history: previous.history,
      hasEarlier: previous.hasEarlier,
      ...(previous.nextBefore ? { nextBefore: previous.nextBefore } : {}),
    };
  if (earlier) {
    const current = new Set(previous.history.turns.map((turn) => turn.id));
    return {
      ...next,
      history: {
        turns: [
          ...next.history.turns.filter((turn) => !current.has(turn.id)),
          ...previous.history.turns,
        ],
      },
    };
  }
  if (!next.hasEarlier) return next;
  const incoming = new Set(next.history.turns.map((turn) => turn.id));
  // Only the prefix before the overlap predates the latest snapshot. A gap needs a fresh cursor.
  const overlap = previous.history.turns.findIndex((turn) => incoming.has(turn.id));
  if (overlap <= 0) return next;
  return {
    ...next,
    history: { turns: [...previous.history.turns.slice(0, overlap), ...next.history.turns] },
    hasEarlier: previous.hasEarlier,
    nextBefore: previous.nextBefore,
  };
};

interface SessionReadState {
  readonly response?: TaskSessionResponse;
  readonly latestError?: string;
  readonly earlierError?: { before: string; message: string };
}

export function applySessionRead(
  state: SessionReadState,
  {
    before,
    result,
  }: {
    before: string | null;
    result: Either.Either<TaskSessionResponse | undefined, UiError>;
  },
): SessionReadState {
  if (before !== null && state.response?.nextBefore !== before) return state;
  if (result._tag === "Left") {
    const message = result.left.message;
    return before === null
      ? { ...state, latestError: message }
      : { ...state, earlierError: { before, message } };
  }
  const page = result.right;
  if (!page) return state;
  if (before !== null && page.availability === "unavailable")
    return {
      ...state,
      earlierError: { before, message: page.message || t.earlierTurnsUnavailable },
    };

  const response = mergeSessionPage(state.response, page, before !== null);
  // A live refresh can update the latest turns while the same older page still needs a retry.
  if (before === null && state.earlierError && state.earlierError.before === response.nextBefore)
    return { response, earlierError: state.earlierError };
  if (before !== null && state.latestError) return { response, latestError: state.latestError };
  return { response };
}
