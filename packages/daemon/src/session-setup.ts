import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { makeAcpAdapter, makeClaudeAdapter, makeCodexAdapter } from "@aut/adapters";
import {
  ConfigStore,
  CoreError,
  HarnessResolver,
  isCoordinationTask,
  SessionSetup,
} from "@aut/core";
import {
  type BridgeCredentials,
  BridgeError,
  type BridgeSocket,
  mcpServerConfig,
  type SessionIdentity,
} from "@aut/mcp-bridge";
import { type HarnessAdapter, type HarnessInstanceConfig, StartSessionInput } from "@aut/protocol";
import { Context, Deferred, Effect, Layer, Schema, type Scope } from "effect";
import { McpSupervisor } from "./mcp-supervisor.js";

export class SessionBridge extends Context.Tag("aut/SessionBridge")<
  SessionBridge,
  {
    readonly bind: (socket: BridgeSocket) => Effect.Effect<void, BridgeError>;
    readonly register: (
      identity: SessionIdentity,
    ) => Effect.Effect<BridgeCredentials, BridgeError, Scope.Scope>;
  }
>() {}
export const SessionBridgeLive = Layer.effect(
  SessionBridge,
  Effect.gen(function* () {
    const ready = yield* Deferred.make<BridgeSocket>();
    return {
      bind: (socket) =>
        Deferred.succeed(ready, socket).pipe(
          Effect.flatMap((bound) =>
            bound
              ? Effect.void
              : Effect.fail(
                  new BridgeError({
                    code: "Unavailable",
                    message: "The session bridge has already been bound",
                  }),
                ),
          ),
        ),
      register: (identity) =>
        Deferred.await(ready).pipe(Effect.flatMap((socket) => socket.register(identity))),
    };
  }),
);

const factories: Readonly<Record<string, (config: HarnessInstanceConfig) => HarnessAdapter>> = {
  codex: (config) =>
    makeCodexAdapter({
      command: config.command,
      args: config.args,
      ...(config.env ? { env: config.env } : {}),
    }),
  claude: (config) =>
    makeClaudeAdapter({
      command: config.command,
      args: config.args,
      ...(config.env ? { env: config.env } : {}),
    }),
  acp: (config) =>
    makeAcpAdapter({
      command: config.command,
      args: config.args,
      ...(config.env ? { env: config.env } : {}),
      ...(config.authMethodIds ? { authMethodIds: config.authMethodIds } : {}),
    }),
};
export const HarnessResolverLive = Layer.effect(
  HarnessResolver,
  Effect.gen(function* () {
    const store = yield* ConfigStore;
    return {
      resolve: (id) =>
        Effect.gen(function* () {
          const config = (yield* store.readConfig).harnessInstances.find(
            (entry) => entry.id === id,
          );
          const factory =
            config && Object.hasOwn(factories, config.kind) ? factories[config.kind] : undefined;
          if (!config || !factory)
            return yield* Effect.fail(
              new CoreError({
                code: "Configuration",
                message: "The configured harness instance is unavailable",
              }),
            );
          return factory(config);
        }),
    };
  }),
);

const managedPrefix = "<!-- Managed by aut: edit this role through bot settings. -->\n";
const writeSoul = (cwd: string, id: string, soul: string) =>
  Effect.try({
    try: () => {
      const root = resolve(cwd);
      if (!statSync(root).isDirectory()) throw new Error("The workdir is not a directory");
      const managed = join(root, ".aut");
      const directory = join(managed, "souls");
      for (const path of [managed, directory]) {
        if (existsSync(path)) {
          const stat = lstatSync(path);
          if (stat.isSymbolicLink() || !stat.isDirectory())
            throw new Error("The managed role directory is not a regular directory");
        } else mkdirSync(path, { mode: 0o700 });
      }
      const path = join(directory, `${createHash("sha256").update(id).digest("hex")}.md`);
      const contents = `${managedPrefix}${soul}\n`;
      if (existsSync(path)) {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error("The managed role is not a regular file");
        const previous = readFileSync(path, "utf8");
        if (!previous.startsWith(managedPrefix))
          throw new Error("The role file is not owned by aut");
        if (previous === contents) return path;
      }
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, contents, { mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      return path;
    },
    catch: () =>
      new CoreError({
        code: "Configuration",
        message: "The bot role file could not be safely prepared in its working directory",
      }),
  });

export const SessionSetupLive = Layer.effect(
  SessionSetup,
  Effect.gen(function* () {
    const bridge = yield* SessionBridge;
    const mcp = yield* McpSupervisor;
    return {
      prepare: (task, bot) =>
        Effect.gen(function* () {
          if (task.botId !== bot.id || task.session.instanceId !== bot.modelSelection.instanceId)
            return yield* Effect.fail(
              new CoreError({
                code: "ImmutableField",
                message: "The task cannot switch its configured bot or harness instance",
              }),
            );
          const path = yield* writeSoul(bot.cwd, bot.id, bot.soul);
          const coordination = isCoordinationTask(task, bot);
          const credentials = yield* bridge
            .register({
              taskId: task.id,
              botId: bot.id,
              role: coordination ? "coordinator" : "worker",
            })
            .pipe(
              Effect.mapError(
                () =>
                  new CoreError({
                    code: "Configuration",
                    message: "The session MCP identity could not be registered",
                  }),
              ),
            );
          const externalMcp = yield* mcp.configsForBot(task.id, bot.id);
          return yield* Schema.decodeUnknown(StartSessionInput)({
            taskId: task.id,
            bot,
            model: bot.modelSelection.model,
            ...(bot.modelSelection.effort === undefined
              ? {}
              : { effort: bot.modelSelection.effort }),
            cwd: bot.cwd,
            instructions: [
              "You are a configured worker in aut. The user's main thread is the communication entry point.",
              `Read your persistent role instructions from ${JSON.stringify(path)}.`,
              bot.soul,
              ...(coordination
                ? [
                    "This is a coordination task. Use the decision summary to resolve the request. Complete work you can do yourself. When another task is needed, use propose_route to suggest it to the chief. A registered proposal confirms dispatch, not completion.",
                  ]
                : []),
              "Use the aut MCP tools to read relevant main-thread messages and task details by ID when needed. The full main thread is not automatically included.",
              "Attachments are immutable snapshots. Read their paths using your file or image tools; copy to your working directory before editing. When producing deliverables, link each completed file in your final report using [filename](absolute-path) or ![description](absolute-image-path). Keep deliverables in visible folders under this session's working directory; aut saves each reported file as a separate historical snapshot (up to 16 files, 20 MiB each).",
              "When the user asks you to create an aut bot, use the create_bot MCP tool. Its successful result confirms the saved bot ID.",
              "Use the harness native question tool when user input is required. Do not replace questions with textual markers. Return a clear final report after completing the requested work.",
            ].join("\n\n"),
            mcpServers: [...externalMcp, mcpServerConfig(credentials)],
          }).pipe(
            Effect.mapError(
              () =>
                new CoreError({
                  code: "Configuration",
                  message: "The session configuration is invalid",
                }),
            ),
          );
        }),
    };
  }),
);
