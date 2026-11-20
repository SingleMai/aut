import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Evidence assertions target the recorded CLI version, not assumptions about future versions.
type Frame = { at: string; direction: string; payload: any };
const load = (name: string): Frame[] => readFileSync(new URL(`fixtures/${name}-0.169.0.jsonl`, import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line));
const frames = load("session-view");
const received = frames.filter((row) => row.direction === "receive").map((row) => row.payload);
const items = (method: string) => received.filter((message) => message.method === method).map((message) => message.params.item);
const reads = frames.filter((row) => row.direction === "send" && row.payload.method === "thread/read")
  .map((row) => received.find((message) => message.id === row.payload.id && message.result)?.result.thread);

test("session view records 0.169.0, settles all RPCs and never answers user questions", () => {
  assert.equal(frames[0]?.payload.version, "codex-cli 0.169.0");
  assert.ok(frames.some((row) => row.direction === "probe" && row.payload.finished));
  assert.ok(frames.some((row) => row.direction === "exit" && row.payload.code === 0));
  for (const row of frames.filter((row) => row.direction === "send" && row.payload.id !== undefined)) {
    assert.ok(row.payload.method, "No server question response is permitted in this probe");
    assert.ok(received.some((message) => message.id === row.payload.id && !message.method));
  }
});

test("native user, agent, command and file-change item IDs survive thread/read", () => {
  const completed = items("item/completed");
  const historical = reads[1].turns[0].items;
  for (const kind of ["userMessage", "agentMessage", "commandExecution", "fileChange"]) {
    assert.ok(completed.some((item) => item.type === kind));
    for (const item of completed.filter((item) => item.type === kind)) {
      assert.ok(items("item/started").some((started) => started.id === item.id));
      assert.deepEqual(historical.find((stored: any) => stored.id === item.id), item);
      assert.equal(typeof item.startedAtMs, "number");
      assert.equal(typeof item.completedAtMs, "number");
    }
  }
  assert.equal(historical.at(-1).text, "AUT_SESSION_UI_OK");
  assert.equal(historical.at(-1).phase, "final_answer");
  assert.equal(reads[1].turns[0].itemsView, "full");
  assert.equal(reads[1].turns[0].status, "completed");
});

test("an in-progress historical snapshot may omit an already-started native tool", () => {
  const command = items("item/started").find((item) => item.type === "commandExecution");
  assert.equal(command.status, "inProgress");
  assert.equal(command.completedAtMs, null);
  assert.equal(reads[0].turns[0].status, "inProgress");
  assert.equal(reads[0].turns[0].itemsView, "full");
  assert.ok(!reads[0].turns[0].items.some((item: any) => item.id === command.id));
  assert.ok(reads[1].turns[0].items.some((item: any) => item.id === command.id));
});

test("command completed output is authoritative even when output deltas omit initial bytes", () => {
  const command = items("item/completed").find((item) => item.type === "commandExecution");
  const deltas = received.filter((message) => message.method === "item/commandExecution/outputDelta" && message.params.itemId === command.id);
  const text = deltas.map((message) => message.params.delta).join("");
  assert.ok(deltas.length > 0);
  assert.ok(command.aggregatedOutput.includes("aut-session-ui-probe"));
  assert.ok(command.aggregatedOutput.includes("aut-session-ui-done"));
  assert.notEqual(text, command.aggregatedOutput);
  assert.equal(command.exitCode, 0);
  assert.equal(command.status, "completed");
  assert.ok(command.durationMs > 0);
  assert.ok(deltas.every((message) => typeof message.emittedAtMs === "number"));
});

test("file change stores its path, operation and patch independently from turn-wide diff", () => {
  const item = items("item/completed").find((item) => item.type === "fileChange");
  assert.equal(item.status, "completed");
  assert.equal(item.changes.length, 1);
  assert.equal(item.changes[0].kind.type, "add");
  assert.ok(item.changes[0].path.endsWith("aut-session-ui-probe.txt"));
  assert.ok(item.changes[0].diff.includes("fixture file content"));
  assert.ok(received.some((message) => message.method === "turn/diff/updated" && message.params.diff.includes("diff --git")));
});

test("turn timestamps use seconds while item and emitted timestamps use milliseconds", () => {
  const turn = reads[1].turns[0];
  const first = turn.items[0];
  assert.ok(Math.abs(first.startedAtMs - turn.startedAt * 1000) < 10000);
  assert.ok(Math.abs(turn.items.at(-1).completedAtMs - turn.completedAt * 1000) < 1000);
  assert.ok(received.filter((message) => message.method?.startsWith("item/")).every((message) => message.emittedAtMs > 1e12));
});

test("cold native read has identical item identities without resuming or starting a turn", () => {
  const cold = load("session-read");
  assert.deepEqual(cold.filter((row) => row.direction === "send").map((row) => row.payload.method), ["initialize", "initialized", "thread/read"]);
  const result = cold.find((row) => row.direction === "receive" && row.payload.result?.thread)?.payload.result.thread;
  assert.deepEqual(result.turns[0].items, reads[1].turns[0].items);
  assert.ok(cold.some((row) => row.direction === "exit" && row.payload.code === 0));
});

test("local synthetic MCP stores real arguments, result and stable tool-call IDs", () => {
  const mcp = load("session-mcp");
  const events = mcp.filter((row) => row.direction === "receive").map((row) => row.payload);
  const start = events.find((message) => message.method === "item/started" && message.params.item.type === "mcpToolCall")?.params.item;
  const end = events.find((message) => message.method === "item/completed" && message.params.item.type === "mcpToolCall")?.params.item;
  assert.ok(start && end);
  assert.equal(start.id, end.id);
  assert.equal(start.status, "inProgress");
  assert.equal(end.status, "completed");
  assert.equal(end.server, "aut_session_view");
  assert.equal(end.tool, "fixture_echo");
  assert.deepEqual(end.arguments, { text: "aut-session-ui-mcp-probe" });
  assert.equal(end.result.content[0].text, "MCP_FIXTURE:aut-session-ui-mcp-probe");
  const read = events.find((message) => message.result?.thread?.turns?.length)?.result.thread;
  assert.deepEqual(read.turns[0].items.find((item: any) => item.id === end.id), end);
});
