/** Standalone native-memory control probe; no production adapter code is imported. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

type Rpc = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
const executable = process.env.AUT_CODEX_BIN ?? "codex";
const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
const root = mkdtempSync(join(tmpdir(), "aut-codex-native-memory-"));
const cwd = join(root, "project");
const sqliteRoot = join(root, "sqlite");
mkdirSync(cwd);
mkdirSync(sqliteRoot);
const output = resolve(process.argv[2] ?? join(root, "result.json"));
if (existsSync(output)) throw new Error("Refusing to overwrite an existing result");
const args = ["app-server", "--stdio", "--strict-config", "--disable", "memories",
  "-c", "memories.use_memories=false", "-c", "memories.generate_memories=false",
  "-c", `sqlite_home=${JSON.stringify(sqliteRoot)}`, "-c", `log_dir=${JSON.stringify(join(root, "logs"))}`];
const child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
const evidence: any[] = [];
const completedTurns = new Map<string, { status: string }>();
let modelTurnsStarted = 0;
let toolItems = 0;
let serial = 0;
let failure: Error | undefined;
let stderrBytes = 0;
let codexHome: string | undefined;
let initialConfigHash: string | undefined;
const configHash = (path: string) => existsSync(path)
  ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
const fail = (error: Error) => {
  failure = error;
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
  pending.clear();
};
const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
  if (failure) { reject(failure); return; }
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 45_000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
});
createInterface({ input: child.stdout }).on("line", (line) => {
  let message: Rpc;
  try { message = JSON.parse(line); } catch { fail(new Error("Invalid app-server JSON")); return; }
  if (message.method === "turn/completed") completedTurns.set(message.params.turn.id, { status: message.params.turn.status });
  if (message.method === "item/started" && !["userMessage", "agentMessage", "reasoning"].includes(message.params.item.type)) toolItems++;
  if (message.id !== undefined && message.method) {
    // No question, permission, or external tool request receives a fabricated answer.
    fail(new Error(`Unexpected server request: ${message.method}`));
  } else if (typeof message.id === "number") {
    const p = pending.get(message.id);
    pending.delete(message.id);
    if (p) clearTimeout(p.timer);
    if (message.error) p?.reject(new Error(`RPC error ${message.error.code}: ${message.error.message}`));
    else p?.resolve(message.result);
  }
});
child.stderr.on("data", (data: Buffer) => { stderrBytes += data.length; });
child.on("error", fail);
child.stdin.on("error", fail);
child.on("exit", (code, signal) => fail(new Error(`App-server exited: ${code}/${signal}`)));

// Inspect only this probe's IDs in its isolated state database. Never export raw configuration/history.
const readMode = (id: string): string | null => {
  const name = readdirSync(sqliteRoot).find((name) => /^state_.*\.sqlite$/.test(name));
  if (!name) return null;
  const db = new DatabaseSync(join(sqliteRoot, name), { readOnly: true });
  try {
    return (db.prepare("SELECT memory_mode FROM threads WHERE id = ?").get(id) as { memory_mode: string } | undefined)?.memory_mode ?? null;
  } finally { db.close(); }
};
const waitMode = async (id: string, expected: string) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const mode = readMode(id);
    if (mode === expected) return mode;
    await delay(100);
  }
  assert.equal(readMode(id), expected, "Persisted thread memory mode");
  return expected;
};
const access = { cwd, approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" };
let passed = false;
let errorMessage: string | undefined;
try {
  const init = await rpc("initialize", {
    clientInfo: { name: "aut-native-memory-probe", title: "aut memory controls probe", version: "0.0.1" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  codexHome = init.codexHome;
  if (codexHome) initialConfigHash = configHash(join(codexHome, "config.toml"));
  const config = (await rpc("config/read", { cwd, includeLayers: false })).config;
  const memoryConfig = { feature: config.features?.memories, useMemories: config.memories?.use_memories, generateMemories: config.memories?.generate_memories };
  evidence.push({ check: "strict_config_and_effective_values", ...memoryConfig });
  assert.deepEqual(memoryConfig, { feature: false, useMemories: false, generateMemories: false });
  const disabledMcp = Object.fromEntries(Object.keys(config.mcp_servers ?? {}).map((name) => [`mcp_servers.${name}.enabled`, false]));
  const started = await rpc("thread/start", { ...access, config: disabledMcp,
    developerInstructions: "Synthetic memory configuration probe. Do not call any tool or external service." });
  const turn = await rpc("turn/start", { threadId: started.thread.id,
    input: [{ type: "text", text: "Synthetic configuration test. Do not call tools, access files, delegate or ask questions. Reply exactly AUT_MEMORY_CONTROL_OK.", text_elements: [] }],
    approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } });
  modelTurnsStarted++;
  for (let attempt = 0; attempt < 900 && !completedTurns.has(turn.turn.id); attempt++) {
    if (failure) throw failure;
    await delay(100);
  }
  assert.equal(completedTurns.get(turn.turn.id)?.status, "completed", "Synthetic turn completed");
  assert.equal(toolItems, 0, "No tool calls in the synthetic turn");
  evidence.push({ check: "synthetic_turn", status: "completed", toolItems, model: started.model });
  evidence.push({ check: "new_thread", id: started.thread.id, mode: await waitMode(started.thread.id, "disabled") });

  // Simulate an older eligible thread, then prove that resume alone does not clear its persisted flag.
  const enableResult = await rpc("thread/memoryMode/set", { threadId: started.thread.id, mode: "enabled" });
  evidence.push({ check: "set_enabled_on_synthetic_thread", response: enableResult, mode: await waitMode(started.thread.id, "enabled") });
  const resumed = await rpc("thread/resume", { ...access, threadId: started.thread.id, config: disabledMcp });
  assert.equal(resumed.thread.id, started.thread.id);
  assert.equal(readMode(started.thread.id), "enabled", "Resume does not clear existing eligibility");
  evidence.push({ check: "resume_existing_thread", sameId: resumed.thread.id === started.thread.id, mode: readMode(started.thread.id) });
  const disableResult = await rpc("thread/memoryMode/set", { threadId: started.thread.id, mode: "disabled" });
  evidence.push({ check: "set_disabled_on_synthetic_thread", response: disableResult, mode: await waitMode(started.thread.id, "disabled") });
  const forked = await rpc("thread/fork", { ...access, threadId: started.thread.id, config: disabledMcp });
  evidence.push({ check: "fork", id: forked.thread.id, mode: await waitMode(forked.thread.id, "disabled") });
  passed = true;
} catch (error) {
  errorMessage = error instanceof Error ? error.message : String(error);
} finally {
  child.kill("SIGTERM");
  for (let attempt = 0; attempt < 30 && child.exitCode === null && child.signalCode === null; attempt++) await delay(100);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const p of pending.values()) clearTimeout(p.timer);
  const result = {
    cli: "codex", version, recordedAt: new Date().toISOString(), passed,
    scope: "Real app-server configuration, one synthetic no-tool turn, and thread metadata; no memory consolidation run",
    projection: "Only memory configuration fields, synthetic IDs and native responses are retained",
    invocation: ["app-server", "--stdio", "--strict-config", "--disable", "memories", "-c", "memories.use_memories=false", "-c", "memories.generate_memories=false", "-c", "sqlite_home=<temporary-directory>", "-c", "log_dir=<temporary-directory>"],
    providerConfigurationChanged: false,
    userConfigUnchanged: codexHome ? configHash(join(codexHome, "config.toml")) === initialConfigHash : null,
    existingUserMemoriesTouched: false, isolatedStateDatabase: true, modelTurnsStarted,
    childExited: child.exitCode !== null || child.signalCode !== null, stderrBytes, evidence,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output, passed, evidence, ...(errorMessage ? { error: errorMessage } : {}) }));
  if (!passed) process.exitCode = 1;
}
