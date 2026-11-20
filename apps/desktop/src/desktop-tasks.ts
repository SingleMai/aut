import { Task } from "@aut/protocol";
import { Effect, Schema } from "effect";
import { desktopApi, UiError } from "./api.js";
import { t } from "./i18n.js";
import { sessionIdentity } from "./task-session-state.js";

const sameTask = Schema.equivalence(Task);
export function createDesktopTasks(
  cached: () => readonly Task[],
  replace: (tasks: readonly Task[]) => void,
  lock: Effect.Semaphore,
) {
  let selectedTaskId: string | undefined;
  const taskById = (id: string) => cached().find((task) => task.id === id);
  const rememberTask = (task: Task) => {
    const tasks = cached();
    const index = tasks.findIndex((entry) => entry.id === task.id);
    replace(index < 0 ? [...tasks, task] : tasks.with(index, task));
  };

  const readList = Effect.gen(function* () {
    const { tasks } = yield* desktopApi.listTasks();
    const id = selectedTaskId;
    const detail =
      id && !tasks.some((task) => task.id === id)
        ? yield* Effect.either(desktopApi.getTask(id))
        : undefined;
    return { tasks, id, detail };
  });

  // Resolve the extra row when publishing: the user can switch tasks while another resource loads.
  const withSelection = (
    page: Effect.Effect.Success<typeof readList>,
  ): { tasks: readonly Task[]; error?: UiError } => {
    const { tasks } = page;
    if (!selectedTaskId || tasks.some((task) => task.id === selectedTaskId)) return { tasks };
    const detail = page.id === selectedTaskId ? page.detail : undefined;
    const selected = detail?._tag === "Right" ? detail.right.task : taskById(selectedTaskId);
    return {
      tasks: selected ? [selected, ...tasks] : tasks,
      ...(detail?._tag === "Left" && { error: detail.left }),
    };
  };
  const selectTask = (id: string) =>
    Effect.suspend(() => {
      selectedTaskId = id;
      if (taskById(id)) return Effect.void;
      return lock.withPermits(1)(
        Effect.gen(function* () {
          if (selectedTaskId !== id || taskById(id)) return;
          const detail = yield* Effect.either(desktopApi.getTask(id));
          if (selectedTaskId !== id) return;
          if (detail._tag === "Left") return yield* Effect.fail(detail.left);
          rememberTask(detail.right.task);
        }),
      );
    });
  const readSession = (id: string, identity: string, before?: string) =>
    Effect.gen(function* () {
      const requested = taskById(id);
      if (!requested || sessionIdentity(requested) !== identity) return;
      const page = yield* desktopApi.getTaskSession(id, before);
      if (page.task.id !== id)
        return yield* Effect.fail(new UiError({ message: t.sessionTaskMismatch }));
      return yield* lock.withPermits(1)(
        Effect.sync(() => {
          const current = taskById(id);
          if (!current || sessionIdentity(current) !== identity) return;
          // A task list can complete during a native history read. Keep its newer metadata.
          const fresh =
            page.task.updatedAt > current.updatedAt ||
            (page.task.updatedAt === current.updatedAt && sameTask(current, requested));
          if (fresh && !sameTask(page.task, current)) rememberTask(page.task);
          if (sessionIdentity(page.task) === identity) return page;
        }),
      );
    });
  return { readList, withSelection, selectTask, readSession };
}
