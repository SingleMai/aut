import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Raw protocol fixtures deliberately retain the CLI's original field names.
type Frame = { at: string; direction: string; payload: any };
const scenarios = ["normal", "default", "default-enabled", "default-delayed", "plan", "plan-free", "async", "async-enabled", "async-delayed", "resume-persisted"];
const load = (name: string): Frame[] => readFileSync(new URL(`fixtures/${name}.jsonl`, import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
const received = (name: string) => load(name).filter((row) => row.direction === "receive").map((row) => row.payload);
const completions = (name: string) => received(name).filter((message) => message.method === "turn/completed").map((message) => message.params.turn);
const report = (turn: any) => turn.status === "completed" ? turn.items.filter((item: any) => item.type === "agentMessage" && item.phase === "final_answer" && item.delivery !== "async").at(-1)?.text : undefined;
const questions = (name: string) => received(name).filter((message) => message.method === "item/tool/requestUserInput");

for (const scenario of scenarios) {
  test(`${scenario}: recorded current CLI and all RPC requests settled`, () => {
    const frames = load(scenario);
    assert.equal(frames[0]?.direction, "meta");
    assert.equal(frames[0]?.payload.version, "codex-cli 0.167.0");
    assert.ok(frames.some((frame) => frame.direction === "probe" && frame.payload.finished === true));
    assert.ok(frames.some((frame) => frame.direction === "exit" && frame.payload.code === 0));
    for (const frame of frames.filter((frame) => frame.direction === "send" && frame.payload.method && frame.payload.id !== undefined)) {
      assert.ok(frames.some((candidate) => candidate.direction === "receive" && !candidate.payload.method && candidate.payload.id === frame.payload.id));
    }
    for (const frame of frames.filter((frame) => frame.direction === "send" && frame.payload.result?.answers)) {
      assert.ok(frames.some((candidate) => candidate.direction === "receive" && candidate.payload.method === "item/tool/requestUserInput" && candidate.payload.id === frame.payload.id));
      assert.deepEqual(Object.keys(frame.payload.result.answers).sort(), ["probe_color", "probe_shape"]);
    }
  });
}

test("full access was supplied at every start, resume, fork and turn", () => {
  for (const name of scenarios) for (const frame of load(name).filter((frame) => frame.direction === "send")) {
    const { method, params } = frame.payload;
    if (["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(method)) {
      assert.equal(params.approvalPolicy, "never");
      assert.equal(params.approvalsReviewer, "user");
      assert.equal(method === "turn/start" ? params.sandboxPolicy.type : params.sandbox, method === "turn/start" ? "dangerFullAccess" : "danger-full-access");
    }
  }
});

test("normal, resume, fork and steer return exact final reports; interruption does not", () => {
  assert.deepEqual(completions("normal").map(report), ["TEST_NORMAL_OK", "TEST_RESUME_OK", "TEST_FORK_ONLY", "TEST_STEER_OK", undefined]);
  assert.equal(completions("normal").at(-1).status, "interrupted");
});

test("fork inherits history and leaves the parent transcript unchanged", () => {
  const frames = load("normal");
  const calls = frames.filter((frame) => frame.direction === "send" && frame.payload.method === "thread/read").map((frame) => frame.payload);
  const threads = calls.map((call) => frames.find((frame) => frame.direction === "receive" && frame.payload.id === call.id)?.payload.result.thread);
  assert.deepEqual(threads.map((thread) => thread.turns.length), [1, 3, 2]);
  assert.notEqual(threads[1].id, threads[2].id);
  assert.ok(JSON.stringify(threads[1]).includes("TEST_FORK_ONLY"));
  assert.ok(!JSON.stringify(threads[2]).includes("TEST_FORK_ONLY"));
});

test("idle steer is explicitly refused", () => {
  assert.ok(received("normal").some((message) => message.error?.code === -32600 && message.error.message === "no active turn to steer"));
});

test("default baseline does not produce a synchronous question", () => {
  assert.equal(questions("default").length, 0);
  assert.equal(report(completions("default")[0]), "TOOL_UNAVAILABLE");
});

test("Plan questions are blocking and support multiple questions", () => {
  const question = questions("plan")[0];
  assert.equal(question.params.isBlocking, true);
  assert.equal(question.params.questions.length, 2);
  assert.equal(report(completions("plan")[0]), "TEST_ANSWER:Blue:Circle");
});

test("Default opt-in uses a non-blocking request and accepts the original response channel", () => {
  assert.equal(questions("default-enabled")[0].params.isBlocking, false);
  assert.equal(report(completions("default-enabled")[0]), "TEST_ANSWER:Blue:Circle");
});

test("held Plan question remains alive and accepts free text outside its options", () => {
  const frames = load("plan-free");
  const request = frames.find((frame) => frame.direction === "receive" && frame.payload.method === "item/tool/requestUserInput")!;
  const answer = frames.find((frame) => frame.direction === "send" && frame.payload.result?.answers)!;
  assert.ok(Date.parse(answer.at) - Date.parse(request.at) >= 4_900);
  assert.ok(frames.some((frame) => frame.payload.processAliveDuringQuestion === true));
  assert.equal(report(completions("plan-free")[0]), "TEST_ANSWER:Teal fixture text:Circle");
});

test("CLI 0.169.0 Plan blocks for five seconds and accepts free text through the original RPC", () => {
  const frames = load("plan-free-0.169.0");
  assert.equal(frames[0]?.payload.version, "codex-cli 0.169.0");
  const turn = frames.find((frame) => frame.direction === "send" && frame.payload.method === "turn/start")!;
  assert.equal(turn.payload.params.collaborationMode.mode, "plan");
  const request = frames.find((frame) => frame.direction === "receive" && frame.payload.method === "item/tool/requestUserInput")!;
  const answers = frames.filter((frame) => frame.direction === "send" && frame.payload.result?.answers);
  assert.equal(answers.length, 1);
  const answer = answers[0]!;
  assert.equal(request.payload.params.isBlocking, true);
  assert.deepEqual(request.payload.params.questions.map((question: any) => question.id), ["probe_color", "probe_shape"]);
  assert.equal(answer.payload.id, request.payload.id);
  assert.deepEqual(answer.payload.result.answers, {
    probe_color: { answers: ["Teal fixture text"] },
    probe_shape: { answers: ["Circle"] },
  });
  assert.ok(Date.parse(answer.at) - Date.parse(request.at) >= 4_900);
  assert.ok(frames.some((frame) => frame.direction === "probe" && frame.payload.processAliveDuringQuestion === true));
  assert.ok(!frames.some((frame) => frame.direction === "receive" && frame.payload.method === "turn/completed"
    && Date.parse(frame.at) < Date.parse(answer.at)));
  assert.equal(report(completions("plan-free-0.169.0")[0]), "TEST_ANSWER:Teal fixture text:Circle");
  assert.ok(frames.some((frame) => frame.direction === "probe" && frame.payload.finished === true));
  assert.ok(frames.some((frame) => frame.direction === "exit" && frame.payload.code === 0));
});

test("held Default request is not answered with an empty approval", () => {
  const frames = load("default-delayed");
  assert.ok(frames.some((frame) => frame.payload.processAliveDuringQuestion === true));
  assert.equal(report(completions("default-delayed")[0]), "TEST_ANSWER:Blue:Circle");
});

test("async variants are notifications and final reports exclude question items", () => {
  for (const name of ["async", "async-enabled", "async-delayed"]) {
    assert.equal(questions(name).length, 0);
    const asyncItem = received(name).find((message) => message.method === "item/completed" && message.params.item.delivery === "async")?.params.item;
    assert.equal(asyncItem.phase, "final_answer");
    assert.equal(asyncItem.questions[0].title, "Which fixture color?");
    assert.equal(report({ status: "completed", items: [asyncItem] }), undefined);
    assert.equal(report(completions(name)[0]), "TEST_ASYNC:Blue");
  }
});

test("async worker starts independent work before receiving the answer", () => {
  const frames = load("async-delayed");
  const command = frames.findIndex((frame) => frame.direction === "receive" && frame.payload.method === "item/started" && frame.payload.params.item.type === "commandExecution");
  const answer = frames.findIndex((frame) => frame.direction === "send" && frame.payload.method === "turn/steer");
  assert.ok(command > 0 && answer > command);
});

test("a fresh app-server process resumes a persisted thread", () => {
  const parent = load("normal").find((frame) => frame.payload.selectedModel)?.payload.threadId;
  const frames = load("resume-persisted");
  assert.ok(!frames.some((frame) => frame.direction === "send" && frame.payload.method === "thread/start"));
  assert.equal(frames.find((frame) => frame.direction === "send" && frame.payload.method === "thread/resume")?.payload.params.threadId, parent);
  assert.equal(report(completions("resume-persisted")[0]), "TEST_PERSISTED_RESUME_OK");
});
