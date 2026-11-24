import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { McpTool } from "@aut/protocol";
import { McpServer, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { Effect, Redacted, Schema, type Scope } from "effect";
import { BridgeError } from "./interface.js";
import { mcpSchema } from "./server.js";
import { BRIDGE_MAX_INPUT_BYTES } from "./socket.js";

export interface McpProxyCredentials {
  readonly socketPath: string;
  readonly token: Redacted.Redacted<string>;
  readonly serverId: string;
  readonly serverName: string;
  readonly tools: readonly McpTool[];
}

export const mcpProxyServerConfig = (
  credentials: McpProxyCredentials,
  entrypoint = fileURLToPath(new URL("./stdio.js", import.meta.url)),
): Extract<import("@aut/protocol").McpServerConfig, { readonly transport: "stdio" }> => ({
  name: credentials.serverName,
  transport: "stdio",
  command: process.execPath,
  args: [entrypoint],
  env: {
    AUT_MCP_MODE: "proxy",
    AUT_MCP_PROXY_SOCKET: credentials.socketPath,
    AUT_MCP_PROXY_TOKEN: Redacted.value(credentials.token),
    AUT_MCP_PROXY_SERVER: credentials.serverId,
    AUT_MCP_PROXY_NAME: credentials.serverName,
    AUT_MCP_PROXY_TOOLS: JSON.stringify(credentials.tools),
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  },
});

const ProxyCallOutput = Schema.Unknown;

const callSupervisor = (
  socketPath: string,
  token: string,
  body: unknown,
): Effect.Effect<unknown, BridgeError> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<unknown>((resolve, reject) => {
        const request = httpRequest(
          {
            socketPath,
            path: "/call",
            method: "POST",
            signal,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.once("error", reject);
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.once("end", () => {
              try {
                const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
                if ((response.statusCode ?? 500) >= 400) reject(new Error(JSON.stringify(value)));
                else resolve(value);
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        request.once("error", reject);
        request.end(JSON.stringify(body));
      }),
    catch: () => new BridgeError({ code: "Unavailable", message: "The MCP proxy call failed." }),
  }).pipe(
    Effect.timeoutFail({
      duration: "70 seconds",
      onTimeout: () =>
        new BridgeError({
          code: "Unavailable",
          message: "The MCP proxy call timed out. Check the result before retrying.",
        }),
    }),
  );

const proxyInput = mcpSchema(Schema.Record({ key: Schema.String, value: Schema.Unknown }));
// Upstream owns JSON Schema validation. Keep its complete discovery schema, including
// nested definitions, while validating the transport envelope at this SDK boundary.
const toolSchema = (json: unknown): StandardSchemaWithJSON<Record<string, unknown>> => ({
  "~standard": {
    ...proxyInput["~standard"],
    jsonSchema: {
      input: () => json as Record<string, unknown>,
      output: () => json as Record<string, unknown>,
    },
  },
});

const makeProxyServer = (credentials: McpProxyCredentials) => {
  const server = new McpServer(
    { name: credentials.serverName, version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  // The upstream SDK's callback union includes elicitation-only result variants. Proxy callbacks
  // always return a normal tool result, so keep this cast at the SDK boundary.
  const registerTool = server.registerTool.bind(server) as unknown as (
    name: string,
    config: object,
    callback: (arguments_: Record<string, unknown>) => Promise<unknown>,
  ) => unknown;
  for (const tool of credentials.tools) {
    registerTool(
      tool.name,
      {
        ...(tool.description === undefined ? {} : { description: tool.description }),
        ...(tool.title === undefined ? {} : { title: tool.title }),
        inputSchema: toolSchema(tool.inputSchema ?? { type: "object", properties: {} }),
        ...(tool.outputSchema === undefined ? {} : { outputSchema: toolSchema(tool.outputSchema) }),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      },
      (arguments_) =>
        Effect.runPromise(
          callSupervisor(credentials.socketPath, Redacted.value(credentials.token), {
            serverId: credentials.serverId,
            tool: tool.name,
            arguments: arguments_,
          }).pipe(
            Effect.flatMap((value) => Schema.decodeUnknown(ProxyCallOutput)(value)),
            Effect.map((value) => {
              if (
                typeof value === "object" &&
                value !== null &&
                "content" in value &&
                Array.isArray((value as { content?: unknown }).content)
              )
                return value;
              return {
                content: [{ type: "text" as const, text: JSON.stringify(value) }],
              };
            }),
            Effect.catchAll((error) =>
              Effect.succeed({
                content: [{ type: "text" as const, text: error.message }],
                isError: true,
              }),
            ),
          ),
        ),
    );
  }
  return server;
};

export const serveMcpProxy = (
  credentials: McpProxyCredentials,
): Effect.Effect<void, BridgeError, Scope.Scope> =>
  Effect.gen(function* () {
    const server = makeProxyServer(credentials);
    const transport = new StdioServerTransport(process.stdin, process.stdout, {
      maxBufferSize: BRIDGE_MAX_INPUT_BYTES,
    });
    yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          serveStdio(() => server, {
            transport,
            onerror: () => process.stderr.write("MCP proxy transport error.\n"),
          }),
        catch: () =>
          new BridgeError({ code: "Unavailable", message: "Unable to start the MCP proxy." }),
      }),
      (value) => Effect.promise(() => value.close().catch(() => undefined)),
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

export const parseProxyCredentials = (env: NodeJS.ProcessEnv) => {
  const socketPath = env.AUT_MCP_PROXY_SOCKET;
  const token = env.AUT_MCP_PROXY_TOKEN;
  const serverId = env.AUT_MCP_PROXY_SERVER;
  const serverName = env.AUT_MCP_PROXY_NAME;
  const rawTools = env.AUT_MCP_PROXY_TOOLS;
  if (!socketPath || !token || !serverId || !serverName || !rawTools)
    return Effect.fail(
      new BridgeError({ code: "Unauthorized", message: "MCP proxy credentials are missing." }),
    );
  return Effect.try({
    try: () => {
      const tools = JSON.parse(rawTools) as unknown;
      return {
        socketPath,
        token: Redacted.make(token),
        serverId,
        serverName,
        tools: Schema.decodeUnknownSync(Schema.Array(McpTool))(tools),
      } satisfies McpProxyCredentials;
    },
    catch: () => new BridgeError({ code: "InvalidInput", message: "MCP proxy tools are invalid." }),
  });
};
