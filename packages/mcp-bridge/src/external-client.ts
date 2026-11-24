import { type McpServerConfig, McpTool } from "@aut/protocol";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Data, Effect, Schema, type Scope } from "effect";

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
  Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => new Client({ name: "aut-mcp-supervisor", version: "0.0.0" })),
      (value) => Effect.promise(() => value.close().catch(() => undefined)),
    );
    yield* Effect.tryPromise({
      try: () => client.connect(transport(config)),
      catch: () =>
        new ExternalMcpError({
          code: "Connect",
          message: "The MCP server connection could not be established",
        }),
    }).pipe(
      Effect.timeoutFail({
        duration: "8 seconds",
        onTimeout: () =>
          new ExternalMcpError({ code: "Connect", message: "The MCP connection timed out" }),
      }),
    );
    return {
      listTools: () =>
        Effect.gen(function* () {
          const tools: McpTool[] = [];
          const cursors = new Set<string>();
          let cursor: string | undefined;
          do {
            const result = yield* Effect.tryPromise({
              try: () => client.listTools(cursor === undefined ? {} : { cursor }),
              catch: () =>
                new ExternalMcpError({
                  code: "Protocol",
                  message: "The MCP tool list could not be read",
                }),
            });
            const page = yield* Schema.decodeUnknown(Schema.Array(McpTool))(result.tools).pipe(
              Effect.mapError(
                () =>
                  new ExternalMcpError({
                    code: "Protocol",
                    message: "The MCP tool list is invalid",
                  }),
              ),
            );
            tools.push(...page);
            cursor = result.nextCursor;
            if (cursor !== undefined) {
              if (cursors.has(cursor))
                return yield* Effect.fail(
                  new ExternalMcpError({
                    code: "Protocol",
                    message: "The MCP tool list repeated its page cursor",
                  }),
                );
              cursors.add(cursor);
            }
          } while (cursor !== undefined);
          return tools;
        }).pipe(
          Effect.timeoutFail({
            duration: "8 seconds",
            onTimeout: () =>
              new ExternalMcpError({ code: "Protocol", message: "The MCP tool list timed out" }),
          }),
        ),
      callTool: (name: string, arguments_: Record<string, unknown>) =>
        Effect.tryPromise({
          try: (signal) => client.callTool({ name, arguments: arguments_ }, { signal }),
          catch: () =>
            new ExternalMcpError({
              code: "Call",
              message: "The MCP tool call could not be delivered",
            }),
        }),
    };
  });
