// Read-only adapter acceptance. Reuses recorded native thread IDs; never resumes or starts a turn.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeCodexAdapter } from "../../packages/adapters/dist/index.js";
import { NodeTransport } from "../../packages/adapters/dist/codex/transport.js";
import { Effect } from "effect";

const methods: string[] = [];
const childPids = new Set<number>();
const adapter = makeCodexAdapter({}, { open: (options) => NodeTransport.open(options).pipe(Effect.map((transport) => {
  for (const value of execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).trim().split("\n")) if (value) childPids.add(Number(value));
  return { ...transport, request: (method, params) => { methods.push(method); return transport.request(method, params); } };
})) });
const runs = [];
for (const name of ["session-view", "session-mcp"]) {
  const override = name === "session-view" ? process.env.AUT_HISTORY_VIEW_FIXTURE : process.env.AUT_HISTORY_MCP_FIXTURE;
  const rows = readFileSync(override ? resolve(override) : new URL(`fixtures/${name}-0.169.0.jsonl`, import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const threadId = rows.find((row) => row.direction === "probe" && typeof row.payload.threadId === "string")?.payload.threadId;
  if (!threadId || !adapter.readSession) throw new Error("Missing native history fixture or adapter capability");
  const history = await Effect.runPromise(Effect.scoped(adapter.readSession({ kind: "codex", data: { threadId } })));
  if (history.turns.length !== 1 || history.turns[0]?.status !== "completed") throw new Error("Unexpected historical turn");
  const tools = history.turns[0].items.filter((item) => item.kind === "tool");
  const expected = name === "session-view" ? ["fileChange", "commandExecution"] : ["aut_session_view.fixture_echo"];
  if (JSON.stringify(tools.map((item) => item.tool?.name)) !== JSON.stringify(expected)) throw new Error("Missing native tool history");
  runs.push({ name, threadId, history });
}
const alive = [...childPids].filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
if (alive.length) throw new Error("Scoped native reader process is still alive");
if (methods.some((method) => !["initialize", "thread/read"].includes(method))) throw new Error("Read-only adapter made a mutating native request");
const output = process.env.AUT_HISTORY_READ_RESULT;
if (!output) throw new Error("Set AUT_HISTORY_READ_RESULT to a new result file path");
writeFileSync(output, `${JSON.stringify({ at: new Date().toISOString(), cliVersion: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(), methods, childPids: [...childPids], alive, runs }, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ output, methods, childPids: [...childPids], alive }));
