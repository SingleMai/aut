import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BotMemory,
  ConfigStore,
  CoreLive,
  HarnessResolver,
  memoryDreamTriggerId,
  SessionSetup,
} from "@aut/core";
import type { BridgeSocket } from "@aut/mcp-bridge";
import { BotConfig, type McpServerConfig, Task } from "@aut/protocol";
import { Effect, Either, Exit, Fiber, Layer, Redacted, Schema, Scope } from "effect";
import { afterEach, expect, it } from "vitest";
import { McpSupervisor } from "./mcp-supervisor.js";
import {
  HarnessResolverLive,
  SessionBridge,
  SessionBridgeLive,
  SessionSetupLive,
} from "./session-setup.js";

const directories: string[] = [];
const directory = () => {
  const path = mkdtempSync(join(tmpdir(), "aut-session-setup-"));
  directories.push(path);
  return path;
};
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { force: true, recursive: true });
});
const makeBot = (cwd: string) =>
  Schema.decodeUnknownSync(BotConfig)({
    id: "../role.with/slash",
    name: "Bot",
    description: "Work",
    soul: "Test role instructions",
    cwd,
    modelSelection: { instanceId: "local", model: "test-model", effort: "low" },
  });
const makeTask = (bot: BotConfig) =>
  Schema.decodeUnknownSync(Task)({
    id: "task",
    botId: bot.id,
    title: "Task",
    status: "created",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    session: { instanceId: "local" },
    pendingRequestIds: [],
    queue: [],
    origin: { kind: "user" },
  });
const credentials = {
  socketPath: "/tmp/synthetic.sock",
  token: Redacted.make("synthetic-session-secret"),
};
const mcpSupervisor = (configs: readonly McpServerConfig[] = []) =>
  Layer.succeed(McpSupervisor, {
    configsForBot: () => Effect.succeed(configs),
  } as unknown as McpSupervisor["Type"]);

it("writes only its managed soul, preserves AGENTS and injects authorized MCP proxies", async () => {
  const path = directory();
  writeFileSync(join(path, "AGENTS.md"), "Existing project instructions\n");
  const bot = makeBot(path);
  let active = 0;
  const socket: BridgeSocket = {
    socketPath: credentials.socketPath,
    revoke: () => Effect.void,
    register: () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          active++;
          return credentials;
        }),
        () =>
          Effect.sync(() => {
            active--;
          }),
      ),
  };
  const external: McpServerConfig = {
    name: "extra",
    transport: "stdio",
    command: "existing",
    args: ["keep"],
  };
  const setup = SessionSetupLive.pipe(
    Layer.provideMerge(SessionBridgeLive),
    Layer.provideMerge(mcpSupervisor([external])),
    Layer.provideMerge(CoreLive({ dataDirectory: directory() })),
  );
  const input = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* ConfigStore).writeBots([bot]);
        yield* (yield* BotMemory).write(
          bot.id,
          "MEMORY.md",
          "Remember the synthetic blue preference.",
        );
        yield* (yield* SessionBridge).bind(socket);
        const inner = yield* Scope.make();
        const input = yield* Scope.extend((yield* SessionSetup).prepare(makeTask(bot), bot), inner);
        expect(active).toBe(1);
        yield* Scope.close(inner, Exit.succeed(undefined));
        expect(active).toBe(0);
        return input;
      }).pipe(Effect.provide(setup)),
    ),
  );
  expect(readFileSync(join(path, "AGENTS.md"), "utf8")).toBe("Existing project instructions\n");
  const files = readdirSync(join(path, ".aut", "souls"));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^[a-f0-9]{64}\.md$/);
  const role = join(path, ".aut", "souls", files[0] ?? "missing");
  expect(readFileSync(role, "utf8")).toContain(bot.soul);
  expect(statSync(role).mode & 0o777).toBe(0o600);
  expect(input.model).toBe("test-model");
  expect(input.effort).toBe("low");
  expect(input.mcpServers[0]).toEqual(external);
  expect(input.mcpServers[1]?.name).toBe("aut");
  expect(input.instructions).not.toContain("synthetic-session-secret");
  expect(input.instructions).toContain("Remember the synthetic blue preference.");
  expect(input.instructions).toContain("notes");
  expect(readFileSync(role, "utf8")).not.toContain("synthetic-session-secret");
});

it("waits for listener readiness and refuses a second binding", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const bridge = yield* SessionBridge;
        const bot = makeBot("/tmp");
        const fiber = yield* bridge
          .register({ taskId: makeTask(bot).id, botId: bot.id, role: "worker" })
          .pipe(Effect.forkScoped);
        const socket: BridgeSocket = {
          socketPath: credentials.socketPath,
          register: () => Effect.succeed(credentials),
          revoke: () => Effect.void,
        };
        yield* bridge.bind(socket);
        expect((yield* Fiber.join(fiber)).socketPath).toBe(credentials.socketPath);
        expect(Either.isLeft(yield* Effect.either(bridge.bind(socket)))).toBe(true);
      }).pipe(Effect.provide(SessionBridgeLive)),
    ),
  );
});

it("isolates memory for bots sharing a workdir and snapshots a dedicated dream session", async () => {
  const cwd = directory();
  const bot = makeBot(cwd);
  const other = Schema.decodeUnknownSync(BotConfig)({ ...bot, id: "other-bot" });
  const layer = SessionSetupLive.pipe(
    Layer.provideMerge(
      Layer.succeed(SessionBridge, {
        bind: () => Effect.void,
        register: () => Effect.succeed(credentials),
      }),
    ),
    Layer.provideMerge(mcpSupervisor()),
    Layer.provideMerge(CoreLive({ dataDirectory: directory() })),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* (yield* ConfigStore).writeBots([bot, other]);
        const memory = yield* BotMemory;
        yield* memory.write(bot.id, "MEMORY.md", "OWN_MEMORY_CANARY");
        yield* memory.write(other.id, "MEMORY.md", "OTHER_MEMORY_CANARY");
        const setup = yield* SessionSetup;
        const first = yield* setup.prepare(makeTask(bot), bot);
        expect(first.instructions).toContain("OWN_MEMORY_CANARY");
        expect(first.instructions).not.toContain("OTHER_MEMORY_CANARY");
        const root = yield* memory.directory(bot.id);
        writeFileSync(join(root, "MEMORY.md"), "NATIVE_FILE_EDIT_CANARY");
        const second = yield* setup.prepare(makeTask(bot), bot);
        expect(second.instructions).toContain("NATIVE_FILE_EDIT_CANARY");
        const dream = Schema.decodeUnknownSync(Task)({
          ...makeTask(bot),
          id: `trigger:run:${memoryDreamTriggerId(bot.id)}:1`,
          origin: { kind: "trigger" },
        });
        const prepared = yield* setup.prepare(dream, bot);
        expect(prepared.model).toBe(bot.modelSelection.model);
        expect(prepared.instructions).toContain("scheduled memory maintenance session");
        expect(prepared.instructions).toContain("read_task_session");
        expect(
          (yield* memory.list(bot.id)).snapshots.some((snapshot) => snapshot.reason === "dream"),
        ).toBe(true);
        expect(
          (yield* memory.list(other.id)).snapshots.some((snapshot) => snapshot.reason === "dream"),
        ).toBe(false);
      }).pipe(Effect.provide(layer)),
    ),
  );
});

it("rejects symlinked managed directories before registering a session", async () => {
  const path = directory();
  const bot = makeBot(path);
  symlinkSync(directory(), join(path, ".aut"));
  const layer = SessionSetupLive.pipe(
    Layer.provide(
      Layer.succeed(SessionBridge, {
        bind: () => Effect.void,
        register: () => Effect.dieMessage("Invalid setup must not register a session credential"),
      }),
    ),
    Layer.provideMerge(mcpSupervisor()),
    Layer.provideMerge(CoreLive({ dataDirectory: directory() })),
  );
  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.either(
        Effect.gen(function* () {
          return yield* (yield* SessionSetup).prepare(makeTask(bot), bot);
        }).pipe(Effect.provide(layer)),
      ),
    ),
  );
  expect(Either.isLeft(outcome) && outcome.left.code).toBe("Configuration");
});

it("resolves configured harness factories while preserving the original instance configuration", async () => {
  const dataDirectory = directory();
  const settings = {
    harnessInstances: [
      {
        id: "local",
        name: "Existing",
        kind: "codex",
        command: "/existing/codex",
        args: ["app-server"],
        env: { EXISTING: "keep" },
      },
      {
        id: "claude-local",
        name: "Claude",
        kind: "claude",
        command: "/existing/claude",
        args: [],
      },
      {
        id: "acp-local",
        name: "ACP",
        kind: "acp",
        command: "/existing/opencode",
        args: ["acp"],
        authMethodIds: ["grok.com"],
      },
    ],
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ConfigStore;
        yield* config.writeConfig(settings);
        const resolver = yield* HarnessResolver;
        expect((yield* resolver.resolve("local")).kind).toBe("codex");
        expect((yield* resolver.resolve("claude-local")).kind).toBe("claude");
        expect((yield* resolver.resolve("acp-local")).kind).toBe("acp");
        expect(Either.isLeft(yield* Effect.either(resolver.resolve("missing")))).toBe(true);
        expect(yield* config.readConfig).toEqual(settings);
      }).pipe(
        Effect.provide(HarnessResolverLive.pipe(Layer.provideMerge(CoreLive({ dataDirectory })))),
      ),
    ),
  );
});
