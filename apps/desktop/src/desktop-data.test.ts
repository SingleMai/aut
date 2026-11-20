import {
  BotId,
  type MainThreadMessage,
  MessageId,
  type Task,
  TaskId,
  type TaskSessionResponse,
} from "@aut/protocol";
import { Deferred, Effect, Fiber } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { desktopApi, messagePageSize, UiError } from "./api.js";
import { createDesktopData } from "./desktop-data.js";
import { sessionIdentity } from "./task-session-state.js";

const message = (n: number): MainThreadMessage => ({
  id: MessageId.make(`m${n}`),
  at: n,
  text: `message ${n}`,
  author: "user",
  kind: "text",
});
afterEach(() => vi.restoreAllMocks());

const source: Task = {
  id: TaskId.make("source"),
  botId: BotId.make("worker"),
  title: "Source",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1,
  session: { instanceId: "local" },
  pendingRequestIds: [],
  queue: [],
  origin: { kind: "user" },
};

it("publishes available chat data when a separate configuration read fails", async () => {
  const messages = [message(1)];
  vi.spyOn(desktopApi, "listMessages").mockReturnValue(Effect.succeed({ messages }));
  vi.spyOn(desktopApi, "getConfig").mockReturnValue(
    Effect.fail(new UiError({ message: "Invalid config" })),
  );
  const data = createDesktopData();
  const error = await Effect.runPromise(Effect.flip(data.refresh(["messages", "config"])));
  expect(error.message).toBe("Invalid config");
  expect(data.snapshot().messages).toEqual(messages);
  expect(data.snapshot().config).toBeUndefined();
});

it("distinguishes an unreadable first conversation from an empty one and retains loaded history", async () => {
  const failure = Effect.fail(new UiError({ message: "Offline" }));
  const list = vi.spyOn(desktopApi, "listMessages").mockReturnValue(failure);
  const data = createDesktopData();
  const read = () => Effect.runPromise(Effect.either(data.refresh(["messages"])));
  expect(data.snapshot().messageStatus).toBe("loading");
  await read();
  expect(data.snapshot().messageStatus).toBe("unavailable");
  list.mockReturnValueOnce(Effect.succeed({ messages: [] }));
  await read();
  expect(data.snapshot().messageStatus).toBe("ready");
  list.mockReturnValueOnce(Effect.succeed({ messages: [message(1)] }));
  await read();
  await read();
  expect(data.snapshot()).toMatchObject({ messageStatus: "ready", messages: [message(1)] });
});

it.each(["undone", "used"] as const)(
  "refreshes the receipt and bot list after a %s undo result",
  async (status) => {
    const receipt: MainThreadMessage = {
      ...message(1),
      author: "chief",
      kind: "notice",
      botCreation: { botId: source.botId, status },
    };
    const conflict = new UiError({ message: "Bot already has a task" });
    const undo = vi
      .spyOn(desktopApi, "undoBotCreation")
      .mockReturnValue(
        status === "undone" ? Effect.succeed({ message: receipt }) : Effect.fail(conflict),
      );
    vi.spyOn(desktopApi, "listMessages").mockReturnValue(Effect.succeed({ messages: [receipt] }));
    const bots = vi.spyOn(desktopApi, "listBots").mockReturnValue(Effect.succeed({ bots: [] }));
    const data = createDesktopData();
    const result = data.undoBotCreation(receipt.id);
    if (status === "undone") expect(await Effect.runPromise(result)).toEqual({ message: receipt });
    else expect(await Effect.runPromise(Effect.flip(result))).toBe(conflict);
    expect(undo).toHaveBeenCalledWith(receipt.id);
    expect(data.snapshot().messages).toEqual([receipt]);
    expect(bots).toHaveBeenCalledOnce();
  },
);

it("preserves the undo error if refreshing also fails and reports a refresh error after success", async () => {
  const receipt = message(1);
  const conflict = new UiError({ message: "Bot was changed" });
  const offline = new UiError({ message: "Refresh failed" });
  vi.spyOn(desktopApi, "undoBotCreation")
    .mockReturnValueOnce(Effect.fail(conflict))
    .mockReturnValueOnce(Effect.succeed({ message: receipt }));
  vi.spyOn(desktopApi, "listMessages").mockReturnValue(Effect.fail(offline));
  vi.spyOn(desktopApi, "listBots").mockReturnValue(Effect.succeed({ bots: [] }));
  const data = createDesktopData();
  for (const expected of [conflict, offline]) {
    expect(await Effect.runPromise(Effect.flip(data.undoBotCreation(receipt.id)))).toBe(expected);
  }
});

it("performs one follow-up read for a burst and reports errors only to callers of that resource", async () => {
  const first = Effect.runSync(Deferred.make<{ messages: readonly MainThreadMessage[] }>());
  const entered = Effect.runSync(Deferred.make<void>());
  const messages = vi
    .spyOn(desktopApi, "listMessages")
    .mockReturnValueOnce(
      Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Deferred.await(first))),
    )
    .mockReturnValue(Effect.succeed({ messages: [message(2)] }));
  const config = vi
    .spyOn(desktopApi, "getConfig")
    .mockReturnValue(Effect.fail(new UiError({ message: "config offline" })));
  const data = createDesktopData();
  const initial = Effect.runFork(data.refresh(["messages"]));
  await Effect.runPromise(Deferred.await(entered));
  const waiting = Array.from({ length: 12 }, () => Effect.runFork(data.refresh(["messages"])));
  const failed = Effect.runFork(Effect.flip(data.refresh(["config"])));
  await Effect.runPromise(Deferred.succeed(first, { messages: [message(1)] }));
  await Effect.runPromise(Effect.forEach([initial, ...waiting], Fiber.join));
  expect((await Effect.runPromise(Fiber.join(failed))).message).toBe("config offline");
  expect(messages).toHaveBeenCalledTimes(2);
  expect(config).toHaveBeenCalledTimes(1);
  expect(data.snapshot().messages).toEqual([message(2)]);
});

it("keeps an opened source outside the list window, including during a failed detail read", async () => {
  const data = createDesktopData();
  const listed = { ...source, id: TaskId.make("listed") };
  const get = vi.spyOn(desktopApi, "getTask").mockReturnValue(Effect.succeed({ task: source }));
  const list = vi
    .spyOn(desktopApi, "listTasks")
    .mockReturnValue(Effect.succeed({ tasks: [listed] }));
  await Effect.runPromise(data.selectTask(source.id));
  await Effect.runPromise(data.refresh(["tasks"]));
  expect(data.snapshot().tasks).toEqual([source, listed]);
  list.mockReturnValue(Effect.succeed({ tasks: [{ ...listed, title: "Updated" }] }));
  get.mockReturnValue(Effect.fail(new UiError({ message: "Temporarily offline" })));
  await Effect.runPromise(Effect.flip(data.refresh(["tasks"])));
  expect(data.snapshot().tasks.map((t) => t.title)).toEqual(["Source", "Updated"]);
  await Effect.runPromise(data.selectTask(listed.id));
  await Effect.runPromise(data.refresh(["tasks"]));
  expect(data.snapshot().tasks.map((t) => t.id)).toEqual([listed.id]);
  expect(get).toHaveBeenCalledTimes(3);
});

it("allows a caller to leave a shared refresh while other callers still receive its result", async () => {
  const entered = Effect.runSync(Deferred.make<void>());
  const release = Effect.runSync(Deferred.make<{ messages: readonly MainThreadMessage[] }>());
  const list = vi
    .spyOn(desktopApi, "listMessages")
    .mockReturnValue(
      Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Deferred.await(release))),
    );
  const data = createDesktopData();
  const owner = Effect.runFork(data.refresh(["messages"]));
  const follower = Effect.runFork(data.refresh(["messages"]));
  await Effect.runPromise(Deferred.await(entered));
  await Effect.runPromise(Fiber.interrupt(owner));
  await Effect.runPromise(Deferred.succeed(release, { messages: [message(1)] }));
  await Effect.runPromise(Fiber.join(follower));
  expect(data.snapshot().messages).toEqual([message(1)]);
  expect(list).toHaveBeenCalledOnce();
});

it("ignores a failed supplemental read if the user has already opened a listed task", async () => {
  const entered = Effect.runSync(Deferred.make<void>());
  const detail = Effect.runSync(Deferred.make<{ task: Task }, UiError>());
  const listed = { ...source, id: TaskId.make("current") };
  vi.spyOn(desktopApi, "listTasks").mockReturnValue(Effect.succeed({ tasks: [listed] }));
  vi.spyOn(desktopApi, "getTask")
    .mockReturnValueOnce(Effect.succeed({ task: source }))
    .mockReturnValue(
      Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Deferred.await(detail))),
    );
  const data = createDesktopData();
  await Effect.runPromise(data.refresh(["tasks"]));
  await Effect.runPromise(data.selectTask(source.id));
  const refresh = Effect.runFork(data.refresh(["tasks"]));
  await Effect.runPromise(Deferred.await(entered));
  await Effect.runPromise(data.selectTask(listed.id));
  await Effect.runPromise(Deferred.fail(detail, new UiError({ message: "Superseded request" })));
  await Effect.runPromise(Fiber.join(refresh));
  expect(data.snapshot().tasks).toEqual([listed]);
});

it("discards an outstanding history response after the daemon replaces the native session", async () => {
  const data = createDesktopData();
  const list = vi
    .spyOn(desktopApi, "listTasks")
    .mockReturnValue(Effect.succeed({ tasks: [source] }));
  await Effect.runPromise(data.refresh(["tasks"]));
  const pending = Effect.runSync(Deferred.make<TaskSessionResponse>());
  const entered = Effect.runSync(Deferred.make<void>());
  vi.spyOn(desktopApi, "getTaskSession").mockReturnValue(
    Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Deferred.await(pending))),
  );
  const old = Effect.runFork(data.readSession(source.id, sessionIdentity(source)));
  await Effect.runPromise(Deferred.await(entered));
  const replacement = { ...source, updatedAt: 5, session: { instanceId: "replacement" } };
  list.mockReturnValue(Effect.succeed({ tasks: [replacement] }));
  await Effect.runPromise(data.refresh(["tasks"]));
  await Effect.runPromise(
    Deferred.succeed(pending, {
      task: source,
      history: { turns: [] },
      availability: "available",
      hasEarlier: false,
    }),
  );
  expect(await Effect.runPromise(Fiber.join(old))).toBeUndefined();
  expect(data.snapshot().tasks).toEqual([replacement]);
});

it("keeps the loaded boundary across a multi-page burst and prepends older rows only on demand", async () => {
  const history = Array.from({ length: 70 }, (_, i) => message(i + 1));
  vi.spyOn(desktopApi, "listMessages").mockImplementation((before) => {
    const end =
      before === undefined ? history.length : history.findIndex((value) => value.id === before);
    return Effect.succeed({ messages: history.slice(Math.max(0, end - messagePageSize), end) });
  });
  const data = createDesktopData();
  await Effect.runPromise(data.refresh(["messages"]));
  expect(data.snapshot().messages[0]?.id).toBe("m21");
  history.push(...Array.from({ length: 63 }, (_, i) => message(71 + i)));
  await Effect.runPromise(data.refresh(["messages"]));
  expect(data.snapshot().messages).toEqual(history.slice(20));
  expect(data.snapshot().hasOlder).toBe(true);
  await Effect.runPromise(data.loadOlder);
  expect(data.snapshot().messages).toEqual(history);
  expect(data.snapshot().hasOlder).toBe(false);
});
