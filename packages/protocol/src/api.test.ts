import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import * as Api from "./api.js";

const message = { id: "m1", at: 1, author: "user", kind: "text", text: "Hello" };
const bot = {
  id: "b1",
  name: "Worker",
  description: "General work",
  soul: "",
  cwd: "/tmp/aut",
  modelSelection: { instanceId: "local", model: "model-1" },
};
const task = {
  id: "t1",
  botId: "b1",
  title: "Work",
  status: "created",
  createdAt: 1,
  updatedAt: 1,
  lastActivityAt: 1,
  session: { instanceId: "local" },
  pendingRequestIds: [],
  queue: [],
  origin: { kind: "user" },
};
const request = {
  id: "r1",
  taskId: "t1",
  kind: "question",
  openedAt: 1,
  raw: {},
  questions: [{ id: "q1", text: "Which color?", multiSelect: false, allowFreeText: true }],
};
const trigger = {
  id: "trigger-1",
  name: "Morning check",
  enabled: true,
  botId: "b1",
  prompt: "Run the morning check",
  payload: { source: "schedule" },
  schedule: { kind: "daily", at: "09:00", timeZone: "UTC" },
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
const cases: Record<string, { valid: unknown; invalid: unknown }> = {
  DaemonResource: { valid: "messages", invalid: "events" },
  ResourcesChanged: {
    valid: { type: "changed", resources: ["messages", "tasks"] },
    invalid: { type: "changed", resources: [] },
  },
  DaemonEvent: {
    valid: { type: "event", event: { source: "user", kind: "message", messageId: "m1" } },
    invalid: { type: "event", event: { source: "chief", kind: "reply" } },
  },
  SendMessageInput: { valid: { text: "Hello", id: "m1" }, invalid: { text: "" } },
  MessagePageInput: { valid: { before: "m1", limit: 50 }, invalid: { limit: 51 } },
  MessagePageResponse: { valid: { messages: [message] }, invalid: { messages: [{}] } },
  MessageResponse: { valid: { message }, invalid: { message: {} } },
  TaskListResponse: { valid: { tasks: [task] }, invalid: { tasks: [{}] } },
  TaskResponse: { valid: { task }, invalid: { task: {} } },
  TaskSessionInput: { valid: { before: "turn-2", limit: 20 }, invalid: { limit: 21 } },
  TaskSessionResponse: {
    valid: {
      task,
      history: { turns: [{ id: "turn-1", status: "completed", items: [] }] },
      availability: "available",
      hasEarlier: false,
    },
    invalid: { task, history: { turns: [] }, availability: "unknown", hasEarlier: false },
  },
  RequestResponse: { valid: { request }, invalid: { request: { ...request, questions: [] } } },
  ReportResponse: {
    valid: { ref: "event:report-1", text: "Original report" },
    invalid: { ref: "", text: "Missing reference" },
  },
  RouteTestInput: { valid: { text: "Route this request" }, invalid: { text: "" } },
  RouteTestResponse: {
    valid: {
      decisionLogId: "route-1",
      selectedBotId: "b1",
      probabilities: [{ botId: "b1", name: "Worker", probability: 1 }],
      backend: "jev",
      model: "jev-1.14.0",
    },
    invalid: {
      decisionLogId: "route-1",
      selectedBotId: "b1",
      probabilities: [{ botId: "b1", name: "Worker", probability: 1.5 }],
      backend: "jev",
      model: "jev-1.14.0",
    },
  },
  SecretName: { valid: "primary", invalid: "../escape" },
  SecretReference: { valid: "secret:primary", invalid: "secret:../escape" },
  SecretSaveInput: {
    valid: { name: "primary", key: "synthetic-key" },
    invalid: { name: "primary", key: " " },
  },
  SecretSaveResponse: {
    valid: { apiKeyRef: "secret:primary", configured: true },
    invalid: { apiKeyRef: "secret:primary", configured: false },
  },
  SecretStatusInput: { valid: { ref: "env:TYPESAFE_API_KEY" }, invalid: { ref: "file:/tmp/key" } },
  SecretStatusResponse: {
    valid: { apiKeyRef: "secret:primary", configured: false },
    invalid: { apiKeyRef: "secret:primary", configured: "yes" },
  },
  BotsResponse: { valid: { bots: [bot] }, invalid: { bots: [bot, bot] } },
  BotResponse: { valid: { bot }, invalid: { bot: { ...bot, id: "" } } },
  ConfigResponse: { valid: { harnessInstances: [] }, invalid: { harnessInstances: [{}] } },
  HealthResponse: { valid: { status: "ok" }, invalid: { status: "down" } },
  AcceptedResponse: { valid: { accepted: true }, invalid: { accepted: false } },
  DeletedResponse: { valid: { deleted: true }, invalid: { deleted: false } },
  CreateTriggerInput: {
    valid: {
      id: "trigger-morning",
      name: "Morning check",
      botId: "b1",
      prompt: "Run the morning check",
      payload: { source: "schedule" },
      schedule: { kind: "daily", at: "09:00", timeZone: "UTC" },
      enabled: true,
    },
    invalid: { name: "", botId: "b1", prompt: "Run", schedule: { kind: "once", at: -1 } },
  },
  UpdateTriggerInput: {
    valid: { enabled: false, prompt: "Run a different check" },
    invalid: { enabled: "no" },
  },
  TriggerResponse: { valid: { trigger }, invalid: { trigger: { ...trigger, id: "" } } },
  TriggersResponse: { valid: { triggers: [trigger] }, invalid: { triggers: [{}] } },
  TriggerRunsResponse: { valid: { runs: [triggerRun] }, invalid: { runs: [{}] } },
  ApiErrorResponse: {
    valid: { error: { code: "NotFound", message: "Not found" } },
    invalid: { error: { message: "Missing code" } },
  },
  McpServersResponse: {
    valid: { servers: [] },
    invalid: { servers: [{}] },
  },
  McpServerResponse: {
    valid: {
      server: {
        id: "mcp-1",
        name: "Calendar",
        transport: "http",
        url: "https://example.com/mcp",
        enabled: false,
        auth: { status: "none" },
        health: { status: "unknown" },
        tools: [],
      },
    },
    invalid: { server: { id: "mcp-1" } },
  },
  McpServerInputResponse: {
    valid: { name: "Calendar", transport: "stdio", command: "calendar-mcp", args: [] },
    invalid: { name: "Calendar", transport: "http", url: "ftp://example.com" },
  },
  McpGrantInput: {
    valid: { enabled: true, allowedTools: ["search"] },
    invalid: { enabled: "yes", allowedTools: [] },
  },
  McpGrantsResponse: {
    valid: { grants: [] },
    invalid: { grants: [{}] },
  },
  McpGrantResponse: {
    valid: { grant: { botId: "b1", serverId: "mcp-1", enabled: true, allowedTools: ["search"] } },
    invalid: { grant: { botId: "b1" } },
  },
  McpTestResponse: {
    valid: {
      server: {
        id: "mcp-1",
        name: "Calendar",
        transport: "http",
        url: "https://example.com/mcp",
        enabled: false,
        auth: { status: "none" },
        health: { status: "ready", checkedAt: 1 },
        tools: [],
      },
    },
    invalid: { server: { id: "mcp-1" } },
  },
  McpServerIdResponse: {
    valid: { serverId: "mcp-1" },
    invalid: { serverId: "" },
  },
  McpAuthStartResponse: {
    valid: { serverId: "mcp-1", authorizationUrl: "https://example.com/authorize", expiresAt: 1 },
    invalid: { serverId: "mcp-1", authorizationUrl: "ftp://example.com", expiresAt: 1 },
  },
};

describe("local API boundary schemas", () => {
  for (const [name, schema] of Object.entries(Api)) {
    if (!Schema.isSchema(schema)) continue;
    const boundary: Schema.Schema.AnyNoContext = schema;
    it(`${name} preserves a valid wire value and rejects invalid input`, () => {
      const fixture = cases[name];
      expect(fixture, `Missing fixture for ${name}`).toBeDefined();
      const decoded = Schema.decodeUnknownSync(boundary)(fixture?.valid);
      const encoded = Schema.encodeSync(boundary)(decoded);
      expect(JSON.parse(JSON.stringify(encoded))).toEqual(fixture?.valid);
      expect(Schema.decodeUnknownEither(boundary)(fixture?.invalid)._tag).toBe("Left");
    });
  }

  it("rejects an answer body without confirmed native question delivery", () => {
    const deliveredAnswer = { perQuestion: [{ questionId: "q1", text: "Blue" }] };
    const read = Schema.decodeUnknownEither(Api.RequestResponse);
    for (const answerState of [undefined, "registered", "submitting", "queued", "indeterminate"]) {
      expect(read({ request, answerState, deliveredAnswer })._tag).toBe("Left");
    }
    const permission = {
      ...request,
      kind: "permission",
      questions: [],
      permission: { tool: "read", summary: "Read" },
    };
    expect(read({ request: permission, answerState: "delivered", deliveredAnswer })._tag).toBe(
      "Left",
    );
    const confirmed = { request, answerState: "delivered", deliveredAnswer };
    expect(Schema.decodeUnknownSync(Api.RequestResponse)(confirmed)).toEqual(confirmed);
    expect(read({ request, answerState: "delivered" })._tag).toBe("Right");
  });

  it("validates changed frames and rejects duplicate or unknown resources", () => {
    const value = { type: "changed", resources: ["requests", "bots", "config"] };
    expect(Schema.decodeUnknownSync(Api.DaemonEvent)(value)).toEqual(value);
    for (const resources of [[], ["messages", "messages"], ["events"]])
      expect(Schema.decodeUnknownEither(Api.DaemonEvent)({ type: "changed", resources })._tag).toBe(
        "Left",
      );
  });

  it.each([0, -1, 1.5, 51, Number.POSITIVE_INFINITY])("rejects page limit %s", (limit) => {
    expect(Schema.decodeUnknownEither(Api.MessagePageInput)({ limit })._tag).toBe("Left");
  });

  it.each([0, -1, 1.5, 21, Number.POSITIVE_INFINITY])(
    "rejects session turn-page limit %s",
    (limit) => {
      expect(Schema.decodeUnknownEither(Api.TaskSessionInput)({ limit })._tag).toBe("Left");
    },
  );

  it.each(["available", "pending", "unsupported", "unavailable"])(
    "preserves session availability %s",
    (availability) => {
      const response = {
        task,
        history: { turns: [] },
        availability,
        hasEarlier: true,
        nextBefore: "turn-3",
        message: "Fixture",
      };
      expect(Schema.decodeUnknownSync(Api.TaskSessionResponse)(response)).toEqual(response);
    },
  );
});
