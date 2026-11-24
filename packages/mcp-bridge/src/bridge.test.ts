import { mkdtemp, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BotId,
  MessageId,
  type Task,
  TaskId,
  Timestamp,
  Trigger,
  TriggerId,
  TriggerRunId,
} from "@aut/protocol";
import { it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Deferred, Effect, Exit, Fiber, Layer, Redacted, Schema, Scope, TestClock } from "effect";
import { expect } from "vitest";
import { mcpServerConfig } from "./config.js";
import { BridgeBackend, BridgeError, type SessionIdentity } from "./interface.js";
import { makeMcpServer } from "./server.js";
import {
  BRIDGE_MAX_INPUT_BYTES,
  type BridgeCredentials,
  makeBridgeSocket,
  makeSocketBridgeClient,
} from "./socket.js";

const worker: SessionIdentity = {
  botId: BotId.make("worker"),
  taskId: TaskId.make("task"),
  role: "worker",
};
const slow: SessionIdentity = {
  botId: BotId.make("slow"),
  taskId: TaskId.make("slow-task"),
  role: "coordinator",
};
const task: Task = {
  id: worker.taskId,
  botId: worker.botId,
  title: "Fixture task",
  status: "running",
  createdAt: Timestamp.make(1),
  updatedAt: Timestamp.make(2),
  lastActivityAt: Timestamp.make(2),
  session: { instanceId: "fixture", cursor: { kind: "codex", data: { threadId: "native" } } },
  pendingRequestIds: [],
  queue: [],
  origin: { kind: "user" },
};
const fixtureTrigger: Trigger = {
  id: TriggerId.make("fixture-trigger"),
  name: "Fixture schedule",
  enabled: true,
  botId: worker.botId,
  prompt: "Run the fixture schedule",
  payload: {},
  schedule: { kind: "once", at: Timestamp.make(10) },
  overlap: "skip",
  createdAt: Timestamp.make(1),
  updatedAt: Timestamp.make(1),
};
const fixtureTriggerRun = {
  id: TriggerRunId.make("run:fixture-trigger:1"),
  triggerId: fixtureTrigger.id,
  occurrenceKey: "fixture-trigger:1",
  scheduledAt: Timestamp.make(10),
  status: "ran" as const,
  taskId: task.id,
};
const sdk = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => new BridgeError({ code: "Unavailable", message: "SDK test operation failed." }),
  });
const rawCall = (credentials: BridgeCredentials, body: string, path = "/tool") =>
  Effect.async<unknown, BridgeError>((resume) => {
    const request = httpRequest(
      {
        socketPath: credentials.socketPath,
        method: "POST",
        path,
        headers: { authorization: `Bearer ${Redacted.value(credentials.token)}` },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resume(
            Effect.try({
              try: () => JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
              catch: () =>
                new BridgeError({ code: "InvalidInput", message: "Invalid fixture reply." }),
            }),
          ),
        );
      },
    );
    request.once("error", () =>
      resume(
        Effect.fail(new BridgeError({ code: "Unavailable", message: "Fixture request failed." })),
      ),
    );
    request.end(body);
    return Effect.sync(() => request.destroy());
  });
const setup = Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    sdk(() => mkdtemp("/tmp/aut-mcp-")),
    (path) => sdk(() => rm(path, { recursive: true, force: true })).pipe(Effect.ignore),
  );
  let proposals = 0;
  let allowed = true;
  const reads: unknown[] = [];
  const layer = Layer.succeed(BridgeBackend, {
    mcpInfo: () => Effect.succeed({ servers: [], grants: [], bots: [] }),
    mcpServer: () => Effect.dieMessage("Unexpected MCP management call"),
    authorize: () =>
      allowed
        ? Effect.void
        : Effect.fail(
            new BridgeError({ code: "Forbidden", message: "The session is no longer active." }),
          ),
    readMainThread: (_identity, input) =>
      Effect.sync(() => {
        reads.push(input);
        return [
          {
            id: MessageId.make("m1"),
            at: Timestamp.make(1),
            author: "user" as const,
            text: "Synthetic context",
          },
        ];
      }),
    listTasks: () =>
      Effect.succeed([
        {
          id: task.id,
          botId: task.botId,
          title: task.title,
          status: task.status,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
          lastActivityAt: task.lastActivityAt,
          pendingRequestIds: [],
        },
      ]),
    getTask: (_identity, input) =>
      input.taskId === task.id
        ? Effect.succeed(task)
        : Effect.fail(new BridgeError({ code: "NotFound", message: "Unknown task." })),
    createBot: (_identity, { id, name }) => Effect.succeed({ id, name }),
    createTrigger: (_identity, input) =>
      Effect.succeed({
        ...input,
        id: input.id ?? TriggerId.make("fixture-trigger"),
        enabled: input.enabled ?? true,
        payload: input.payload ?? {},
        overlap: "skip" as const,
        createdAt: Timestamp.make(1),
        updatedAt: Timestamp.make(1),
      }),
    getTrigger: (_identity, input) =>
      input.triggerId === fixtureTrigger.id
        ? Effect.succeed(fixtureTrigger)
        : Effect.fail(new BridgeError({ code: "NotFound", message: "Unknown trigger." })),
    listTriggers: (_identity, input) =>
      Effect.succeed(
        input.botId !== undefined && input.botId !== fixtureTrigger.botId ? [] : [fixtureTrigger],
      ),
    listTriggerRuns: (_identity, input) =>
      input.triggerId === fixtureTrigger.id
        ? Effect.succeed([fixtureTriggerRun])
        : Effect.fail(new BridgeError({ code: "NotFound", message: "Unknown trigger." })),
    updateTrigger: (_identity, input) =>
      input.triggerId === fixtureTrigger.id
        ? Effect.succeed(
            Schema.decodeUnknownSync(Trigger)({
              ...fixtureTrigger,
              ...input.update,
              id: input.triggerId,
              updatedAt: Timestamp.make(2),
            }),
          )
        : Effect.fail(new BridgeError({ code: "NotFound", message: "Unknown trigger." })),
    proposeRoute: () =>
      Effect.sync(() => {
        proposals += 1;
        return { accepted: true, result: "decision-log" };
      }),
  });
  const bridge = yield* makeBridgeSocket({ socketPath: join(directory, "bridge.sock") }).pipe(
    Effect.provide(layer),
  );
  return {
    bridge,
    layer,
    reads,
    proposalCount: () => proposals,
    revokeBackend: () => {
      allowed = false;
    },
  };
});

it.scoped(
  "authenticates real Unix-socket requests, validates limits, and rechecks backend authorization",
  () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const credentials = yield* test.bridge.register(worker);
      const client = yield* makeSocketBridgeClient(credentials);
      expect(yield* client.identity).toEqual(worker);
      expect((yield* sdk(() => stat(test.bridge.socketPath))).mode & 0o777).toBe(0o600);
      expect(yield* client.call("read_main_thread", { ids: ["m1"] })).toEqual([
        { id: "m1", at: 1, author: "user", text: "Synthetic context" },
      ]);
      expect(yield* client.call("get_task", { taskId: "task" })).toEqual(task);
      expect(
        yield* client.call("create_trigger", {
          id: "fixture-trigger",
          name: "Fixture schedule",
          botId: worker.botId,
          prompt: "Run the fixture schedule",
          schedule: { kind: "once", at: 10 },
        }),
      ).toMatchObject({ id: "fixture-trigger", overlap: "skip" });
      expect(yield* client.call("get_trigger", { triggerId: "fixture-trigger" })).toEqual(
        fixtureTrigger,
      );
      expect(yield* client.call("list_triggers", { botId: worker.botId })).toEqual([
        fixtureTrigger,
      ]);
      expect(
        yield* client.call("update_trigger", {
          triggerId: fixtureTrigger.id,
          update: { enabled: false },
        }),
      ).toMatchObject({ id: fixtureTrigger.id, enabled: false, updatedAt: 2 });
      expect((yield* client.call("get_task", { taskId: "missing" }).pipe(Effect.flip)).code).toBe(
        "NotFound",
      );
      for (const [tool, input] of [
        ["read_main_thread", { ids: ["m1", "m1"] }],
        ["read_main_thread", { ids: ["m1"], limit: 1 }],
        ["read_main_thread", { ids: Array.from({ length: 51 }, (_, index) => `m${index}`) }],
        ["list_tasks", { limit: 51 }],
      ] as const)
        expect((yield* client.call(tool, input).pipe(Effect.flip)).code).toBe("InvalidInput");
      expect(test.reads).toHaveLength(1);
      expect(
        (yield* client
          .call("propose_route", {
            op: { op: "control", taskId: "task", action: "cancel" },
            rationale: "Synthetic test",
          })
          .pipe(Effect.flip)).code,
      ).toBe("Forbidden");
      expect(test.proposalCount()).toBe(0);
      test.revokeBackend();
      expect((yield* client.identity.pipe(Effect.flip)).code).toBe("Forbidden");
    }),
);

it.scoped("enforces body limits and strict tool schemas at the socket boundary", () =>
  Effect.gen(function* () {
    const test = yield* setup;
    const credentials = yield* test.bridge.register(worker);
    for (const body of [
      "{",
      JSON.stringify({ tool: "ask_user", input: {}, requestId: "fixture" }),
      JSON.stringify({
        tool: "get_task",
        input: { taskId: "task" },
        requestId: "fixture",
        role: "coordinator",
      }),
      JSON.stringify({
        tool: "get_task",
        input: { taskId: "x".repeat(BRIDGE_MAX_INPUT_BYTES) },
        requestId: "fixture",
      }),
    ]) {
      expect(yield* rawCall(credentials, body)).toMatchObject({
        ok: false,
        error: { code: "InvalidInput" },
      });
    }
    const client = yield* makeSocketBridgeClient(credentials);
    expect(yield* rawCall(credentials, '{"role":"coordinator"}', "/identity")).toMatchObject({
      ok: false,
      error: { code: "InvalidInput" },
    });
    expect(yield* client.identity).toEqual(worker);
    expect((yield* makeSocketBridgeClient(credentials, 0).pipe(Effect.flip)).code).toBe(
      "InvalidInput",
    );
  }),
);

it.scoped("interrupts pending backend work when the listener Scope closes", () =>
  Effect.gen(function* () {
    const test = yield* setup;
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const backend = yield* BridgeBackend.pipe(Effect.provide(test.layer));
    const listenerScope = yield* Scope.make();
    const listener = yield* makeBridgeSocket({
      socketPath: `${test.bridge.socketPath}.close`,
    }).pipe(
      Effect.provideService(BridgeBackend, {
        ...backend,
        listTasks: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.zipRight(Effect.never),
            Effect.ensuring(Deferred.succeed(cancelled, undefined)),
          ),
      }),
      Scope.extend(listenerScope),
    );
    const credentials = yield* listener.register(worker);
    const client = yield* makeSocketBridgeClient(credentials);
    const pending = yield* client.call("list_tasks", {}).pipe(Effect.either, Effect.fork);
    yield* Deferred.await(entered);
    yield* Scope.close(listenerScope, Exit.void);
    yield* Deferred.await(cancelled);
    expect((yield* Fiber.join(pending))._tag).toBe("Left");
    const replacement = yield* makeBridgeSocket({ socketPath: listener.socketPath }).pipe(
      Effect.provide(test.layer),
    );
    const replacementClient = yield* makeSocketBridgeClient(yield* replacement.register(worker));
    expect(yield* replacementClient.identity).toEqual(worker);
  }),
);

it("passes Electron's Node mode explicitly in ephemeral child configuration", () => {
  const original = Object.getOwnPropertyDescriptor(process.versions, "electron");
  Object.defineProperty(process.versions, "electron", { configurable: true, value: "fixture" });
  try {
    const config = mcpServerConfig(
      { socketPath: "/tmp/fixture.sock", token: Redacted.make("synthetic-token") },
      "/application/resources/daemon/stdio.js",
    );
    expect(config).toMatchObject({
      command: process.execPath,
      args: ["/application/resources/daemon/stdio.js"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        AUT_MCP_SOCKET: "/tmp/fixture.sock",
        AUT_MCP_TOKEN: "synthetic-token",
      },
    });
    expect(config.args).not.toContain("synthetic-token");
  } finally {
    if (original) Object.defineProperty(process.versions, "electron", original);
    else Reflect.deleteProperty(process.versions, "electron");
  }
});

it.scoped(
  "isolates credential scopes and rejects forged tokens or a duplicate socket listener",
  () =>
    Effect.gen(function* () {
      const test = yield* setup;
      const parentCredentials = yield* test.bridge.register(worker);
      const child = yield* Scope.make();
      const childCredentials = yield* test.bridge.register(slow).pipe(Scope.extend(child));
      const parentClient = yield* makeSocketBridgeClient(parentCredentials);
      const childClient = yield* makeSocketBridgeClient(childCredentials);
      yield* Scope.close(child, Exit.void);
      expect((yield* childClient.identity.pipe(Effect.flip)).code).toBe("Unauthorized");
      expect(yield* parentClient.identity).toEqual(worker);
      const forged = yield* makeSocketBridgeClient({
        socketPath: test.bridge.socketPath,
        token: Redacted.make("synthetic-invalid-token"),
      });
      expect((yield* forged.identity.pipe(Effect.flip)).code).toBe("Unauthorized");
      expect(
        (yield* makeBridgeSocket({ socketPath: test.bridge.socketPath }).pipe(
          Effect.provide(test.layer),
          Effect.flip,
        )).code,
      ).toBe("Unavailable");
      expect(yield* parentClient.identity).toEqual(worker);
      yield* test.bridge.revoke(parentCredentials.token);
      expect((yield* parentClient.identity.pipe(Effect.flip)).code).toBe("Unauthorized");
    }),
);

it.scoped("rejects long socket paths before binding and does not retry an uncertain proposal", () =>
  Effect.gen(function* () {
    const test = yield* setup;
    const tooLong = yield* makeBridgeSocket({ socketPath: `/tmp/${"a".repeat(105)}` }).pipe(
      Effect.provide(test.layer),
      Effect.flip,
    );
    expect(tooLong.code).toBe("InvalidInput");
    const credentials = yield* test.bridge.register(slow);
    const client = yield* makeSocketBridgeClient(credentials);
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    let calls = 0;
    const original = yield* Effect.serviceOption(BridgeBackend).pipe(Effect.provide(test.layer));
    if (original._tag !== "Some") return yield* Effect.die("Missing fixture backend");
    const slowLayer = Layer.succeed(BridgeBackend, {
      ...original.value,
      proposeRoute: () =>
        Effect.sync(() => {
          calls += 1;
        }).pipe(
          Effect.zipRight(Deferred.succeed(entered, undefined)),
          Effect.zipRight(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        ),
    });
    const slowSocket = yield* makeBridgeSocket({
      socketPath: `${test.bridge.socketPath}.slow`,
    }).pipe(Effect.provide(slowLayer));
    const slowCredentials = yield* slowSocket.register(slow);
    const slowClient = yield* makeSocketBridgeClient(slowCredentials, 100);
    const fiber = yield* Effect.fork(
      slowClient
        .call("propose_route", {
          op: { op: "control", taskId: "task", action: "cancel" },
          rationale: "Synthetic timeout",
        })
        .pipe(Effect.either),
    );
    yield* Deferred.await(entered);
    yield* TestClock.adjust("100 millis");
    const result = yield* Fiber.join(fiber);
    expect(result._tag === "Left" && result.left.code).toBe("Indeterminate");
    expect(calls).toBe(1);
    yield* Deferred.await(cancelled);
    expect(yield* client.identity).toEqual(slow);
  }),
);

it.scoped("serves role-specific tools through the official SDK and keeps ask_user disabled", () =>
  Effect.gen(function* () {
    const test = yield* setup;
    for (const identity of [worker, slow]) {
      const credentials = yield* test.bridge.register(identity);
      const socket = yield* makeSocketBridgeClient(credentials);
      const server = yield* makeMcpServer(socket);
      const client = new Client({ name: "aut-test", version: "1" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      yield* Effect.acquireRelease(
        sdk(() => server.connect(serverTransport)),
        () => sdk(() => server.close()).pipe(Effect.ignore),
      );
      yield* Effect.acquireRelease(
        sdk(() => client.connect(clientTransport)),
        () => sdk(() => client.close()).pipe(Effect.ignore),
      );
      const tools = yield* sdk(() => client.listTools());
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "read_main_thread",
        "list_tasks",
        "get_task",
        "create_bot",
        "create_trigger",
        "get_trigger",
        "list_triggers",
        "list_trigger_runs",
        "update_trigger",
        "mcp_info",
        "mcp_server",
        ...(identity.role === "coordinator" ? ["propose_route"] : []),
      ]);
      const child = { id: "calendar", name: "日程助手", description: "整理日程", soul: "" };
      const created = yield* sdk(() => client.callTool({ name: "create_bot", arguments: child }));
      expect(created.structuredContent).toEqual({ result: { id: child.id, name: child.name } });
      const trigger = yield* sdk(() =>
        client.callTool({
          name: "create_trigger",
          arguments: {
            id: `trigger-${identity.role}`,
            name: "Fixture schedule",
            botId: identity.botId,
            prompt: "Run the fixture schedule",
            schedule: { kind: "once", at: 10 },
          },
        }),
      );
      expect(trigger.isError).not.toBe(true);
      expect(trigger.structuredContent).toMatchObject({
        result: { id: `trigger-${identity.role}`, overlap: "skip" },
      });
      const readTrigger = yield* sdk(() =>
        client.callTool({
          name: "get_trigger",
          arguments: { triggerId: "fixture-trigger" },
        }),
      );
      expect(readTrigger.structuredContent).toMatchObject({
        result: { id: "fixture-trigger" },
      });
      const listedTriggers = yield* sdk(() =>
        client.callTool({
          name: "list_triggers",
          arguments: { limit: 10 },
        }),
      );
      expect(listedTriggers.structuredContent).toMatchObject({
        result: [{ id: "fixture-trigger" }],
      });
      const listedRuns = yield* sdk(() =>
        client.callTool({
          name: "list_trigger_runs",
          arguments: { triggerId: fixtureTrigger.id, limit: 10 },
        }),
      );
      expect(listedRuns.structuredContent).toMatchObject({
        result: [{ id: fixtureTriggerRun.id, status: "ran" }],
      });
      const updatedTrigger = yield* sdk(() =>
        client.callTool({
          name: "update_trigger",
          arguments: {
            triggerId: "fixture-trigger",
            update: { enabled: false },
          },
        }),
      );
      expect(updatedTrigger.structuredContent).toMatchObject({
        result: { id: "fixture-trigger", enabled: false },
      });
      const elevated = yield* sdk(() =>
        client.callTool({ name: "create_bot", arguments: { ...child, system: "primary" } }),
      );
      expect(elevated.isError).toBe(true);
      const read = yield* sdk(() =>
        client.callTool({ name: "read_main_thread", arguments: { ids: ["m1"] } }),
      );
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ result: [{ id: "m1" }] });
      const invalid = yield* sdk(() =>
        client.callTool({ name: "list_tasks", arguments: { limit: 51 } }),
      );
      expect(invalid.isError).toBe(true);
      if (identity.role === "coordinator") {
        const result = yield* sdk(() =>
          client.callTool({
            name: "propose_route",
            arguments: {
              op: { op: "control", taskId: "task", action: "cancel" },
              rationale: "Synthetic test",
            },
          }),
        );
        expect(result.structuredContent).toEqual({
          result: { accepted: true, result: "decision-log" },
        });
      }
    }
    expect(test.proposalCount()).toBe(1);
  }),
);

it.scoped("runs the actual stdio child with a scoped session credential", () =>
  Effect.gen(function* () {
    const test = yield* setup;
    const credentials = yield* test.bridge.register(worker);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../dist/stdio.js", import.meta.url))],
      env: {
        AUT_MCP_SOCKET: credentials.socketPath,
        AUT_MCP_TOKEN: Redacted.value(credentials.token),
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "aut-stdio-test", version: "1" });
    yield* Effect.acquireRelease(
      sdk(() => client.connect(transport)),
      () => sdk(() => client.close()).pipe(Effect.ignore),
    );
    const tools = yield* sdk(() => client.listTools());
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "read_main_thread",
      "list_tasks",
      "get_task",
      "create_bot",
      "create_trigger",
      "get_trigger",
      "list_triggers",
      "list_trigger_runs",
      "update_trigger",
      "mcp_info",
      "mcp_server",
    ]);
    const taskResult = yield* sdk(() =>
      client.callTool({ name: "get_task", arguments: { taskId: "task" } }),
    );
    expect(taskResult.structuredContent).toEqual({ result: task });
    yield* test.bridge.revoke(credentials.token);
    const revoked = yield* sdk(() => client.callTool({ name: "list_tasks", arguments: {} }));
    expect(revoked.isError).toBe(true);
  }),
);
