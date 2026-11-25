// Tool visibility and per-call authorization follow OpenMausBot's
// server/drivers/agents-mcp.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Design reference only; implemented using the official MCP SDK. See NOTICE.
import {
  CreateBotInput,
  CreateBotOutput,
  CreateTriggerInput,
  CreateTriggerOutput,
  GetTaskInput,
  GetTaskOutput,
  GetTriggerInput,
  GetTriggerOutput,
  ListTasksInput,
  ListTasksOutput,
  ListTriggerRunsInput,
  ListTriggerRunsOutput,
  ListTriggersInput,
  ListTriggersOutput,
  McpInfoInput,
  McpInfoOutput,
  McpServerToolInput,
  McpServerToolOutput,
  ProposeRouteInput,
  ProposeRouteOutput,
  ReadMainThreadInput,
  ReadMainThreadOutput,
  ReadTaskSessionInput,
  ReadTaskSessionOutput,
  UpdateTriggerOutput,
  UpdateTriggerToolInput,
} from "@aut/protocol";
import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { Effect, JSONSchema, Schema, type Scope } from "effect";
import { BridgeError } from "./interface.js";
import { BRIDGE_MAX_INPUT_BYTES, type BridgeCall, type SocketBridgeClient } from "./socket.js";

/** Uses Effect for validation and JSON Schema for MCP discovery, without a second business schema. */
export const mcpSchema = <A, I>(schema: Schema.Schema<A, I>): StandardSchemaWithJSON<I, A> => {
  const standard = Schema.standardSchemaV1(schema, { onExcessProperty: "error" });
  const json: Record<string, unknown> = { ...JSONSchema.make(schema) };
  return {
    "~standard": {
      ...standard["~standard"],
      jsonSchema: { input: () => json, output: () => json },
    },
  };
};

export const makeMcpServer = (client: SocketBridgeClient): Effect.Effect<McpServer, BridgeError> =>
  Effect.gen(function* () {
    const identity = yield* client.identity;
    const server = new McpServer(
      { name: "aut", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    const register = <A, I, B, O>(
      name: BridgeCall["tool"],
      description: string,
      input: Schema.Schema<A, I>,
      output: Schema.Schema<B, O>,
    ) => {
      server.registerTool(
        name,
        {
          description,
          inputSchema: mcpSchema(input),
          outputSchema: mcpSchema(Schema.Struct({ result: output })),
          annotations: {
            readOnlyHint:
              name !== "propose_route" &&
              name !== "create_bot" &&
              name !== "create_trigger" &&
              name !== "update_trigger" &&
              name !== "mcp_server",
            destructiveHint: name === "propose_route" || name === "mcp_server",
            idempotentHint:
              name !== "propose_route" &&
              name !== "create_bot" &&
              name !== "create_trigger" &&
              name !== "mcp_server",
            openWorldHint: false,
          },
        },
        (arguments_, context) =>
          Effect.runPromise(
            client.call(name, arguments_).pipe(
              Effect.flatMap((value) => Schema.decodeUnknown(output)(value)),
              Effect.match({
                onSuccess: (result) => ({
                  content: [{ type: "text" as const, text: JSON.stringify(result) }],
                  structuredContent: { result },
                }),
                onFailure: (error) => ({
                  content: [
                    {
                      type: "text" as const,
                      text:
                        error._tag === "BridgeError"
                          ? `${error.code}: ${error.message}`
                          : "Invalid bridge response.",
                    },
                  ],
                  isError: true,
                }),
              }),
            ),
            { signal: context.mcpReq.signal },
          ),
      );
    };
    register(
      "read_main_thread",
      "Read specific main-thread messages or a bounded chronological page. Use IDs to request only the context needed for this task.",
      ReadMainThreadInput,
      ReadMainThreadOutput,
    );
    register(
      "list_tasks",
      "List at most 50 tasks, optionally filtered by status or bot. This tool never changes tasks.",
      ListTasksInput,
      ListTasksOutput,
    );
    register(
      "read_task_session",
      "Read a bounded page of a task's original harness session. Only tasks owned by your current Bot are accessible. Use nextBefore to read earlier turns; if history is unsupported, use the saved task report and your notes. This tool does not start or resume work.",
      ReadTaskSessionInput,
      ReadTaskSessionOutput,
    );
    register(
      "get_task",
      "Read one task by ID, including its status, pending request IDs and saved report.",
      GetTaskInput,
      GetTaskOutput,
    );
    register(
      "create_bot",
      "Create a regular bot for the user with a unique stable ID, a display name, a routing specialty in the user's language and a soul. Defaults to your current harness/model and working directory, with no custom MCP servers. Report creation after a successful result.",
      CreateBotInput,
      CreateBotOutput,
    );
    register(
      "create_trigger",
      "Create a scheduled trigger for a configured Bot. Worker sessions may target their own Bot and coordinator sessions may target any configured Bot. Provide a stable id when you need to verify an uncertain result. Do not retry automatically after a timeout or connection error. Schedules support once, daily, cron, and interval rules.",
      CreateTriggerInput,
      CreateTriggerOutput,
    );
    register(
      "get_trigger",
      "Read one trigger by its stable ID. Use this after create_trigger returns an uncertain result. This tool never changes schedules or runs.",
      GetTriggerInput,
      GetTriggerOutput,
    );
    register(
      "list_triggers",
      "List at most 50 triggers, optionally filtered by Bot or enabled state. Results are ordered by most recently updated. This tool never changes schedules or runs.",
      ListTriggersInput,
      ListTriggersOutput,
    );
    register(
      "list_trigger_runs",
      "Read at most 50 recent runs for one trigger. Results are ordered by scheduled time. This tool never changes schedules or runs.",
      ListTriggerRunsInput,
      ListTriggerRunsOutput,
    );
    register(
      "update_trigger",
      "Update one trigger's name, prompt, schedule, enabled state, payload, or target Bot. Worker sessions may update only their own Bot's triggers. Use get_trigger to verify an uncertain result and do not retry automatically.",
      UpdateTriggerToolInput,
      UpdateTriggerOutput,
    );
    register(
      "mcp_info",
      "Inspect configured MCP servers, exact tool schemas, grants and Bot IDs. The primary assistant sees the registry; other Bots see only their own assignments. No credentials or connection parameters are returned. Use this to verify uncertain management results.",
      McpInfoInput,
      McpInfoOutput,
    );
    register(
      "mcp_server",
      "Manage MCP connections on the user's explicit request. Only the primary assistant may call this tool, in an ordinary or coordination task. Create/update require config; other actions require serverId; grant requires botId, enabled and exact allowedTools. Never widen access on your own. Use secret:/env: references only; ask the user to enter credentials and complete OAuth on the MCP page. Test before enable. New tools appear in a new task. Do not retry uncertain writes: inspect mcp_info first.",
      McpServerToolInput,
      McpServerToolOutput,
    );
    if (identity.role === "coordinator")
      register(
        "propose_route",
        "Propose one structured routing operation with a rationale. Chief validates and registers it; worker execution continues asynchronously. Do not retry an uncertain result automatically.",
        ProposeRouteInput,
        ProposeRouteOutput,
      );
    return server;
  }).pipe(
    Effect.catchAllDefect(() =>
      Effect.fail(
        new BridgeError({ code: "Unavailable", message: "Unable to construct the MCP server." }),
      ),
    ),
  );

export const serveMcpStdio = (
  client: SocketBridgeClient,
): Effect.Effect<void, BridgeError, Scope.Scope> =>
  Effect.gen(function* () {
    const server = yield* makeMcpServer(client);
    const transport = new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: BRIDGE_MAX_INPUT_BYTES,
    });
    yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          serveStdio(() => server, {
            transport,
            onerror: () => process.stderr.write("MCP transport error.\n"),
          }),
        catch: () =>
          new BridgeError({ code: "Unavailable", message: "Unable to start MCP stdio transport." }),
      }),
      (handle) =>
        Effect.tryPromise({ try: () => handle.close(), catch: () => undefined }).pipe(
          Effect.ignore,
        ),
    );
    yield* Effect.async<void>((resume) => {
      const finish = () => resume(Effect.void);
      process.stdin.once("end", finish);
      process.once("SIGTERM", finish);
      process.once("SIGINT", finish);
      return Effect.sync(() => {
        process.stdin.off("end", finish);
        process.off("SIGTERM", finish);
        process.off("SIGINT", finish);
      });
    });
  });
