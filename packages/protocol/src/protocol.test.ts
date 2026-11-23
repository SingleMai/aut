import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Common from "./common.js";
import * as Config from "./config.js";
import * as Domain from "./domain.js";
import * as Mcp from "./mcp.js";

const option = { id: "blue", label: "Blue", description: "Use the blue theme" };
const question = {
  id: "color",
  text: "Choose a color",
  options: [option],
  multiSelect: false,
  allowFreeText: true,
};
const perQuestion = { questionId: "color", optionIds: ["blue"] };
const answer = { perQuestion: [perQuestion] };
const request = {
  id: "r1",
  taskId: "t1",
  kind: "question",
  openedAt: 1,
  questions: [question],
  raw: { method: "request" },
};
const permission = { tool: "shell", summary: "Run the command" };
const cursor = { kind: "codex", data: { threadId: "thread-1" } };
const modelSelection = { instanceId: "codex", model: "model-1" };
const bot = {
  id: "b1",
  name: "Research",
  description: "Research requests",
  soul: "",
  modelSelection,
  cwd: "/tmp/aut",
  mcpServers: [],
};
const harness = {
  id: "codex",
  name: "Local Codex",
  kind: "codex",
  command: "codex",
  args: ["app-server"],
};
const backend = {
  backend: "jev",
  model: "jev-1.13.0",
  endpoint: "https://api.example.com/decide",
  apiKeyRef: "JEV_API_KEY",
};
const control = { op: "control", taskId: "t1", action: "cancel" };
const cardOption = { id: "cancel", label: "Cancel task", op: control };
const card = {
  id: "c1",
  prompt: "Confirm task",
  options: [cardOption],
  multiSelect: false,
  allowFreeText: true,
  state: "open",
};
const message = { id: "m1", at: 1, author: "user", kind: "text", text: "Research this" };
const task = {
  id: "t1",
  botId: "b1",
  title: "Research",
  status: "waiting_user",
  createdAt: 1,
  updatedAt: 2,
  lastActivityAt: 2,
  session: { instanceId: "codex", cursor },
  pendingRequestIds: ["r1"],
  queue: [],
  origin: { kind: "user" },
};
const triggerSchedule = { kind: "daily", at: "09:00", timeZone: "UTC" };
const trigger = {
  id: "trigger-1",
  name: "Morning check",
  enabled: true,
  botId: "b1",
  prompt: "Run the morning check",
  payload: { source: "schedule" },
  schedule: triggerSchedule,
  overlap: "skip",
  createdAt: 1,
  updatedAt: 1,
  nextAt: 2,
};
const triggerRun = {
  id: "run:trigger-1:2",
  triggerId: "trigger-1",
  occurrenceKey: "trigger-1:2",
  scheduledAt: 2,
  status: "queued",
};
const capabilities = {
  resume: true,
  fork: true,
  steer: true,
  nativeFullAccess: true,
  questions: { native: true, multiQuestion: true, multiSelect: false, freeText: true },
  transcript: true,
};
const decisionQuestion = {
  type: "choice",
  instructions: "Select a task",
  criteria: { t1: "Research task" },
};
const decisionRequest = {
  state: { message: "Check progress" },
  questions: { target: decisionQuestion },
};
const decisionAnswer = { type: "choice", choice: "t1", confidence: 1, probabilities: { t1: 1 } };
const decisionResponse = {
  answers: { target: decisionAnswer },
  latencyMs: 20,
  usage: { inputTokens: 10, cost: 0.001 },
};
const correction = { at: 2, kind: "manual", detail: "User corrected the target" };
const log = {
  id: "d1",
  at: 1,
  tree: "inbound",
  treeVersion: "1",
  input: {
    eventRef: "m1",
    state: { text: "Cancel task" },
    dynamicOptions: { target: { t1: "Research task" } },
  },
  classifierCalls: [
    {
      backend: "jev",
      model: "jev-1.13.0",
      request: decisionRequest,
      response: decisionResponse,
      latencyMs: 20,
    },
  ],
  path: ["C1", "A1"],
  output: control,
  execution: { ok: true },
  correction,
};
const summary = {
  id: "t1",
  botId: "b1",
  title: "Research",
  status: "waiting_user",
  createdAt: 1,
  updatedAt: 2,
  lastActivityAt: 2,
  pendingRequestIds: ["r1"],
};
const excerpt = { id: "m1", at: 1, author: "user", text: "Research this", taskId: "t1" };

type Case = {
  readonly schema: Schema.Schema.AnyNoContext;
  readonly valid: unknown;
  readonly invalid: unknown;
};
const cases: Record<string, Case> = {
  NonEmptyString: { schema: Common.NonEmptyString, valid: "x", invalid: "" },
  FiniteNumber: { schema: Common.FiniteNumber, valid: -2.5, invalid: Infinity },
  NonNegativeNumber: { schema: Common.NonNegativeNumber, valid: 0.5, invalid: -1 },
  NonNegativeInteger: {
    schema: Common.NonNegativeInteger,
    valid: 0,
    invalid: Number.MAX_SAFE_INTEGER + 1,
  },
  PositiveInteger: { schema: Common.PositiveInteger, valid: 1, invalid: 0 },
  Probability: { schema: Common.Probability, valid: 0.6, invalid: 1.01 },
  SafeKey: { schema: Common.SafeKey, valid: "target", invalid: "__proto__" },
  DispatchChange: {
    schema: Domain.DispatchChange,
    valid: { kind: "reroute", botId: "b2" },
    invalid: { kind: "reroute" },
  },
  CreateBotInput: {
    schema: Mcp.CreateBotInput,
    valid: { id: "b", name: "Bot", description: "Help", soul: "" },
    invalid: { id: "b", name: "", description: "Help", soul: "" },
  },
  CreateBotOutput: {
    schema: Mcp.CreateBotOutput,
    valid: { id: "b", name: "Bot" },
    invalid: { id: "b" },
  },
  CreateTriggerOutput: {
    schema: Mcp.CreateTriggerOutput,
    valid: trigger,
    invalid: { ...trigger, id: "" },
  },
  GetTriggerInput: {
    schema: Mcp.GetTriggerInput,
    valid: { triggerId: "trigger-1" },
    invalid: { triggerId: "" },
  },
  GetTriggerOutput: {
    schema: Mcp.GetTriggerOutput,
    valid: trigger,
    invalid: { ...trigger, id: "" },
  },
  ListTriggersInput: {
    schema: Mcp.ListTriggersInput,
    valid: { botId: "b1", enabled: true, limit: 10 },
    invalid: { limit: 51 },
  },
  ListTriggersOutput: {
    schema: Mcp.ListTriggersOutput,
    valid: [trigger],
    invalid: [{}],
  },
  ListTriggerRunsInput: {
    schema: Mcp.ListTriggerRunsInput,
    valid: { triggerId: "trigger-1", limit: 10 },
    invalid: { triggerId: "", limit: 51 },
  },
  ListTriggerRunsOutput: {
    schema: Mcp.ListTriggerRunsOutput,
    valid: [triggerRun],
    invalid: [{}],
  },
  UpdateTriggerToolInput: {
    schema: Mcp.UpdateTriggerToolInput,
    valid: { triggerId: "trigger-1", update: { enabled: false } },
    invalid: { triggerId: "", update: { enabled: false } },
  },
  UpdateTriggerOutput: {
    schema: Mcp.UpdateTriggerOutput,
    valid: trigger,
    invalid: { ...trigger, id: "" },
  },
  RoutingCandidateId: { schema: Common.RoutingCandidateId, valid: "天文", invalid: "older_task" },
  TaskId: { schema: Common.TaskId, valid: "t1", invalid: "" },
  TriggerId: { schema: Common.TriggerId, valid: "trigger-1", invalid: "" },
  TriggerRunId: { schema: Common.TriggerRunId, valid: "run:trigger-1:2", invalid: "" },
  MessageId: { schema: Common.MessageId, valid: "m1", invalid: "" },
  RequestId: { schema: Common.RequestId, valid: "r1", invalid: "" },
  BotId: { schema: Common.BotId, valid: "b1", invalid: "" },
  Timestamp: { schema: Common.Timestamp, valid: 0, invalid: -1 },
  JsonValue: {
    schema: Common.JsonValue,
    valid: { nested: [null, true, 2, "value"] },
    invalid: undefined,
  },
  JsonRecord: { schema: Common.JsonRecord, valid: { count: 1 }, invalid: [] },
  StringRecord: { schema: Common.StringRecord, valid: { name: "value" }, invalid: { name: 1 } },
  HttpUrl: {
    schema: Common.HttpUrl,
    valid: "https://example.com/api",
    invalid: "file:///tmp/token",
  },
  McpServerConfig: {
    schema: Config.McpServerConfig,
    valid: { name: "aut", transport: "stdio", command: "aut-mcp", args: [] },
    invalid: { name: "aut", transport: "http", url: "ftp://example.com" },
  },
  ModelSelection: {
    schema: Config.ModelSelection,
    valid: modelSelection,
    invalid: { ...modelSelection, instanceId: "" },
  },
  BotConfig: { schema: Config.BotConfig, valid: bot, invalid: { ...bot, id: "" } },
  BotCreationReceipt: {
    schema: Domain.BotCreationReceipt,
    valid: { botId: "calendar", status: "available" },
    invalid: { botId: "calendar", status: "approved" },
  },
  BotsConfig: { schema: Config.BotsConfig, valid: [bot], invalid: [bot, bot] },
  HarnessInstanceConfig: {
    schema: Config.HarnessInstanceConfig,
    valid: harness,
    invalid: { ...harness, command: "" },
  },
  ClassifierBackendConfig: {
    schema: Config.ClassifierBackendConfig,
    valid: backend,
    invalid: { ...backend, model: "jev-latest" },
  },
  ClassifierConfig: { schema: Config.ClassifierConfig, valid: { primary: backend }, invalid: {} },
  AutConfig: {
    schema: Config.AutConfig,
    valid: { harnessInstances: [harness] },
    invalid: { harnessInstances: [harness, harness] },
  },
  ControlAction: { schema: Domain.ControlAction, valid: "cancel", invalid: "delete" },
  TaskStatus: { schema: Domain.TaskStatus, valid: "idle", invalid: "done" },
  ResumeCursor: {
    schema: Domain.ResumeCursor,
    valid: cursor,
    invalid: { ...cursor, data: undefined },
  },
  TurnInput: {
    schema: Domain.TurnInput,
    valid: { text: "Internal rewrite", messageIds: [] },
    invalid: { text: "Missing references" },
  },
  TranscriptEntry: {
    schema: Domain.TranscriptEntry,
    valid: { role: "assistant", text: "Done", at: 1, turnId: "turn-1" },
    invalid: { role: "unknown", text: "Done" },
  },
  QuestionOption: { schema: Domain.QuestionOption, valid: option, invalid: { ...option, id: "" } },
  Question: {
    schema: Domain.Question,
    valid: question,
    invalid: { ...question, options: [option, option] },
  },
  Questions: { schema: Domain.Questions, valid: [question], invalid: [] },
  PerQuestionAnswer: {
    schema: Domain.PerQuestionAnswer,
    valid: perQuestion,
    invalid: { questionId: "color" },
  },
  QuestionAnswer: { schema: Domain.QuestionAnswer, valid: answer, invalid: { perQuestion: [] } },
  Permission: {
    schema: Domain.Permission,
    valid: permission,
    invalid: { ...permission, tool: "" },
  },
  SessionRequest: {
    schema: Domain.SessionRequest,
    valid: request,
    invalid: { ...request, questions: [] },
  },
  ProposableOp: { schema: Domain.ProposableOp, valid: control, invalid: { op: "clarify", card } },
  CardOption: {
    schema: Domain.CardOption,
    valid: cardOption,
    invalid: { ...cardOption, op: { op: "destroy" } },
  },
  Card: {
    schema: Domain.Card,
    valid: card,
    invalid: { ...card, options: [cardOption, cardOption] },
  },
  Op: {
    schema: Domain.Op,
    valid: { op: "clarify", card },
    invalid: { op: "send", taskId: "t1", delivery: "auto", messageIds: [] },
  },
  UiAction: {
    schema: Domain.UiAction,
    valid: { type: "question-answer", cardId: "c1", requestId: "r1", answer },
    invalid: { type: "question-answer", cardId: "c1", requestId: "r1", answer: { allow: true } },
  },
  MessageAuthor: {
    schema: Domain.MessageAuthor,
    valid: { botId: "b1", taskId: "t1" },
    invalid: "assistant",
  },
  MainThreadMessage: {
    schema: Domain.MainThreadMessage,
    valid: message,
    invalid: { ...message, at: 0.1 },
  },
  Task: { schema: Domain.Task, valid: task, invalid: { ...task, pendingRequestIds: ["r1", "r1"] } },
  TriggerSchedule: {
    schema: Domain.TriggerSchedule,
    valid: triggerSchedule,
    invalid: { kind: "daily", at: "25:00", timeZone: "UTC" },
  },
  Trigger: { schema: Domain.Trigger, valid: trigger, invalid: { ...trigger, overlap: "queue" } },
  TriggerRun: {
    schema: Domain.TriggerRun,
    valid: triggerRun,
    invalid: { ...triggerRun, status: "done" },
  },
  AdapterCapabilities: {
    schema: Domain.AdapterCapabilities,
    valid: capabilities,
    invalid: { ...capabilities, fork: "yes" },
  },
  StartSessionInput: {
    schema: Domain.StartSessionInput,
    valid: {
      taskId: "t1",
      bot,
      model: "model-1",
      cwd: "/tmp/aut",
      instructions: "",
      mcpServers: [],
    },
    invalid: { bot, model: "model-1", cwd: "/tmp/aut", instructions: "", mcpServers: [] },
  },
  SessionEvent: {
    schema: Domain.SessionEvent,
    valid: { kind: "turn.completed", turnId: "turn-1", ok: true, finalReport: "Done" },
    invalid: { kind: "turn.completed", turnId: "turn-1" },
  },
  AutEvent: {
    schema: Domain.AutEvent,
    valid: {
      source: "session",
      kind: "request.opened",
      taskId: "t1",
      event: { kind: "request.opened", request },
    },
    invalid: {
      source: "session",
      kind: "turn.started",
      taskId: "t1",
      event: { kind: "turn.completed", turnId: "turn-1", ok: true, finalReport: "Done" },
    },
  },
  DecisionQuestion: {
    schema: Domain.DecisionQuestion,
    valid: decisionQuestion,
    invalid: { ...decisionQuestion, criteria: {} },
  },
  DecisionRequest: {
    schema: Domain.DecisionRequest,
    valid: decisionRequest,
    invalid: { ...decisionRequest, questions: {} },
  },
  DecisionAnswer: {
    schema: Domain.DecisionAnswer,
    valid: decisionAnswer,
    invalid: { ...decisionAnswer, choice: "absent" },
  },
  DecisionResponse: {
    schema: Domain.DecisionResponse,
    valid: decisionResponse,
    invalid: { ...decisionResponse, latencyMs: -1 },
  },
  HandoffPacket: {
    schema: Domain.HandoffPacket,
    valid: {
      header: "Task header",
      request: [{ messageId: "m1", at: 1, text: "Research" }],
      excerpts: [{ messageId: "m0", at: 0, author: "user", text: "Context", relevance: 0.8 }],
      relatedTasks: [],
      toolHint: "Use read_main_thread",
    },
    invalid: { header: "Task header" },
  },
  DecisionOutput: {
    schema: Domain.DecisionOutput,
    valid: { gate: "deliver" },
    invalid: { gate: "bypass" },
  },
  DecisionCorrection: {
    schema: Domain.DecisionCorrection,
    valid: correction,
    invalid: { ...correction, kind: "automatic" },
  },
  DecisionLog: {
    schema: Domain.DecisionLog,
    valid: log,
    invalid: { ...log, execution: undefined },
  },
  MainThreadExcerpt: {
    schema: Mcp.MainThreadExcerpt,
    valid: excerpt,
    invalid: { ...excerpt, author: "assistant" },
  },
  TaskSummary: { schema: Mcp.TaskSummary, valid: summary, invalid: { ...summary, status: "done" } },
  ReadMainThreadInput: {
    schema: Mcp.ReadMainThreadInput,
    valid: { ids: ["m1"] },
    invalid: { limit: 51 },
  },
  ReadMainThreadOutput: { schema: Mcp.ReadMainThreadOutput, valid: [excerpt], invalid: [null] },
  ListTasksInput: {
    schema: Mcp.ListTasksInput,
    valid: { status: ["running"], botId: "b1", limit: 10 },
    invalid: { limit: 0 },
  },
  ListTasksOutput: { schema: Mcp.ListTasksOutput, valid: [summary], invalid: [{}] },
  GetTaskInput: { schema: Mcp.GetTaskInput, valid: { taskId: "t1" }, invalid: { taskId: "" } },
  GetTaskOutput: { schema: Mcp.GetTaskOutput, valid: task, invalid: {} },
  ProposeRouteInput: {
    schema: Mcp.ProposeRouteInput,
    valid: { op: control, rationale: "User asked to cancel" },
    invalid: { op: { op: "clarify", card }, rationale: "Cannot route" },
  },
  ProposeRouteOutput: {
    schema: Mcp.ProposeRouteOutput,
    valid: { accepted: false, rejectReason: "Unknown task" },
    invalid: { accepted: "true" },
  },
  AskUserInput: {
    schema: Mcp.AskUserInput,
    valid: { questions: [question] },
    invalid: { questions: [] },
  },
  AskUserOutput: { schema: Mcp.AskUserOutput, valid: "Blue", invalid: { answer: "Blue" } },
};

describe("protocol boundary schemas", () => {
  it("covers every exported data schema in these modules", () => {
    const schemas = Object.entries({ ...Common, ...Config, ...Domain, ...Mcp })
      .filter(([, value]) => Schema.isSchema(value))
      .map(([name]) => name)
      .sort();
    expect(Object.keys(cases).sort()).toEqual(schemas);
  });

  for (const [name, { schema, valid, invalid }] of Object.entries(cases)) {
    it(`${name} survives JSON decode/encode`, () => {
      const decoded = Schema.decodeUnknownSync(schema)(JSON.parse(JSON.stringify(valid)));
      const encoded = Schema.encodeSync(schema)(decoded);
      expect(JSON.parse(JSON.stringify(encoded))).toEqual(valid);
    });
    it(`${name} rejects invalid boundary input`, () => {
      expect(Schema.decodeUnknownEither(schema)(invalid)._tag).toBe("Left");
    });
  }
});

it("allows absent decision output only for failed or pending execution", () => {
  const { output: _output, ...withoutOutput } = log;
  expect(
    Schema.is(Domain.DecisionLog)({
      ...withoutOutput,
      execution: { ok: false, error: "Step budget exhausted" },
    }),
  ).toBe(true);
  expect(Schema.is(Domain.DecisionLog)({ ...withoutOutput, execution: { ok: true } })).toBe(false);
});

describe("cross-field and serialization constraints", () => {
  it.each([undefined, NaN, Infinity, 1n, () => 1, new Date(), { key: undefined }, new Array(2)])(
    "rejects non-JSON values: %s",
    (value) => {
      expect(Schema.decodeUnknownEither(Common.JsonValue)(value)._tag).toBe("Left");
    },
  );

  it("rejects cyclic JSON while allowing repeated acyclic references", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(Schema.decodeUnknownEither(Common.JsonValue)(cyclic)._tag).toBe("Left");
    const repeated = { name: "shared" };
    expect(Schema.decodeUnknownEither(Common.JsonValue)([repeated, repeated])._tag).toBe("Right");
  });

  it("rejects sparse arrays with extra keys and non-JSON property descriptors", () => {
    const sparse = [1];
    sparse.length = 2;
    Object.assign(sparse, { extra: 2 });
    expect(Schema.decodeUnknownEither(Common.JsonValue)(sparse)._tag).toBe("Left");
    expect(
      Schema.decodeUnknownEither(Common.JsonValue)(
        Object.defineProperty({}, "hidden", { value: 1 }),
      )._tag,
    ).toBe("Left");
    expect(
      Schema.decodeUnknownEither(Common.JsonValue)({
        get value() {
          return 1;
        },
      })._tag,
    ).toBe("Left");
  });

  it("rejects empty classifier keys even alongside valid keys", () => {
    expect(
      Schema.decodeUnknownEither(Domain.DecisionQuestion)({
        ...decisionQuestion,
        criteria: { "": "Empty candidate", t1: "Research task" },
      })._tag,
    ).toBe("Left");
    expect(
      Schema.decodeUnknownEither(Domain.DecisionRequest)({
        ...decisionRequest,
        questions: { "": decisionQuestion, target: decisionQuestion },
      })._tag,
    ).toBe("Left");
    expect(
      Schema.decodeUnknownEither(Domain.DecisionAnswer)({
        ...decisionAnswer,
        probabilities: { "": 0, t1: 1 },
      })._tag,
    ).toBe("Left");
    expect(
      Schema.decodeUnknownEither(Domain.DecisionResponse)({
        ...decisionResponse,
        answers: { "": decisionAnswer, target: decisionAnswer },
      })._tag,
    ).toBe("Left");
  });

  it("accepts a recursive clarify card with a fully bound operation", () => {
    const nested = {
      ...card,
      options: [{ id: "clarify", label: "Choose again", op: { op: "clarify", card } }],
    };
    expect(Schema.encodeSync(Domain.Card)(Schema.decodeUnknownSync(Domain.Card)(nested))).toEqual(
      nested,
    );
  });

  it("accepts grouped answers and rejects duplicate or empty question answers", () => {
    expect(
      Schema.decodeUnknownEither(Domain.QuestionAnswer)({
        perQuestion: [perQuestion, { questionId: "notes", text: "Use the existing provider" }],
      })._tag,
    ).toBe("Right");
    for (const perQuestionValues of [
      [perQuestion, perQuestion],
      [{ questionId: "color", optionIds: [] }],
      [{ questionId: "color", text: "" }],
      [{ questionId: "color", optionIds: ["blue", "blue"] }],
    ]) {
      expect(
        Schema.decodeUnknownEither(Domain.QuestionAnswer)({ perQuestion: perQuestionValues })._tag,
      ).toBe("Left");
    }
  });

  it("keeps permission and question requests separate", () => {
    expect(
      Schema.decodeUnknownEither(Domain.SessionRequest)({
        ...request,
        kind: "permission",
        questions: [],
        permission,
      })._tag,
    ).toBe("Right");
    expect(
      Schema.decodeUnknownEither(Domain.SessionRequest)({
        ...request,
        kind: "permission",
        questions: [],
      })._tag,
    ).toBe("Left");
    expect(Schema.decodeUnknownEither(Domain.SessionRequest)({ ...request, permission })._tag).toBe(
      "Left",
    );
    expect(
      Schema.decodeUnknownEither(Domain.SessionRequest)({
        ...request,
        questions: [question, question],
      })._tag,
    ).toBe("Left");
  });

  it("rejects explicitly undefined optional fields", () => {
    expect(
      Schema.decodeUnknownEither(Config.ClassifierBackendConfig)({
        ...backend,
        apiKeyRef: undefined,
      })._tag,
    ).toBe("Left");
  });

  it("checks probability boundaries without constraining finite scores", () => {
    for (const noul of [0, 1])
      expect(Schema.decodeUnknownEither(Domain.DecisionAnswer)({ type: "noul", noul })._tag).toBe(
        "Right",
      );
    for (const noul of [-0.001, 1.001, NaN])
      expect(Schema.decodeUnknownEither(Domain.DecisionAnswer)({ type: "noul", noul })._tag).toBe(
        "Left",
      );
    expect(
      Schema.decodeUnknownEither(Domain.DecisionAnswer)({ type: "score", score: -123.5 })._tag,
    ).toBe("Right");
    const score = { type: "score", score: 1.5, probabilities: { "0": 0, "1": 0.5, "2": 0.5 } };
    expect(
      Schema.encodeSync(Domain.DecisionAnswer)(
        Schema.decodeUnknownSync(Domain.DecisionAnswer)(score),
      ),
    ).toEqual(score);
    expect(
      Schema.decodeUnknownEither(Domain.DecisionAnswer)({ ...score, probabilities: { "0": 1.1 } })
        ._tag,
    ).toBe("Left");
  });

  it("accepts every operation variant and rejects unsupported deliveries", () => {
    const variants = [
      { op: "new", botId: "b1", requestMessageIds: ["m1"] },
      { op: "ask", taskId: "t1", mode: "deep", messageId: "m1" },
      { op: "send", taskId: "t1", delivery: "steer", messageIds: ["m1"] },
      control,
      { op: "answer", requestId: "r1", answer },
      { op: "clarify", card },
      { op: "escalate", reason: "Ambiguous request", decisionLogId: "d1", messageIds: ["m1"] },
    ];
    for (const value of variants)
      expect(Schema.encodeSync(Domain.Op)(Schema.decodeUnknownSync(Domain.Op)(value))).toEqual(
        value,
      );
  });

  it("accepts all session event discriminants and rejects mismatched envelopes", () => {
    const events = [
      { kind: "turn.started", turnId: "turn-1" },
      { kind: "message.delta", turnId: "turn-1", text: "Working" },
      { kind: "turn.completed", turnId: "turn-1", ok: true, finalReport: "Done" },
      { kind: "turn.completed", turnId: "turn-1", ok: false, stopReason: "interrupted" },
      { kind: "turn.failed", turnId: "turn-1", error: "Failed" },
      { kind: "request.opened", request },
      { kind: "request.closed", requestId: "r1", reason: "answered" },
      { kind: "cursor.updated", cursor },
      { kind: "process.exited", code: null },
    ];
    for (const event of events) {
      const envelope = { source: "session", taskId: "t1", kind: event.kind, event };
      expect(
        Schema.encodeSync(Domain.AutEvent)(Schema.decodeUnknownSync(Domain.AutEvent)(envelope)),
      ).toEqual(envelope);
    }
  });

  it("cannot turn an interrupted completion into a successful report", () => {
    for (const event of [
      { kind: "turn.completed", turnId: "turn-1", finalReport: "Done" },
      { kind: "turn.completed", turnId: "turn-1", ok: false, finalReport: "Partial output" },
      {
        kind: "turn.completed",
        turnId: "turn-1",
        ok: false,
        stopReason: "interrupted",
        finalReport: "Partial output",
      },
      {
        kind: "turn.completed",
        turnId: "turn-1",
        ok: true,
        stopReason: "interrupted",
        finalReport: "Partial output",
      },
    ]) {
      expect(Schema.decodeUnknownEither(Domain.SessionEvent)(event)._tag).toBe("Left");
    }
  });

  it("round-trips fallback handoff excerpts without inventing relevance", () => {
    const input = {
      header: "Task",
      request: [],
      excerpts: [{ messageId: "m1", at: 1, author: "user", text: "Recent context" }],
      relatedTasks: [],
      toolHint: "Read by ID",
    };
    const value = Schema.decodeUnknownSync(Domain.HandoffPacket)(input);
    expect(Schema.encodeSync(Domain.HandoffPacket)(value)).toEqual(input);
    expect(Object.hasOwn(value.excerpts[0] ?? {}, "relevance")).toBe(false);
    expect(
      Schema.is(Domain.HandoffPacket)({
        ...input,
        excerpts: [{ ...input.excerpts[0], relevance: 1.1 }],
      }),
    ).toBe(false);
  });
});
