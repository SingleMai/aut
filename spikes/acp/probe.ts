/**
 * ACP stdio probe. It records the provider boundary without importing aut's
 * adapter. Run with Node 24's type stripping support.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

type JsonRecord = Record<string, unknown>;
type Scenario = "normal" | "permission" | "question" | "interrupt" | "resume" | "fork";
type Pending = { resolve: (message: JsonRecord) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

const scenario = (process.argv[2] ?? "normal") as Scenario;
const output = resolve(process.argv[3] ?? `spikes/acp/fixtures/${scenario}-opencode-1.19.5.jsonl`);
if (!(new Set<Scenario>(["normal", "permission", "question", "interrupt", "resume", "fork"])).has(scenario))
  throw new Error(`Unknown ACP scenario: ${scenario}`);
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, "", { flag: "wx" });

const record = (direction: string, payload: unknown): void =>
  appendFileSync(output, `${JSON.stringify({ at: new Date().toISOString(), direction, payload })}\n`);

const executable = process.env.AUT_ACP_BIN ?? "opencode";
const executableArgs = process.env.AUT_ACP_ARGS?.split(" ").filter(Boolean) ?? ["acp"];
const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
const cwd = mkdtempSync(join(tmpdir(), "aut-acp-probe-"));
const model = process.env.AUT_ACP_MODEL ?? "opencode/big-pickle";

type Client = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly send: (method: string, params: JsonRecord) => Promise<JsonRecord>;
  readonly waitFor: (predicate: (message: JsonRecord) => boolean, timeoutMs?: number) => Promise<JsonRecord>;
  readonly close: () => Promise<void>;
};

const start = (extraEnv: Record<string, string> = {}): Client => {
  const child = spawn(executable, executableArgs, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, Pending>();
  const waiters: Array<{ predicate: (message: JsonRecord) => boolean; resolve: (message: JsonRecord) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }> = [];
  let nextId = 0;
  let closed = false;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: JsonRecord;
    try {
      message = JSON.parse(line) as JsonRecord;
    } catch {
      record("invalid-stdout", line);
      return;
    }
    record("receive", message);
    const id = message.id;
    if ((typeof id === "number" || typeof id === "string") && pending.has(Number(id))) {
      const current = pending.get(Number(id))!;
      pending.delete(Number(id));
      clearTimeout(current.timer);
      current.resolve(message);
    }
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (!waiter.predicate(message)) continue;
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => record("stderr", chunk));
  child.on("close", (code, signal) => {
    record("exit", { code, signal });
    if (!closed) {
      const error = new Error(`ACP exited before a response (${code ?? signal ?? "unknown"})`);
      for (const current of pending.values()) current.reject(error);
      for (const waiter of waiters) waiter.reject(error);
      pending.clear();
      waiters.length = 0;
    }
  });
  const send = (method: string, params: JsonRecord): Promise<JsonRecord> => {
    const id = ++nextId;
    const message = { jsonrpc: "2.0", id, method, params };
    record("send", message);
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise((resolveResponse, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 120_000);
      pending.set(id, { resolve: resolveResponse, reject, timer });
    });
  };
  const waitFor = (predicate: (message: JsonRecord) => boolean, timeoutMs = 120_000): Promise<JsonRecord> =>
    new Promise((resolveWait, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${scenario}`)), timeoutMs);
      waiters.push({ predicate, resolve: resolveWait, reject, timer });
    });
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    child.kill("SIGTERM");
    await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
  };
  return { child, send, waitFor, close };
};

const initialize = async (client: Client): Promise<string> => {
  const result = await client.send("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "aut-acp-probe", version: "0.0.0" },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
  });
  if (result.error) throw new Error(`initialize failed: ${JSON.stringify(result.error)}`);
  const created = await client.send("session/new", { cwd, mcpServers: [] });
  const sessionId = ((created.result as JsonRecord | undefined)?.sessionId as string | undefined);
  if (!sessionId) throw new Error("session/new returned no sessionId");
  return sessionId;
};

const prompt = (client: Client, sessionId: string, text: string): Promise<JsonRecord> =>
  client.send("session/prompt", { sessionId, prompt: [{ type: "text", text }] });

const recordMeta = (): void => record("meta", { cli: executable, version, scenario, cwd, model });

const run = async (): Promise<void> => {
  recordMeta();
  if (scenario === "resume" || scenario === "fork") {
    const first = start();
    const original = await initialize(first);
    await prompt(first, original, "Reply with exactly ACP_PARENT_OK.");
    await first.close();
    const resumed = start();
    await resumed.send("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "aut-acp-probe", version: "0.0.0" },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const method = scenario === "fork" ? "session/fork" : "session/load";
    const opened = await resumed.send(method, {
      sessionId: original,
      cwd,
      mcpServers: [],
    });
    const sessionId = ((opened.result as JsonRecord | undefined)?.sessionId as string | undefined) ?? original;
    await prompt(resumed, sessionId, scenario === "fork" ? "Reply with exactly ACP_FORK_OK." : "Reply with exactly ACP_RESUME_OK.");
    record("probe", { assertion: scenario === "fork" ? "fork returned a new session" : "load resumed persisted session", original, sessionId });
    await resumed.close();
    return;
  }

  if (scenario === "permission") {
    const config = join(cwd, "opencode.json");
    writeFileSync(config, JSON.stringify({ permission: { bash: "ask" } }), { flag: "wx", mode: 0o600 });
  }
  const client = start();
  const sessionId = await initialize(client);
  if (scenario === "interrupt") {
    const turn = prompt(client, sessionId, "Run `sleep 10`, then reply with ACP_INTERRUPT_OK.");
    await delay(600);
    record("probe", { action: "session/cancel" });
    const message = { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } };
    record("send", message);
    client.child.stdin.write(`${JSON.stringify(message)}\n`);
    await turn;
  } else {
    const turn = prompt(
      client,
      sessionId,
      scenario === "permission"
        ? "Run `pwd`, then reply with ACP_PERMISSION_OK."
        : scenario === "question"
          ? "Ask the person the fixture questions, then reply with ACP_QUESTION_OK."
          : "Reply with exactly ACP_NORMAL_OK.",
    );
    if (scenario === "permission") {
      await client.waitFor((message) => message.method === "session/request_permission");
      const response = { jsonrpc: "2.0", id: 0, result: { outcome: { outcome: "selected", optionId: "once" } } };
      record("send", response);
      client.child.stdin.write(`${JSON.stringify(response)}\n`);
    } else if (scenario === "question") {
      await client.waitFor((message) => message.method === "_x.ai/ask_user_question");
      const response = {
        jsonrpc: "2.0",
        id: 21,
        result: {
          outcome: "accepted",
          answers: { "Which color?": ["Blue"], "Any note?": ["Other"] },
          annotations: { "Any note?": { notes: "ACP_QUESTION_NOTE" } },
        },
      };
      record("send", response);
      client.child.stdin.write(`${JSON.stringify(response)}\n`);
    }
    await turn;
  }
  record("probe", { assertion: `${scenario} result received`, sessionId });
  await client.close();
};

try {
  await run();
} catch (error) {
  record("probe-error", { message: error instanceof Error ? error.message : String(error) });
  throw error;
}
