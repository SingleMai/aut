import { randomUUID } from "node:crypto";
import {
  type BotId,
  type McpConfig,
  type McpGrant,
  type McpServer,
  McpServerId,
  type McpServerInput,
  type McpTool,
} from "@aut/protocol";
import { Context, Effect, Layer, Option } from "effect";
import { ConfigStore } from "./config-store.js";
import { CoreError } from "./errors.js";

export class McpRegistry extends Context.Tag("aut/McpRegistry")<
  McpRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<McpServer>, CoreError>;
    readonly get: (id: McpServerId) => Effect.Effect<Option.Option<McpServer>, CoreError>;
    readonly create: (input: McpServerInput) => Effect.Effect<McpServer, CoreError>;
    readonly update: (
      id: McpServerId,
      input: McpServerInput,
    ) => Effect.Effect<McpServer, CoreError>;
    readonly remove: (id: McpServerId) => Effect.Effect<void, CoreError>;
    readonly setEnabled: (id: McpServerId, enabled: boolean) => Effect.Effect<McpServer, CoreError>;
    readonly listGrants: (botId?: BotId) => Effect.Effect<ReadonlyArray<McpGrant>, CoreError>;
    readonly setGrant: (
      botId: BotId,
      serverId: McpServerId,
      enabled: boolean,
      allowedTools: readonly string[],
    ) => Effect.Effect<McpGrant, CoreError>;
    readonly updateTools: (
      id: McpServerId,
      tools: readonly McpTool[],
    ) => Effect.Effect<McpServer, CoreError>;
    readonly updateHealth: (
      id: McpServerId,
      health: McpServer["health"],
    ) => Effect.Effect<McpServer, CoreError>;
    readonly updateAuth: (
      id: McpServerId,
      auth: McpServer["auth"],
    ) => Effect.Effect<McpServer, CoreError>;
  }
>() {}

const missingServer = () =>
  new CoreError({ code: "NotFound", message: "The MCP server was not found" });

const createServer = (id: McpServerId, input: McpServerInput): McpServer => ({
  ...input,
  id,
  enabled: false,
  auth: { status: "none" },
  health: { status: "unknown" },
  tools: [],
});

export const McpRegistryLive = Layer.effect(
  McpRegistry,
  Effect.gen(function* () {
    const config = yield* ConfigStore;
    const mutate = <A>(
      modify: (
        current: McpConfig,
      ) => Effect.Effect<{ readonly config: McpConfig; readonly value: A }, CoreError>,
    ) =>
      config.withMutation(
        Effect.gen(function* () {
          const current = yield* config.readMcp;
          const result = yield* modify(current);
          yield* config.writeMcp(result.config);
          return result.value;
        }),
      );
    const find = (current: McpConfig, id: McpServerId) =>
      current.servers.find((server) => server.id === id);
    return {
      list: config.readMcp.pipe(Effect.map((value) => value.servers)),
      get: (id) => config.readMcp.pipe(Effect.map((value) => Option.fromNullable(find(value, id)))),
      create: (input) =>
        mutate((current) => {
          const id = McpServerId.make(`mcp-${randomUUID()}`);
          const server = createServer(id, input);
          if (current.servers.some((entry) => entry.name === input.name))
            return Effect.fail(
              new CoreError({ code: "Conflict", message: "An MCP server with this name exists" }),
            );
          return Effect.succeed({
            config: { ...current, servers: [...current.servers, server] },
            value: server,
          });
        }),
      update: (id, input) =>
        mutate((current) => {
          const previous = find(current, id);
          if (!previous) return Effect.fail(missingServer());
          if (current.servers.some((entry) => entry.id !== id && entry.name === input.name))
            return Effect.fail(
              new CoreError({ code: "Conflict", message: "An MCP server with this name exists" }),
            );
          const connectionChanged =
            previous.transport !== input.transport ||
            (input.transport === "stdio"
              ? previous.transport !== "stdio" ||
                previous.command !== input.command ||
                JSON.stringify(previous.args) !== JSON.stringify(input.args) ||
                previous.cwd !== input.cwd ||
                JSON.stringify(previous.env ?? {}) !== JSON.stringify(input.env ?? {})
              : previous.transport === "stdio" ||
                previous.url !== input.url ||
                JSON.stringify(previous.headers ?? {}) !== JSON.stringify(input.headers ?? {}) ||
                JSON.stringify(previous.oauth ?? {}) !== JSON.stringify(input.oauth ?? {}));
          const server = {
            ...createServer(id, input),
            enabled: connectionChanged ? false : previous.enabled,
            auth: connectionChanged ? { status: "none" as const } : previous.auth,
            health: connectionChanged ? { status: "unknown" as const } : previous.health,
            tools: connectionChanged ? [] : previous.tools,
          } as McpServer;
          return Effect.succeed({
            config: {
              ...current,
              servers: current.servers.map((entry) => (entry.id === id ? server : entry)),
            },
            value: server,
          });
        }),
      remove: (id) =>
        mutate((current) => {
          if (!find(current, id)) return Effect.fail(missingServer());
          return Effect.succeed({
            config: {
              ...current,
              servers: current.servers.filter((entry) => entry.id !== id),
              grants: current.grants.filter((grant) => grant.serverId !== id),
            },
            value: undefined,
          });
        }),
      setEnabled: (id, enabled) =>
        mutate((current) => {
          const server = find(current, id);
          if (!server) return Effect.fail(missingServer());
          const next = { ...server, enabled } as McpServer;
          return Effect.succeed({
            config: {
              ...current,
              servers: current.servers.map((entry) => (entry.id === id ? next : entry)),
            },
            value: next,
          });
        }),
      listGrants: (botId) =>
        config.readMcp.pipe(
          Effect.map((value) =>
            value.grants.filter((grant) => botId === undefined || grant.botId === botId),
          ),
        ),
      setGrant: (botId, serverId, enabled, allowedTools) =>
        mutate((current) => {
          const server = find(current, serverId);
          if (!server) return Effect.fail(missingServer());
          const known = new Set(server.tools.map((tool) => tool.name));
          const grant: McpGrant = {
            botId,
            serverId,
            enabled,
            allowedTools: [...new Set(allowedTools)].filter((tool) => known.has(tool)),
          };
          const grants = current.grants.some(
            (entry) => entry.botId === botId && entry.serverId === serverId,
          )
            ? current.grants.map((entry) =>
                entry.botId === botId && entry.serverId === serverId ? grant : entry,
              )
            : [...current.grants, grant];
          return Effect.succeed({ config: { ...current, grants }, value: grant });
        }),
      updateTools: (id, tools) =>
        mutate((current) => {
          const server = find(current, id);
          if (!server) return Effect.fail(missingServer());
          const names = new Set(tools.map((tool) => tool.name));
          const next = {
            ...server,
            tools: [...tools],
          } as McpServer;
          return Effect.succeed({
            config: {
              ...current,
              servers: current.servers.map((entry) => (entry.id === id ? next : entry)),
              grants: current.grants.map((grant) =>
                grant.serverId === id
                  ? { ...grant, allowedTools: grant.allowedTools.filter((tool) => names.has(tool)) }
                  : grant,
              ),
            },
            value: next,
          });
        }),
      updateHealth: (id, health) =>
        mutate((current) => {
          const server = find(current, id);
          if (!server) return Effect.fail(missingServer());
          const next = { ...server, health } as McpServer;
          return Effect.succeed({
            config: {
              ...current,
              servers: current.servers.map((entry) => (entry.id === id ? next : entry)),
            },
            value: next,
          });
        }),
      updateAuth: (id, auth) =>
        mutate((current) => {
          const server = find(current, id);
          if (!server) return Effect.fail(missingServer());
          const next = { ...server, auth } as McpServer;
          return Effect.succeed({
            config: {
              ...current,
              servers: current.servers.map((entry) => (entry.id === id ? next : entry)),
            },
            value: next,
          });
        }),
    };
  }),
);
