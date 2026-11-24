import { Schema } from "effect";
import {
  BotId,
  FiniteNumber,
  HttpUrl,
  JsonRecord,
  JsonValue,
  MessageId,
  NonEmptyString,
  NonNegativeInteger,
  NonNegativeNumber,
  optional,
  PositiveInteger,
  Probability,
  RequestId,
  TaskId,
  Timestamp,
  TriggerId,
  TriggerRunId,
  uniqueBy,
} from "./common.js";
import { BotConfig, McpServerConfig } from "./config.js";
import { FileIds, FileIssues, MessageFileList } from "./files.js";

export const ControlAction = Schema.Literal("cancel", "retry", "resume", "archive");
export type ControlAction = typeof ControlAction.Type;
export const TaskStatus = Schema.Literal(
  "created",
  "running",
  "waiting_user",
  "reporting",
  "idle",
  "failed",
  "interrupted",
  "cancelled",
  "archived",
);
export type TaskStatus = typeof TaskStatus.Type;

export const ResumeCursor = Schema.Struct({ kind: NonEmptyString, data: JsonValue });
export type ResumeCursor = typeof ResumeCursor.Type;
export const TurnInput = Schema.Struct({
  text: Schema.String,
  messageIds: Schema.Array(MessageId),
});
export type TurnInput = typeof TurnInput.Type;
export const TranscriptEntry = Schema.Struct({
  role: Schema.Literal("user", "assistant", "tool", "system"),
  text: Schema.String,
  at: optional(Timestamp),
  turnId: optional(NonEmptyString),
});
export type TranscriptEntry = typeof TranscriptEntry.Type;

export const QuestionOption = Schema.Struct({
  id: NonEmptyString,
  label: NonEmptyString,
  description: optional(Schema.String),
});
export type QuestionOption = typeof QuestionOption.Type;
export const Question = Schema.Struct({
  id: NonEmptyString,
  text: NonEmptyString,
  options: optional(
    Schema.Array(QuestionOption).pipe(
      Schema.filter((options) => uniqueBy(options, (option) => option.id)),
    ),
  ),
  multiSelect: Schema.Boolean,
  allowFreeText: Schema.Boolean,
});
export type Question = typeof Question.Type;
export const Questions = Schema.Array(Question).pipe(
  Schema.minItems(1),
  Schema.filter((questions) => uniqueBy(questions, (question) => question.id)),
);
export type Questions = typeof Questions.Type;

export const PerQuestionAnswer = Schema.Struct({
  questionId: NonEmptyString,
  optionIds: optional(
    Schema.Array(NonEmptyString).pipe(Schema.filter((ids) => new Set(ids).size === ids.length)),
  ),
  text: optional(NonEmptyString),
}).pipe(
  Schema.filter((answer) => (answer.optionIds?.length ?? 0) > 0 || (answer.text?.length ?? 0) > 0),
);
export type PerQuestionAnswer = typeof PerQuestionAnswer.Type;
export const QuestionAnswer = Schema.Struct({
  perQuestion: Schema.Array(PerQuestionAnswer).pipe(
    Schema.minItems(1),
    Schema.filter((answers) => uniqueBy(answers, (answer) => answer.questionId)),
  ),
});
export type QuestionAnswer = typeof QuestionAnswer.Type;
export const Permission = Schema.Struct({ tool: NonEmptyString, summary: Schema.String });
export type Permission = typeof Permission.Type;
const requestFields = { id: RequestId, taskId: TaskId, openedAt: Timestamp, raw: JsonValue };
export const SessionRequest = Schema.Union(
  Schema.Struct({
    ...requestFields,
    kind: Schema.Literal("question"),
    questions: Questions,
    permission: optional(Schema.Never),
  }),
  Schema.Struct({
    ...requestFields,
    kind: Schema.Literal("permission"),
    questions: Schema.Array(Question).pipe(Schema.filter((questions) => questions.length === 0)),
    permission: Permission,
  }),
);
export type SessionRequest = typeof SessionRequest.Type;

export const ProposableOp = Schema.Union(
  Schema.Struct({
    op: Schema.Literal("new"),
    botId: BotId,
    requestMessageIds: Schema.Array(MessageId),
  }),
  Schema.Struct({
    op: Schema.Literal("ask"),
    taskId: TaskId,
    mode: Schema.Literal("fast", "deep"),
    messageId: MessageId,
  }),
  Schema.Struct({
    op: Schema.Literal("send"),
    taskId: TaskId,
    delivery: Schema.Literal("immediate", "queue", "steer", "restart"),
    messageIds: Schema.Array(MessageId),
  }),
  Schema.Struct({ op: Schema.Literal("control"), taskId: TaskId, action: ControlAction }),
  Schema.Struct({ op: Schema.Literal("answer"), requestId: RequestId, answer: QuestionAnswer }),
);
export type ProposableOp = typeof ProposableOp.Type;
const TriggerOp = Schema.Struct({
  op: Schema.Literal("new-trigger"),
  triggerId: TriggerId,
  runId: TriggerRunId,
  occurrenceKey: NonEmptyString,
  scheduledAt: Timestamp,
  botId: BotId,
  prompt: NonEmptyString,
  payload: JsonValue,
});
const EscalateOp = Schema.Struct({
  op: Schema.Literal("escalate"),
  reason: NonEmptyString,
  decisionLogId: NonEmptyString,
  messageIds: Schema.Array(MessageId),
});
const CardFields = Schema.Struct({
  id: NonEmptyString,
  prompt: Schema.String,
  multiSelect: Schema.Boolean,
  allowFreeText: Schema.Boolean,
  requestId: optional(RequestId),
  state: Schema.Literal("open", "answered", "expired"),
});
const CardOptionFields = Schema.Struct({ id: NonEmptyString, label: NonEmptyString });

// Only recursive edges need explicit declarations; all other fields derive from the schemas above.
export type Op =
  | typeof ProposableOp.Type
  | typeof TriggerOp.Type
  | typeof EscalateOp.Type
  | { readonly op: "clarify"; readonly card: Card };
type OpEncoded =
  | Schema.Schema.Encoded<typeof ProposableOp>
  | Schema.Schema.Encoded<typeof TriggerOp>
  | Schema.Schema.Encoded<typeof EscalateOp>
  | { readonly op: "clarify"; readonly card: CardEncoded };
export type CardOption = typeof CardOptionFields.Type & { readonly op?: Op };
type CardOptionEncoded = Schema.Schema.Encoded<typeof CardOptionFields> & {
  readonly op?: OpEncoded;
};
export type Card = typeof CardFields.Type & { readonly options: readonly CardOption[] };
type CardEncoded = Schema.Schema.Encoded<typeof CardFields> & {
  readonly options: readonly CardOptionEncoded[];
};

export const CardOption: Schema.Schema<CardOption, CardOptionEncoded> = Schema.Struct({
  ...CardOptionFields.fields,
  op: optional(Schema.suspend((): Schema.Schema<Op, OpEncoded> => Op)),
});
export const Card: Schema.Schema<Card, CardEncoded> = Schema.Struct({
  ...CardFields.fields,
  options: Schema.Array(CardOption).pipe(
    Schema.filter((options) => uniqueBy(options, (option) => option.id)),
  ),
});
export const Op: Schema.Schema<Op, OpEncoded> = Schema.Union(
  ProposableOp,
  TriggerOp,
  EscalateOp,
  Schema.Struct({ op: Schema.Literal("clarify"), card: Card }),
);

export const DispatchChange = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("undo") }),
  Schema.Struct({ kind: Schema.Literal("reroute"), botId: BotId }),
);
export type DispatchChange = typeof DispatchChange.Type;
export const UiAction = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("correct-dispatch"),
    decisionLogId: NonEmptyString,
    change: DispatchChange,
  }),
  Schema.Struct({
    type: Schema.Literal("card-choice"),
    cardId: NonEmptyString,
    optionId: NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("question-answer"),
    cardId: NonEmptyString,
    requestId: RequestId,
    answer: QuestionAnswer,
  }),
  Schema.Struct({
    type: Schema.Literal("quote-reply"),
    quotedMessageId: MessageId,
    text: Schema.String,
    fileIds: optional(FileIds),
  }),
  Schema.Struct({ type: Schema.Literal("task-control"), taskId: TaskId, action: ControlAction }),
);
export type UiAction = typeof UiAction.Type;
export const MessageAuthor = Schema.Union(
  Schema.Literal("user", "chief"),
  Schema.Struct({ botId: BotId, taskId: TaskId }),
);
export type MessageAuthor = typeof MessageAuthor.Type;
export const BotCreationReceipt = Schema.Struct({
  botId: BotId,
  status: Schema.Literal("available", "undone", "changed", "used", "removed"),
});
export type BotCreationReceipt = typeof BotCreationReceipt.Type;
export const ReportSource = Schema.Struct({
  url: HttpUrl.pipe(
    Schema.filter((value) => {
      const parsed = Schema.decodeUnknownOption(Schema.URL)(value);
      return parsed._tag === "Some" && !parsed.value.username && !parsed.value.password;
    }),
  ),
  label: NonEmptyString.pipe(Schema.filter((value) => Array.from(value).length <= 120)),
});
export type ReportSource = typeof ReportSource.Type;
export const ReportSources = Schema.Array(ReportSource).pipe(
  Schema.maxItems(32),
  Schema.filter((sources) => uniqueBy(sources, (source) => source.url)),
);
export const MainThreadMessage = Schema.Struct({
  id: MessageId,
  at: Timestamp,
  author: MessageAuthor,
  kind: Schema.Literal("text", "ack", "reply", "question-card", "clarify-card", "notice"),
  text: Schema.String,
  taskId: optional(TaskId),
  card: optional(Card),
  fullReportRef: optional(NonEmptyString),
  sources: optional(ReportSources),
  files: optional(MessageFileList),
  fileIssues: optional(FileIssues),
  botCreation: optional(BotCreationReceipt),
  dispatch: optional(
    Schema.Struct({
      botId: BotId,
      canUndo: Schema.Boolean,
      status: Schema.Literal("open", "undo", "reroute", "corrected"),
    }),
  ),
  decisionLogId: optional(NonEmptyString),
});
export type MainThreadMessage = typeof MainThreadMessage.Type;

export const Task = Schema.Struct({
  id: TaskId,
  botId: BotId,
  title: Schema.String,
  status: TaskStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastActivityAt: Timestamp,
  session: Schema.Struct({ instanceId: NonEmptyString, cursor: optional(ResumeCursor) }),
  pendingRequestIds: Schema.Array(RequestId).pipe(
    Schema.filter((ids) => new Set(ids).size === ids.length),
  ),
  lastReport: optional(
    Schema.Struct({
      full: Schema.String,
      delivered: Schema.String,
      rewrites: NonNegativeInteger.pipe(Schema.lessThanOrEqualTo(2)),
    }),
  ),
  queue: Schema.Array(Schema.Struct({ messageIds: Schema.Array(MessageId), queuedAt: Timestamp })),
  origin: Schema.Union(
    Schema.Struct({
      kind: Schema.Literal("user", "trigger"),
      decisionLogId: optional(NonEmptyString),
    }),
    Schema.Struct({ kind: Schema.Literal("coordination"), decisionLogId: NonEmptyString }),
  ),
});
export type Task = typeof Task.Type;

export const TriggerSchedule = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("once"), at: Timestamp }),
  Schema.Struct({
    kind: Schema.Literal("interval"),
    startAt: Timestamp,
    everyMs: PositiveInteger,
  }),
  Schema.Struct({
    kind: Schema.Literal("daily"),
    at: Schema.String.pipe(Schema.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)),
    timeZone: optional(NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("cron"),
    expression: NonEmptyString,
    timeZone: optional(NonEmptyString),
  }),
);
export type TriggerSchedule = typeof TriggerSchedule.Type;
export const Trigger = Schema.Struct({
  id: TriggerId,
  name: NonEmptyString,
  enabled: Schema.Boolean,
  botId: BotId,
  prompt: NonEmptyString,
  payload: JsonValue,
  schedule: TriggerSchedule,
  overlap: Schema.Literal("skip"),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  nextAt: optional(Timestamp),
});
export type Trigger = typeof Trigger.Type;
export const TriggerRun = Schema.Struct({
  id: TriggerRunId,
  triggerId: TriggerId,
  occurrenceKey: NonEmptyString,
  scheduledAt: Timestamp,
  status: Schema.Literal("queued", "running", "ran", "failed", "missed", "skipped"),
  taskId: optional(TaskId),
  startedAt: optional(Timestamp),
  finishedAt: optional(Timestamp),
  error: optional(Schema.String),
});
export type TriggerRun = typeof TriggerRun.Type;
export const AdapterCapabilities = Schema.Struct({
  resume: Schema.Boolean,
  fork: Schema.Boolean,
  steer: Schema.Boolean,
  nativeFullAccess: Schema.Boolean,
  questions: Schema.Struct({
    native: Schema.Boolean,
    multiQuestion: Schema.Boolean,
    multiSelect: Schema.Boolean,
    freeText: Schema.Boolean,
  }),
  transcript: Schema.Boolean,
  sessionHistory: optional(Schema.Boolean),
  sessionContext: optional(Schema.Boolean),
});
export type AdapterCapabilities = typeof AdapterCapabilities.Type;
export const StartSessionInput = Schema.Struct({
  taskId: TaskId,
  bot: BotConfig,
  model: NonEmptyString,
  effort: optional(NonEmptyString),
  cwd: NonEmptyString,
  instructions: Schema.String,
  mcpServers: Schema.Array(McpServerConfig),
});
export type StartSessionInput = typeof StartSessionInput.Type;

export const SessionEvent = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("turn.started"), turnId: NonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("session.changed"),
    turnId: NonEmptyString,
    itemId: optional(NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("message.delta"),
    turnId: NonEmptyString,
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("turn.completed"),
    turnId: NonEmptyString,
    ok: Schema.Literal(true),
    finalReport: Schema.String,
    stopReason: optional(Schema.Never),
  }),
  Schema.Struct({
    kind: Schema.Literal("turn.completed"),
    turnId: NonEmptyString,
    ok: Schema.Literal(false),
    stopReason: Schema.Literal("interrupted"),
    finalReport: optional(Schema.Never),
  }),
  Schema.Struct({
    kind: Schema.Literal("turn.failed"),
    turnId: NonEmptyString,
    error: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("request.opened"), request: SessionRequest }),
  Schema.Struct({
    kind: Schema.Literal("request.closed"),
    requestId: RequestId,
    reason: Schema.Literal("answered", "turn-ended", "cancelled"),
  }),
  Schema.Struct({ kind: Schema.Literal("cursor.updated"), cursor: ResumeCursor }),
  Schema.Struct({ kind: Schema.Literal("process.exited"), code: Schema.NullOr(Schema.Int) }),
);
export type SessionEvent = typeof SessionEvent.Type;
const SessionAutEvent = Schema.Union(
  ...SessionEvent.members.map((event) =>
    Schema.Struct({
      source: Schema.Literal("session"),
      kind: event.fields.kind,
      taskId: TaskId,
      event,
    }),
  ),
).pipe(Schema.filter((event) => event.kind === event.event.kind));
export const AutEvent = Schema.Union(
  Schema.Struct({
    source: Schema.Literal("user"),
    kind: Schema.Literal("message"),
    messageId: MessageId,
  }),
  Schema.Struct({
    source: Schema.Literal("user"),
    kind: Schema.Literal("ui-action"),
    action: UiAction,
  }),
  SessionAutEvent,
  Schema.Struct({
    source: Schema.Literal("trigger"),
    kind: Schema.Literal("fired"),
    triggerId: TriggerId,
    payload: JsonValue,
    runId: optional(TriggerRunId),
    occurrenceKey: optional(NonEmptyString),
    scheduledAt: optional(Timestamp),
    botId: optional(BotId),
    prompt: optional(NonEmptyString),
  }),
);
export type AutEvent = typeof AutEvent.Type;

const namedRecord = <S extends Schema.Schema.All>(value: S) =>
  Schema.Record({ key: Schema.String, value }).pipe(
    Schema.filter((record) => Object.keys(record).every((key) => key.length > 0)),
  );

export const DecisionQuestion = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("choice"),
    instructions: NonEmptyString,
    criteria: namedRecord(NonEmptyString).pipe(
      Schema.filter((criteria) => Object.keys(criteria).length > 0),
    ),
  }),
  Schema.Struct({ type: Schema.Literal("noul"), instructions: NonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("score"),
    instructions: NonEmptyString,
    criteria: Schema.Array(NonEmptyString).pipe(Schema.minItems(1)),
  }),
);
export type DecisionQuestion = typeof DecisionQuestion.Type;
export const DecisionRequest = Schema.Struct({
  state: Schema.Union(JsonRecord, Schema.String),
  questions: namedRecord(DecisionQuestion).pipe(
    Schema.filter((questions) => Object.keys(questions).length > 0),
  ),
});
export type DecisionRequest = typeof DecisionRequest.Type;
export const DecisionAnswer = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: NonEmptyString,
    confidence: Probability,
    probabilities: namedRecord(Probability),
  }).pipe(Schema.filter((answer) => Object.hasOwn(answer.probabilities, answer.choice))),
  Schema.Struct({ type: Schema.Literal("noul"), noul: Probability }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: FiniteNumber,
    probabilities: optional(namedRecord(Probability)),
  }),
);
export type DecisionAnswer = typeof DecisionAnswer.Type;
export const DecisionResponse = Schema.Struct({
  answers: namedRecord(DecisionAnswer),
  latencyMs: NonNegativeNumber,
  usage: optional(
    Schema.Struct({ inputTokens: NonNegativeInteger, cost: optional(NonNegativeNumber) }),
  ),
});
export type DecisionResponse = typeof DecisionResponse.Type;

/** Per-delivery input with selected main-thread excerpts, not a session summary. */
export const HandoffPacket = Schema.Struct({
  header: Schema.String,
  request: Schema.Array(
    Schema.Struct({
      messageId: MessageId,
      at: Timestamp,
      text: Schema.String,
      files: optional(MessageFileList),
    }),
  ),
  excerpts: Schema.Array(
    Schema.Struct({
      messageId: MessageId,
      at: Timestamp,
      author: Schema.String,
      text: Schema.String,
      relevance: optional(Probability),
    }),
  ),
  relatedTasks: Schema.Array(
    Schema.Struct({ taskId: TaskId, bot: Schema.String, status: TaskStatus, title: Schema.String }),
  ),
  toolHint: Schema.String,
  decisionSummary: optional(Schema.String),
});
export type HandoffPacket = typeof HandoffPacket.Type;
export const DecisionOutput = Schema.Union(
  Op,
  Schema.Struct({ gate: Schema.Literal("deliver", "rewrite", "truncate") }),
  Schema.Struct({ request: Schema.Literal("allow", "relay") }),
  Schema.Struct({ excerpts: Schema.Array(MessageId) }),
);
export type DecisionOutput = typeof DecisionOutput.Type;
export const DecisionCorrection = Schema.Struct({
  at: Timestamp,
  kind: Schema.Literal("clarify-none", "undo", "reroute", "manual"),
  decisionLogId: optional(NonEmptyString),
  detail: optional(Schema.String),
});
export type DecisionCorrection = typeof DecisionCorrection.Type;
export const DecisionLog = Schema.Struct({
  id: NonEmptyString,
  at: Timestamp,
  tree: Schema.Literal("inbound", "trigger", "reply-gate", "request", "handoff-prune"),
  treeVersion: NonEmptyString,
  input: Schema.Struct({
    eventRef: NonEmptyString,
    state: JsonValue,
    dynamicOptions: Schema.Record({
      key: Schema.String,
      value: Schema.Record({ key: Schema.String, value: Schema.String }),
    }),
  }),
  classifierCalls: Schema.Array(
    Schema.Struct({
      backend: NonEmptyString,
      model: NonEmptyString,
      request: DecisionRequest,
      response: optional(DecisionResponse),
      error: optional(Schema.String),
      latencyMs: NonNegativeNumber,
    }),
  ),
  path: Schema.Array(NonEmptyString),
  output: optional(DecisionOutput),
  execution: Schema.Struct({
    ok: Schema.Boolean,
    error: optional(Schema.String),
    degraded: optional(Schema.Array(Schema.String)),
  }),
  correction: optional(DecisionCorrection),
}).pipe(Schema.filter((log) => !log.execution.ok || log.output !== undefined));
export type DecisionLog = typeof DecisionLog.Type;
