// MCP stdio question and permission proxy adapted from OpenMausBot (Apache-2.0),
// server/permission-proxy.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// stdout is the MCP channel. Diagnostics belong on stderr.

import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";

type BrokerAnswer = {
  readonly behavior?: "allow" | "deny" | "answer";
  readonly message?: string;
};

const socketPath = process.argv[2] ?? "";
const pending = new Map<
  string,
  { readonly connection: Socket; readonly resolve: (value: BrokerAnswer) => void }
>();
let connection: Socket | null = null;
let connecting: Promise<Socket | null> | null = null;

const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

const open = (): Promise<Socket | null> =>
  new Promise((resolve) => {
    if (!socketPath) {
      resolve(null);
      return;
    }
    const candidate = connect(socketPath);
    candidate.setEncoding("utf8");
    let connected = false;
    let buffer = "";
    candidate.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const message = value as { readonly t?: unknown; readonly id?: unknown };
        if (message.t !== "answer") continue;
        const id = String(message.id ?? "");
        const waiter = pending.get(id);
        if (!waiter || waiter.connection !== candidate) continue;
        pending.delete(id);
        waiter.resolve(value as BrokerAnswer);
      }
    });
    candidate.once("connect", () => {
      connected = true;
      resolve(candidate);
    });
    candidate.on("error", () => undefined);
    candidate.once("close", () => {
      if (!connected) resolve(null);
      if (connection === candidate) connection = null;
      for (const [id, waiter] of pending) {
        if (waiter.connection !== candidate) continue;
        pending.delete(id);
        waiter.resolve({ behavior: "deny", message: "aut question service is unavailable" });
      }
    });
  });

const brokerConnection = (): Promise<Socket | null> => {
  if (connection && !connection.destroyed) return Promise.resolve(connection);
  connecting ??= open()
    .then((value) => {
      connection = value;
      return value;
    })
    .finally(() => {
      connecting = null;
    });
  return connecting;
};

const ask = async (
  kind: "question" | "permission",
  input: Record<string, unknown>,
): Promise<BrokerAnswer> => {
  const broker = await brokerConnection();
  if (!broker || broker.destroyed)
    return { behavior: "deny", message: "aut question service is unavailable" };
  const id = randomUUID();
  return new Promise((resolve) => {
    pending.set(id, { connection: broker, resolve });
    broker.write(
      `${JSON.stringify({
        t: "ask",
        id,
        kind,
        tool: kind === "question" ? "ask_user" : "approve",
        input,
      })}\n`,
      (error) => {
        if (!error || pending.get(id)?.connection !== broker) return;
        pending.delete(id);
        resolve({ behavior: "deny", message: "aut question service is unavailable" });
      },
    );
  });
};

const questionTool = {
  name: "ask_user",
  description: "Ask the human who owns this aut task for a decision or missing information.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string" },
      choices: { type: "array", items: { type: "string" } },
      multiSelect: { type: "boolean" },
    },
    required: ["question"],
  },
};

const approvalTool = {
  name: "approve",
  description: "Ask aut to approve a tool invocation.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
    required: ["tool_name", "input"],
  },
};

const reply = (id: unknown, text: string, isError = false) =>
  send({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
  });

const handle = async (value: unknown): Promise<void> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const message = value as {
    readonly id?: unknown;
    readonly method?: unknown;
    readonly params?: { readonly name?: unknown; readonly arguments?: unknown };
  };
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "aut-claude-question-proxy", version: "0.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [questionTool, approvalTool] } });
    return;
  }
  if (message.method !== "tools/call") return;
  const name = message.params?.name;
  const input = message.params?.arguments;
  if (
    typeof name !== "string" ||
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    reply(message.id, "aut question proxy received an invalid tool call", true);
    return;
  }
  if (name !== "ask_user" && name !== "approve") {
    reply(message.id, `aut question proxy does not provide ${name}`, true);
    return;
  }
  const outcome = await ask(
    name === "ask_user" ? "question" : "permission",
    input as Record<string, unknown>,
  );
  if (name === "ask_user") {
    if (outcome.behavior !== "answer")
      reply(message.id, outcome.message ?? "The question was not answered", true);
    else reply(message.id, outcome.message ?? "");
    return;
  }
  if (outcome.behavior === "allow") reply(message.id, "Allowed");
  else reply(message.id, outcome.message ?? "The action was denied", true);
};

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (!line.trim()) continue;
    void handle(JSON.parse(line)).catch((error: unknown) => {
      process.stderr.write(`aut claude question proxy error: ${String(error)}\n`);
    });
  }
});
void brokerConnection();
