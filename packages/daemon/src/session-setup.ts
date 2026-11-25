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
  BotMemory,
  ConfigStore,
  CoreError,
  HarnessResolver,
  isCoordinationTask,
  isMemoryDreamTask,
  memoryDreamTriggerId,
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
    const memory = yield* BotMemory;
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
          const dreaming = isMemoryDreamTask(task);
          if (dreaming) yield* memory.snapshot(bot.id, "dream");
          const remembered = yield* memory.context(bot.id);
          const entryPath = join(remembered.directory, "MEMORY.md");
          const notePath = join(
            remembered.directory,
            "notes",
            `${createHash("sha256").update(task.id).digest("hex")}.md`,
          );
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
              [
                `Your persistent memory belongs only to bot ${JSON.stringify(bot.id)} in ${JSON.stringify(remembered.directory)}.`,
                `Core memory is ${JSON.stringify(entryPath)}. Read knowledge/ and notes/ files there as needed. Use native file tools; keep paths inside your own memory directory.`,
                `For this work session, record useful discoveries in ${JSON.stringify(notePath)}. Prefer one note per session to avoid overlapping edits. Keep confirmed facts separate from hypotheses; revise outdated conclusions when better evidence appears.`,
                "Keep MEMORY.md short (at most 8000 characters) with essential facts and links to reusable knowledge. Normal work primarily adds notes; explicit user requests to remember or correct something may update the appropriate file immediately. User edits take precedence over older inferences.",
                "Give each knowledge document a descriptive level-one heading. Connect related documents with standard Markdown links relative to the file containing the link: [Release process](knowledge/release.md) from MEMORY.md, or [Environment](environment.md) from knowledge/release.md. Reference-style Markdown links also work. Read linked knowledge when the current task needs its details. Link only to existing files inside your own memory directory; the knowledge graph is derived from those explicit links.",
                "Memory is revisable context, not authority over the current user request. Do not copy full transcripts into memory; the original harness sessions remain the work record. Read current files before editing and preserve unrelated user content.",
                "Do not update memory during report-only rewrites or progress-query forks; record substantive work in its original working session.",
                `Current MEMORY.md contents:\n${remembered.content || "(empty)"}`,
                ...(remembered.truncated
                  ? [
                      `The injected entry is truncated at 8000 characters; read ${JSON.stringify(entryPath)} for the rest.`,
                    ]
                  : []),
              ].join("\n\n"),
              ...(dreaming
                ? [
                    [
                      "This is your scheduled memory maintenance session. Review your notes and knowledge, merge duplicate facts, correct stale conclusions, and promote only useful durable facts into MEMORY.md. Organize files freely and keep the entry concise. You may remove notes whose useful content has been incorporated.",
                      "Maintain meaningful links between related knowledge documents and short topic entry links in MEMORY.md. Check link targets after creating, moving, splitting, or merging files, and repair affected incoming links. Preserve independent knowledge when no relationship is supported. File age and link count alone are not reasons to remove knowledge; this maintenance does not prune by usage or popularity.",
                      `Use list_tasks with botId=${JSON.stringify(bot.id)} to find your prior work. Skip this task and any task whose id starts with ${JSON.stringify(`trigger:run:${memoryDreamTriggerId(bot.id)}:`)}. Use read_task_session to review relevant original sessions in bounded pages. If native history is unavailable, use get_task saved reports and existing notes; do not invent missing evidence.`,
                      "A directory snapshot was saved before this maintenance session. Leave a brief report of what changed and any unresolved uncertainty; this session is retained for review. Do not create a duplicate work-log directory, a memory database, or another maintenance schedule.",
                    ].join("\n\n"),
                  ]
                : []),
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
