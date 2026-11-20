import { fileURLToPath } from "node:url";
import type { McpServerConfig } from "@aut/protocol";
import { Redacted } from "effect";
import type { BridgeCredentials } from "./socket.js";

/** Ephemeral session configuration. Never persist the credential in bots.json or decision logs. */
export const mcpServerConfig = (
  credentials: BridgeCredentials,
  entrypoint = fileURLToPath(new URL("./stdio.js", import.meta.url)),
): Extract<McpServerConfig, { readonly transport: "stdio" }> => ({
  name: "aut",
  transport: "stdio",
  command: process.execPath,
  args: [entrypoint],
  env: {
    AUT_MCP_SOCKET: credentials.socketPath,
    AUT_MCP_TOKEN: Redacted.value(credentials.token),
    ...("electron" in process.versions ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
  },
});
