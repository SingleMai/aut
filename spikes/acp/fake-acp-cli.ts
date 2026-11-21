#!/usr/bin/env node
// ACP protocol fixture server adapted from OpenMausBot (Apache-2.0),
// server/testing/fake-acp-cli.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// It is intentionally small and only supplies deterministic protocol fixtures.
import { createInterface } from "node:readline";

type RecordValue = Record<string, unknown>;
type Rpc = RecordValue & { id?: string | number; method?: string };

const mode = process.env.FAKE_ACP_MODE ?? "normal";
const sessions = new Set<string>();
let nextSession = 1;
let pendingPrompt: ((result: RecordValue) => void) | undefined;

const send = (message: Rpc): void => process.stdout.write(`${JSON.stringify(message)}\n`);
const update = (sessionId: string, value: RecordValue): void =>
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });

const promptResult = (sessionId: string): void => {
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    messageId: "fixture-message",
    content: { type: "text", text: "FAKE_ACP_OK" },
  });
  pendingPrompt?.({ stopReason: "end_turn" });
  pendingPrompt = undefined;
};

const openPermission = (sessionId: string): void => {
  send({
    jsonrpc: "2.0",
    id: 20,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: "tool-fixture",
        title: "Run the fixture command",
        kind: "execute",
        rawInput: { command: "printf ACP_PERMISSION_OK" },
      },
      options: [
        { optionId: "once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject", kind: "reject_once", name: "Reject" },
      ],
    },
  });
};

const openGrokQuestion = (sessionId: string): void => {
  send({
    jsonrpc: "2.0",
    id: 21,
    method: "_x.ai/ask_user_question",
    params: {
      sessionId,
      questions: [
        { question: "Which color?", options: ["Blue", "Red"], multi_select: false },
        { question: "Any note?", options: [] },
      ],
    },
  });
};

const onRequest = (message: Rpc): void => {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { fork: {}, resume: {} },
        },
        agentInfo: { name: "fake-acp", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "session/new") {
    const id = `fake-session-${nextSession++}`;
    sessions.add(id);
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: id } });
    return;
  }
  if (message.method === "session/load" || message.method === "session/resume") {
    const params = message.params as RecordValue | undefined;
    const id = typeof params?.sessionId === "string" ? params.sessionId : "fake-session-resumed";
    sessions.add(id);
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: id } });
    return;
  }
  if (message.method === "session/fork") {
    const id = `fake-session-fork-${nextSession++}`;
    sessions.add(id);
    send({ jsonrpc: "2.0", id: message.id, result: { sessionId: id } });
    return;
  }
  if (message.method === "session/prompt") {
    const params = message.params as RecordValue | undefined;
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "fake-session";
    pendingPrompt = (result) => send({ jsonrpc: "2.0", id: message.id, result });
    if (mode === "permission") openPermission(sessionId);
    else if (mode === "question") openGrokQuestion(sessionId);
    else if (mode === "interrupt") return;
    else promptResult(sessionId);
    return;
  }
  if (message.method === "session/cancel") {
    pendingPrompt?.({ stopReason: "cancelled" });
    pendingPrompt = undefined;
    return;
  }
  if (message.id !== undefined)
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported method" } });
};

createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    const message = JSON.parse(line) as Rpc;
    if (message.method === "session/request_permission" && message.id !== undefined) return;
    if (message.method === "session/update") return;
    if (message.method === undefined && message.id !== undefined && message.result !== undefined) {
      if (message.id === 20 || message.id === 21) promptResult("fake-session-1");
      return;
    }
    onRequest(message);
  } catch {
    process.exitCode = 1;
  }
});

