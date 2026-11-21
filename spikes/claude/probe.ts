/**
 * Standalone Claude Code stream-json probe.
 *
 * This file records the raw process boundary only. It deliberately does not
 * import the production adapter, so a protocol change cannot be hidden by the
 * adapter itself. Prompts are synthetic and use a temporary working directory.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, type Socket } from "node:net";

type JsonRecord = Record<string, unknown>;
type Scenario = "normal" | "question" | "steer" | "interrupt" | "resume" | "fork";

const scenario = (process.argv[2] ?? "normal") as Scenario;
const supported = new Set<Scenario>(["normal", "question", "steer", "interrupt", "resume", "fork"]);
if (!supported.has(scenario)) throw new Error(`Unknown Claude probe scenario: ${scenario}`);

const output = resolve(process.argv[3] ?? `spikes/claude/fixtures/${scenario}-2.1.325.jsonl`);
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, "", { flag: "wx" });
const record = (direction: string, payload: unknown) =>
  appendFileSync(output, `${JSON.stringify({ at: new Date().toISOString(), direction, payload })}\n`);

const executable = process.env.AUT_CLAUDE_BIN ?? "claude";
const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
const cwd = mkdtempSync(join(tmpdir(), "aut-claude-probe-"));
const model = process.env.AUT_CLAUDE_MODEL ?? "claude-haiku-4-5";
const systemPrompt =
  "You are a protocol probe. Follow the user's exact token instruction. Do not access files or network.";

type ClaudeProcess = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly waitFor: (predicate: (frame: JsonRecord) => boolean, timeoutMs?: number) => Promise<JsonRecord>;
  readonly send: (frame: JsonRecord) => void;
  readonly close: () => Promise<void>;
  readonly sessionId: () => string | undefined;
};

const startProcess = (extraArgs: readonly string[] = [], env: Record<string, string> = {}): ClaudeProcess => {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--allow-dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "--strict-mcp-config",
    "--system-prompt",
    systemPrompt,
    "--model",
    model,
    ...extraArgs,
  ];
  record("meta", { cli: "claude", version, scenario, args, cwd, startedAt: new Date().toISOString() });
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending: Array<{ predicate: (frame: JsonRecord) => boolean; resolve: (frame: JsonRecord) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  let processError: Error | undefined;
  let session: string | undefined;
  const fail = (error: Error) => {
    processError = error;
    while (pending.length) pending.shift()!.reject(error);
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let frame: JsonRecord;
    try {
      frame = JSON.parse(line) as JsonRecord;
    } catch {
      record("invalid-stdout", line);
      return;
    }
    record("receive", frame);
    if (frame.type === "system" && frame.subtype === "init" && typeof frame.session_id === "string") {
      session = frame.session_id;
    }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const waiter = pending[index]!;
      if (!waiter.predicate(frame)) continue;
      pending.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => record("stderr", chunk));
  child.on("error", (error) => fail(error));
  child.on("close", (code, signal) => {
    record("exit", { code, signal });
    if (pending.length) fail(new Error(`Claude exited before probe predicate (${code ?? signal ?? "unknown"})`));
  });
  const send = (frame: JsonRecord) => {
    record("send", frame);
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  };
  const waitFor = (predicate: (frame: JsonRecord) => boolean, timeoutMs = 90_000): Promise<JsonRecord> => {
    if (processError) return Promise.reject(processError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = pending.findIndex((item) => item.timer === timer);
        if (index >= 0) pending.splice(index, 1);
        reject(new Error(`Timed out waiting for Claude frame in ${scenario}`));
      }, timeoutMs);
      pending.push({ predicate, resolve, reject, timer });
    });
  };
  const close = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
  };
  return { child, waitFor, send, close, sessionId: () => session };
};

const sendUser = (process: ClaudeProcess, text: string, uuid?: string) =>
  process.send({ type: "user", ...(uuid ? { uuid } : {}), message: { role: "user", content: text } });

const waitResult = (process: ClaudeProcess) =>
  process.waitFor((frame) => frame.type === "result");

const runBasic = async () => {
  const process = startProcess();
  sendUser(process, "Reply with the exact token AUT_CLAUDE_PROBE_OK and nothing else.");
  await waitResult(process);
  const sessionId = process.sessionId();
  record("probe", { assertion: "normal result received", sessionId });
  await process.close();
  return sessionId;
};

const runQuestion = async () => {
  const socketPath = join(cwd, "question.sock");
  const server = createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message: JsonRecord;
        try {
          message = JSON.parse(line) as JsonRecord;
        } catch {
          continue;
        }
        record("question-broker", message);
        if (message.t === "ask" && typeof message.id === "string") {
          socket.write(`${JSON.stringify({ t: "answer", id: message.id, behavior: "answer", message: "AUT_CLAUDE_PROBE_ANSWER" })}\n`);
        }
      }
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolveListen);
  });
  const proxy = resolve("packages/adapters/dist/claude/question-proxy.js");
  const configPath = join(cwd, "mcp.json");
  writeFileSync(configPath, JSON.stringify({
    mcpServers: {
      "aut-questions": { command: process.execPath, args: [proxy, socketPath] },
    },
  }), { mode: 0o600, flag: "wx" });
  const sessionProcess = startProcess(["--mcp-config", configPath, "--allowedTools", "mcp__aut-questions__ask_user"]);
  sendUser(sessionProcess, "Call the aut-questions ask_user tool with the question 'Return the probe answer'. Then reply with the exact token AUT_CLAUDE_QUESTION_DONE and nothing else.");
  await waitResult(sessionProcess);
  record("probe", { assertion: "question broker request and result received" });
  await sessionProcess.close();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
};

const runSteer = async () => {
  const process = startProcess();
  sendUser(process, "Use Bash to run `sleep 3`, then reply with AUT_CLAUDE_STEER_ORIGINAL.");
  await delay(500);
  sendUser(process, "After the current work, reply with AUT_CLAUDE_STEERED.", `probe-steer-${Date.now()}`);
  await waitResult(process);
  record("probe", { assertion: "steer message was accepted" });
  await process.close();
};

const runInterrupt = async () => {
  const process = startProcess();
  sendUser(process, "Use Bash to run `sleep 10`, then reply with AUT_CLAUDE_INTERRUPT_ORIGINAL.");
  await delay(700);
  record("probe", { action: "SIGINT" });
  process.child.kill("SIGINT");
  await process.close();
};

const runResumeOrFork = async (fork: boolean) => {
  const sessionId = await runBasic();
  if (!sessionId) throw new Error("Claude did not publish a session id");
  const extra = ["--resume", sessionId, ...(fork ? ["--fork-session", "--no-session-persistence"] : [])];
  const process = startProcess(extra);
  sendUser(process, fork ? "Reply with AUT_CLAUDE_FORK_OK." : "Reply with AUT_CLAUDE_RESUME_OK.");
  await waitResult(process);
  record("probe", { assertion: fork ? "fork result received" : "resume result received", sessionId });
  await process.close();
};

try {
  if (scenario === "normal") await runBasic();
  else if (scenario === "question") await runQuestion();
  else if (scenario === "steer") await runSteer();
  else if (scenario === "interrupt") await runInterrupt();
  else if (scenario === "resume") await runResumeOrFork(false);
  else await runResumeOrFork(true);
} catch (error) {
  record("probe-error", { message: error instanceof Error ? error.message : String(error) });
  throw error;
}
