import type { McpServerConfig, McpTool } from "@aut/protocol";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Data, Effect, type Scope } from "effect";

export class ExternalMcpError extends Data.TaggedError("ExternalMcpError")<{
  readonly code: "Connect" | "Protocol" | "Call";
  readonly message: string;
  readonly detail?: string;
}> {}

export interface ExternalMcpConnection {
  readonly listTools: () => Effect.Effect<ReadonlyArray<McpTool>, ExternalMcpError>;
  readonly callTool: (
    name: string,
    arguments_: Record<string, unknown>,
  ) => Effect.Effect<unknown, ExternalMcpError>;
}

const tool = (value: unknown): McpTool | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const row = value as { name?: unknown; description?: unknown; inputSchema?: unknown };
  if (typeof row.name !== "string" || row.name.length === 0) return undefined;
  return {
    name: row.name,
    ...(typeof row.description === "string" ? { description: row.description } : {}),
    ...(row.inputSchema === undefined
      ? {}
      : { inputSchema: row.inputSchema as Exclude<McpTool["inputSchema"], undefined> }),
  };
};

const transport = (config: McpServerConfig) => {
  if (config.transport === "stdio")
    return new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      ...(config.env === undefined ? {} : { env: { ...config.env } }),
      stderr: "pipe",
    });
  const url = new URL(config.url);
  const requestInit = config.headers === undefined ? undefined : { headers: config.headers };
  return config.transport === "sse"
    ? new SSEClientTransport(url, requestInit === undefined ? undefined : { requestInit })
    : new StreamableHTTPClientTransport(
        url,
        requestInit === undefined ? undefined : { requestInit },
      );
};

export const connectExternalMcp = (
  config: McpServerConfig,
): Effect.Effect<ExternalMcpConnection, ExternalMcpError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const client = new Client({ name: "aut-mcp-supervisor", version: "0.0.0" });
        await client.connect(transport(config));
        return client;
      },
      catch: (error) =>
        new ExternalMcpError({
          code: "Connect",
          message: "The MCP server connection could not be established",
          detail: String(error),
        }),
    }),
    (client) => Effect.promise(() => client.close().catch(() => undefined)),
  ).pipe(
    Effect.map((client) => ({
      listTools: () =>
        Effect.tryPromise({
          try: async () => {
            const result = await client.listTools();
            return result.tools.map(tool).filter((value): value is McpTool => value !== undefined);
          },
          catch: (error) =>
            new ExternalMcpError({
              code: "Protocol",
              message: "The MCP server tool list could not be read",
              detail: String(error),
            }),
        }),
      callTool: (name, arguments_) =>
        Effect.tryPromise({
          try: () => client.callTool({ name, arguments: arguments_ }),
          catch: (error) =>
            new ExternalMcpError({
              code: "Call",
              message: "The MCP tool call could not be delivered",
              detail: String(error),
            }),
        }),
    })),
  );
