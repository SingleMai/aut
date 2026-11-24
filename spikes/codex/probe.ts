/** Standalone transport probe. No production adapter code is imported. */
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";

type Rpc = { id?: number | string; method?: string; params?: any; result?: any; error?: any };
const scenario = process.argv[2] ?? "normal";
const supportedScenarios = ["normal", "resume-persisted", "default", "default-enabled", "default-delayed", "plan", "plan-free", "async", "async-enabled", "async-delayed", "session-view", "session-mcp", "session-read", "session-context"];
if (!supportedScenarios.includes(scenario)) throw new Error(`Unknown probe scenario: ${scenario}`);
const output = resolve(process.argv[3] ?? `spikes/codex/fixtures/${scenario}.jsonl`);
const executable = process.env.AUT_CODEX_BIN ?? "codex";
const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
const cwd = mkdtempSync(join(tmpdir(), "aut-codex-probe-"));
mkdirSync(resolve(output, ".."), { recursive: true });
writeFileSync(output, "", { flag: "wx" });
const record = (direction: string, payload: unknown) =>
  appendFileSync(output, JSON.stringify({ at: new Date().toISOString(), direction, payload }) + "\n");
const args = ["app-server", "--stdio"];
// Process-local override for an isolated synthetic thread; never change user configuration.
if (scenario === "session-context") args.push("-c", "model_auto_compact_token_limit=2000");
if (["default-enabled", "default-delayed"].includes(scenario)) args.push("--enable", "default_mode_request_user_input");
if (scenario === "async-enabled") args.push("--enable", "send_message_to_user_async");
if (scenario === "session-mcp") {
  const serverPath = join(cwd, "fixture-mcp.cjs");
  writeFileSync(serverPath, `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'aut-session-view-fixture',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'fixture_echo',description:'Return the explicit synthetic fixture text. Local test only.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};if(m.method==='tools/call')result={content:[{type:'text',text:'MCP_FIXTURE:'+m.params.arguments.text}],structuredContent:{echo:m.params.arguments.text},isError:false};if(m.method==='resources/list')result={resources:[]};if(m.method==='resources/templates/list')result={resourceTemplates:[]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`, { flag: "wx" });
  args.push("-c", `mcp_servers.aut_session_view={command=${JSON.stringify(process.execPath)},args=[${JSON.stringify(serverPath)}]}`);
}
record("meta", { cli: "codex", version, scenario, args, cwd, startedAt: new Date().toISOString() });
const child = spawn(executable, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
const received: Rpc[] = [];
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let processError: Error | undefined;
const failPending = (error: Error) => {
  processError = error;
  for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
  pending.clear();
};
let serial = 0;
let threadId = "";
let activeTurnId = "";
const send = (message: Rpc) => {
  record("send", message);
  child.stdin.write(JSON.stringify(message) + "\n");
};
const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
  if (processError) { reject(processError); return; }
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timed out: ${method}`)); }, 90_000);
  pending.set(id, { resolve, reject, timer });
  send({ id, method, params });
});
createInterface({ input: child.stdout }).on("line", (line) => {
  let message: Rpc;
  try { message = JSON.parse(line); } catch { record("invalid-stdout", line); failPending(new Error("Invalid protocol JSON")); return; }
  record("receive", message);
  received.push(message);
  if (message.method === "turn/started" && message.params.threadId === threadId) activeTurnId = message.params.turn.id;
  if (typeof message.id === "number" && !message.method) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (waiter) clearTimeout(waiter.timer);
    if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
    else waiter?.resolve(message.result);
  }
  if (message.method === "item/tool/requestUserInput") {
    // Only this synthetic test scenario receives a preset fixture answer.
    const questions = message.params.questions;
    const allowed = message.params.threadId === threadId && message.params.turnId === activeTurnId && ["default", "default-enabled", "default-delayed", "plan", "plan-free"].includes(scenario)
      && Array.isArray(questions) && questions.length === 2
      && questions[0].id === "probe_color" && questions[0].question === "Which fixture color?"
      && JSON.stringify(questions[0].options?.map((option: any) => option.label)) === JSON.stringify(["Blue", "Red"])
      && questions[1].id === "probe_shape" && questions[1].question === "Which fixture shape?"
      && JSON.stringify(questions[1].options?.map((option: any) => option.label)) === JSON.stringify(["Circle", "Square"]);
    if (!allowed) {
      record("probe", { unexpectedQuestion: true, requestId: message.id });
      failPending(new Error("Unexpected question; no synthetic answer was sent"));
      return;
    }
    const answer = () => send({ id: message.id, result: { answers: Object.fromEntries(questions.map((question: any) => [question.id, { answers: [question.id === "probe_color" ? (scenario === "plan-free" ? "Teal fixture text" : "Blue") : "Circle"] }])) } });
    if (["plan-free", "default-delayed"].includes(scenario)) {
      record("probe", { holdingQuestion: message.id, durationMs: 5_000 });
      void delay(5_000).then(() => { if (!processError) { record("probe", { processAliveDuringQuestion: child.exitCode === null, requestId: message.id }); answer(); } });
    } else answer();
  } else if (message.method && message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: "Probe does not handle this server request" } });
  }
});
child.stderr.on("data", (data: Buffer) => record("stderr", data.toString()));
child.on("error", failPending);
child.stdin.on("error", failPending);
child.on("exit", (code, signal) => { record("exit", { code, signal }); failPending(new Error(`App server exited: ${code}/${signal}`)); });
const waitFor = async (predicate: (message: Rpc) => boolean, after = 0) => {
  for (let i = 0; i < 900; i++) {
    if (processError) throw processError;
    const found = received.slice(after).find(predicate);
    if (found) return found;
    await delay(100);
  }
  throw new Error("Timed out waiting for protocol event");
};
const fullThread = { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "danger-full-access" };
const fullTurn = { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } };
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
const runTurn = async (text: string, extra = {}) => {
  const after = received.length;
  const result = await rpc("turn/start", { threadId, input: input(text), ...fullTurn, ...extra });
  const completed = await waitFor((message) => message.method === "turn/completed" && message.params.turn.id === result.turn.id, after);
  return { result, completed };
};
try {
  await rpc("initialize", { clientInfo: { name: "aut-probe", title: "aut protocol probe", version: "0.0.1" }, capabilities: { experimentalApi: true, requestAttestation: false } });
  send({ method: "initialized", params: {} });
  const resumeFixture = process.env.AUT_CODEX_RESUME_FIXTURE ?? "spikes/codex/fixtures/normal.jsonl";
  const savedThreadId = scenario === "resume-persisted" ? JSON.parse(readFileSync(resumeFixture, "utf8").split("\n").find((line) => line.includes('"selectedModel"'))!).payload.threadId : undefined;
  const developerInstructions = scenario === "session-mcp"
    ? "This is a synthetic protocol test. Only call the explicitly named aut_session_view fixture_echo MCP tool, which is an isolated local synthetic server. Do not call other MCP tools, access files, the network, or external services. Do not delegate work or ask questions. Follow the exact test instructions."
    : scenario === "session-view"
    ? "This is a synthetic protocol test in an isolated temporary directory. Only execute the explicit harmless commands and edit the explicit probe file inside this working directory. Do not access the network, other files, or external services. Do not delegate work or ask questions. Follow the exact test instructions."
    : "This is a synthetic protocol test. Follow the exact test instructions; do not access files, network, or external tools unless the test explicitly requests a shell sleep. Do not delegate work.";
  const readFixture = process.env.AUT_CODEX_READ_FIXTURE ?? "spikes/codex/fixtures/session-view-0.169.0.jsonl";
  const readId = scenario === "session-read" ? JSON.parse(readFileSync(readFixture, "utf8").split("\n").find((line) => line.includes('"selectedModel"'))!).payload.threadId : undefined;
  const thread = readId ? await rpc("thread/read", { threadId: readId, includeTurns: true }) : savedThreadId ? await rpc("thread/resume", { threadId: savedThreadId, cwd, ...fullThread }) : await rpc("thread/start", { cwd, ...fullThread, developerInstructions });
  threadId = thread.thread.id;
  record("probe", { selectedModel: thread.model, threadId, ...(savedThreadId ? { resumeFixture } : {}) });
  if (scenario === "session-read") {
    record("probe", { coldReadOnly: true, readFixture, turns: thread.thread.turns.length });
  } else if (scenario === "session-context") {
    await runTurn("Synthetic context fixture. Do not use tools, access files, or ask questions. Remember the marker AUT_CONTEXT_BLUE. Reply exactly AUT_CONTEXT_READY.");
    await runTurn("Synthetic context fixture follow-up. Do not use tools, access files, or ask questions. Reply with the marker from the previous request, and nothing else.");
    await rpc("thread/read", { threadId, includeTurns: true });
    const compacted = received.some((message) => message.method === "item/completed" && message.params?.threadId === threadId && message.params?.item?.type === "contextCompaction");
    const measured = received.some((message) => message.method === "thread/tokenUsage/updated" && message.params?.threadId === threadId);
    record("probe", { automaticCompaction: compacted, nativeUsage: measured, manualCompactionRequested: false });
    if (!compacted || !measured) throw new Error("Native automatic compaction or token usage was not observed");
  } else if (scenario === "session-mcp") {
    await runTurn("Synthetic UI protocol fixture: call the MCP tool mcp__aut_session_view__fixture_echo exactly once with text='aut-session-ui-mcp-probe'. It is a local synthetic server, not an external service. Do not use any other tool and do not ask questions. Then reply exactly AUT_SESSION_MCP_OK.");
    await rpc("thread/read", { threadId, includeTurns: true });
  } else if (scenario === "session-view") {
    const after = received.length;
    const started = await rpc("turn/start", { threadId, ...fullTurn, input: input("Synthetic UI protocol fixture: first call apply_patch to create the file aut-session-ui-probe.txt in the current temporary working directory with exactly the line 'fixture file content'. Then execute this exact harmless shell command: printf 'aut-session-ui-probe\\n'; sleep 2; printf 'aut-session-ui-done\\n'. Do not inspect other files or use external services. Do not ask questions. After both tools succeed, reply exactly AUT_SESSION_UI_OK.") });
    await waitFor((message) => message.method === "item/started" && message.params.item.type === "commandExecution" && message.params.turnId === started.turn.id, after);
    record("probe", { snapshot: "during-command", turnId: started.turn.id });
    await rpc("thread/read", { threadId, includeTurns: true });
    await waitFor((message) => message.method === "turn/completed" && message.params.turn.id === started.turn.id, after);
    record("probe", { snapshot: "after-completion", turnId: started.turn.id });
    await rpc("thread/read", { threadId, includeTurns: true });
    record("probe", { probeFileText: readFileSync(join(cwd, "aut-session-ui-probe.txt"), "utf8") });
  } else if (scenario === "resume-persisted") {
    await runTurn("Reply with exactly TEST_PERSISTED_RESUME_OK and do nothing else.");
    await rpc("thread/read", { threadId, includeTurns: true });
  } else if (["default", "default-enabled", "default-delayed", "plan", "plan-free"].includes(scenario)) {
    const mode = scenario.startsWith("plan") ? "plan" : "default";
    await runTurn("For this synthetic protocol fixture, call request_user_input exactly once now with TWO questions. First id probe_color, header Color, question Which fixture color?, options Blue / Red. Second id probe_shape, header Shape, question Which fixture shape?, options Circle / Square. Do not answer the questions yourself. After receiving the fixture replies, output TEST_ANSWER:<color>:<shape>. If the tool is unavailable, reply TOOL_UNAVAILABLE and do nothing else.", { collaborationMode: { mode, settings: { model: thread.model, reasoning_effort: null, developer_instructions: null } } });
  } else if (["async", "async-enabled", "async-delayed"].includes(scenario)) {
    const after = received.length;
    const turn = await rpc("turn/start", { threadId, ...fullTurn, input: input("Synthetic fixture: call request_user_input_async to ask 'Which fixture color?' with options Blue and Red, then run shell command sleep 12 to continue independent work. Do not answer the question yourself. Wait to receive a later message with the test answer, then finish with TEST_ASYNC:<answer>. If request_user_input_async is unavailable, reply ASYNC_UNAVAILABLE and do nothing else.") });
    const event = await waitFor((message) => (message.method === "item/completed" && message.params.item.delivery === "async") || (message.method === "turn/completed" && message.params.turn.id === turn.turn.id), after);
    if (event.method === "item/completed") {
      const fixtureQuestions = event.params.item.questions;
      if (event.params.threadId !== threadId || event.params.turnId !== turn.turn.id || fixtureQuestions?.length !== 1 || fixtureQuestions[0].title !== "Which fixture color?" || JSON.stringify(fixtureQuestions[0].options) !== JSON.stringify(["Blue", "Red"])) {
        record("probe", { unexpectedAsyncQuestion: true });
        throw new Error("Unexpected async question; no synthetic answer was sent");
      }
      if (scenario === "async-delayed") {
        await waitFor((message) => message.method === "item/started" && message.params.item.type === "commandExecution", after);
        record("probe", { independentWorkBeforeAnswer: true });
      }
      await rpc("turn/steer", { threadId, expectedTurnId: turn.turn.id, input: input("Fixture answer to 'Which fixture color?': Blue. Finish with TEST_ASYNC:Blue.") });
    }
    await waitFor((message) => message.method === "turn/completed" && message.params.turn.id === turn.turn.id, after);
  } else {
    await runTurn("Reply with exactly TEST_NORMAL_OK and do nothing else.");
    await rpc("thread/read", { threadId, includeTurns: true });
    await rpc("thread/resume", { threadId, cwd, ...fullThread });
    await runTurn("Reply with exactly TEST_RESUME_OK and do nothing else.");
    const fork = await rpc("thread/fork", { threadId, cwd, ...fullThread });
    const parentId = threadId;
    threadId = fork.thread.id;
    await runTurn("Reply with exactly TEST_FORK_ONLY and do nothing else.");
    await rpc("thread/read", { threadId, includeTurns: true });
    threadId = parentId;
    await rpc("thread/read", { threadId, includeTurns: true });
    const after = received.length;
    const turn = await rpc("turn/start", { threadId, ...fullTurn, input: input("Run the harmless shell command sleep 12, then say TEST_BEFORE_STEER.") });
    await waitFor((message) => message.method === "item/started" && message.params.item.type === "commandExecution", after);
    await rpc("turn/steer", { threadId, expectedTurnId: turn.turn.id, input: input("After the sleep, say TEST_STEER_OK instead of the previous phrase.") });
    await waitFor((message) => message.method === "turn/completed" && message.params.turn.id === turn.turn.id, after);
    try { await rpc("turn/steer", { threadId, expectedTurnId: turn.turn.id, input: input("Idle steer fixture") }); } catch (error) { record("probe", { idleSteerError: String(error) }); }
    const interruptAfter = received.length;
    const interruptTurn = await rpc("turn/start", { threadId, ...fullTurn, input: input("Run the harmless shell command sleep 30, then say TEST_INTERRUPT_SHOULD_NOT_COMPLETE.") });
    await waitFor((message) => message.method === "item/started" && message.params.item.type === "commandExecution", interruptAfter);
    await rpc("turn/interrupt", { threadId, turnId: interruptTurn.turn.id });
    await waitFor((message) => message.method === "turn/completed" && message.params.turn.id === interruptTurn.turn.id, interruptAfter);
  }
  record("probe", { finished: true });
  console.log(JSON.stringify({ scenario, version, output, result: "finished" }));
} catch (error) {
  record("probe", { error: String(error) });
  console.error(String(error));
  process.exitCode = 1;
} finally {
  if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit").catch(() => undefined);
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.kill("SIGTERM");
    await exited;
    clearTimeout(killTimer);
  }
}
