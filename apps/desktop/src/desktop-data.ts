import type {
  AutConfig,
  BotConfig,
  DaemonResource,
  MainThreadMessage,
  MessageId,
  Task,
  Trigger,
} from "@aut/protocol";
import { Effect, Either, Fiber } from "effect";
import { desktopApi, messagePageSize, type UiError } from "./api.js";
import { createDesktopTasks } from "./desktop-tasks.js";

interface Snapshot {
  readonly messages: readonly MainThreadMessage[];
  readonly messageStatus: "loading" | "ready" | "unavailable";
  readonly hasOlder: boolean;
  readonly tasks: readonly Task[];
  readonly bots: readonly BotConfig[];
  readonly triggers: readonly Trigger[];
  readonly config?: AutConfig;
  readonly requestRevision: number;
  readonly taskRevision: number;
}

const resources: readonly DaemonResource[] = ["messages", "tasks", "requests", "bots", "config"];
export function createDesktopData() {
  let state: Snapshot = {
    messages: [],
    messageStatus: "loading",
    hasOlder: false,
    tasks: [],
    bots: [],
    triggers: [],
    requestRevision: 0,
    taskRevision: 0,
  };
  const listeners = new Set<() => void>();
  const lock = Effect.runSync(Effect.makeSemaphore(1));
  const publish = (patch: Partial<Snapshot>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const readMessages = Effect.gen(function* () {
    const oldest = state.messages[0]?.id;
    let page = (yield* desktopApi.listMessages()).messages;
    const pages = [page];
    while (oldest && page.length === messagePageSize && !page.some((m) => m.id === oldest)) {
      page = (yield* desktopApi.listMessages(page[0]?.id)).messages;
      pages.push(page);
    }
    const gathered = pages.reverse().flat();
    const start = gathered.findIndex((m) => m.id === oldest);
    return {
      messages: gathered.slice(Math.max(0, start)),
      messageStatus: "ready" as const,
      hasOlder: start >= 0 ? state.hasOlder : page.length === messagePageSize,
    };
  });
  const loadOlder = lock.withPermits(1)(
    Effect.gen(function* () {
      const before = state.messages[0]?.id;
      if (!before || !state.hasOlder) return;
      const { messages } = yield* desktopApi.listMessages(before);
      const loaded = new Set(state.messages.map((m) => m.id));
      publish({
        messages: [...messages.filter((m) => !loaded.has(m.id)), ...state.messages],
        hasOlder: messages.length === messagePageSize,
      });
    }),
  );
  const taskData = createDesktopTasks(
    () => state.tasks,
    (tasks) => publish({ tasks }),
    lock,
  );
  const readBatch = (changed: ReadonlySet<DaemonResource>) =>
    Effect.gen(function* () {
      const results = yield* Effect.all(
        {
          messages: changed.has("messages") ? readMessages : Effect.succeed(undefined),
          tasks: changed.has("tasks") ? taskData.readList : Effect.succeed(undefined),
          bots: changed.has("bots") ? desktopApi.listBots() : Effect.succeed(undefined),
          config: changed.has("config") ? desktopApi.getConfig() : Effect.succeed(undefined),
          triggers: changed.has("triggers") ? desktopApi.listTriggers() : Effect.succeed(undefined),
        },
        { concurrency: "unbounded", mode: "either" },
      );
      const errors = new Map<DaemonResource, UiError>();
      for (const key of ["messages", "tasks", "bots", "config", "triggers"] as const) {
        const result = results[key];
        if (result._tag === "Left") errors.set(key, result.left);
      }
      const page = Either.getOrUndefined(results.tasks);
      const list = page && taskData.withSelection(page);
      if (list?.error) errors.set("tasks", list.error);
      const bots = Either.getOrUndefined(results.bots);
      const config = Either.getOrUndefined(results.config);
      const triggers = Either.getOrUndefined(results.triggers);
      publish({
        ...(errors.has("messages") && !state.messages.length && { messageStatus: "unavailable" }),
        ...Either.getOrUndefined(results.messages),
        ...(list && { tasks: list.tasks }),
        ...(bots && { bots: bots.bots }),
        ...(config && { config }),
        ...(triggers && { triggers: triggers.triggers }),
        requestRevision: state.requestRevision + Number(changed.has("requests")),
        taskRevision: state.taskRevision + Number(changed.has("requests") || changed.has("tasks")),
      });
      return errors;
    });

  let queued: { resources: Set<DaemonResource>; read: ReturnType<typeof readBatch> } | undefined;
  const refresh = (changed = resources) =>
    Effect.suspend(() => {
      if (!queued) {
        const resources = new Set<DaemonResource>();
        const read = lock.withPermits(1)(
          Effect.suspend(() => {
            queued = undefined;
            return readBatch(resources);
          }),
        );
        // All callers share the next read. Once it starts, later invalidations need a fresh batch.
        // A cancelled waiter must not interrupt the snapshot that other callers are awaiting.
        const start = Effect.runSync(Effect.cached(Effect.forkDaemon(read)));
        queued = { resources, read: start.pipe(Effect.flatMap(Fiber.join)) };
      }
      for (const key of changed) queued.resources.add(key);
      return queued.read.pipe(
        Effect.flatMap((errors) => {
          for (const key of changed) {
            const error = errors.get(key);
            if (error) return Effect.fail(error);
          }
          return Effect.void;
        }),
      );
    });

  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadOlder,
    refresh,
    selectTask: taskData.selectTask,
    readSession: taskData.readSession,
    undoBotCreation: (messageId: MessageId) => {
      const refreshReceipt = refresh(["messages", "bots"]);
      return desktopApi.undoBotCreation(messageId).pipe(
        Effect.tapBoth({
          onSuccess: () => refreshReceipt,
          onFailure: () => Effect.ignore(refreshReceipt),
        }),
      );
    },
    saveConfig: (config: AutConfig) =>
      lock.withPermits(1)(
        desktopApi
          .saveConfig(config)
          .pipe(Effect.tap((value) => Effect.sync(() => publish({ config: value })))),
      ),
    createTrigger: (input: Parameters<typeof desktopApi.createTrigger>[0]) =>
      lock.withPermits(1)(
        desktopApi
          .createTrigger(input)
          .pipe(
            Effect.tap((value) =>
              Effect.sync(() => publish({ triggers: [value.trigger, ...state.triggers] })),
            ),
          ),
      ),
    updateTrigger: (id: string, input: Parameters<typeof desktopApi.updateTrigger>[1]) =>
      lock.withPermits(1)(
        desktopApi.updateTrigger(id, input).pipe(
          Effect.tap((value) =>
            Effect.sync(() =>
              publish({
                triggers: [value.trigger, ...state.triggers.filter((trigger) => trigger.id !== id)],
              }),
            ),
          ),
        ),
      ),
    toggleTrigger: (id: string, enabled: boolean) =>
      lock.withPermits(1)(
        (enabled ? desktopApi.resumeTrigger(id) : desktopApi.pauseTrigger(id)).pipe(
          Effect.tap((value) =>
            Effect.sync(() =>
              publish({
                triggers: state.triggers.map((trigger) =>
                  trigger.id === id ? value.trigger : trigger,
                ),
              }),
            ),
          ),
        ),
      ),
    listTriggerRuns: (id: string) =>
      desktopApi.listTriggerRuns(id).pipe(Effect.map((value) => value.runs)),
  };
}
export type DesktopData = ReturnType<typeof createDesktopData>;
