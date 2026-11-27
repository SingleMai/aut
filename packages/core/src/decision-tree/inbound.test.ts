import { Classifier } from "@aut/classifier/interface";
import {
  BotId,
  ClassifierError,
  type DecisionAnswer,
  type DecisionRequest,
  type DecisionResponse,
  type DecisionLog as LogRecord,
  MessageId,
  Op,
  RequestId,
  TaskId,
  Timestamp,
  TreeConfig,
} from "@aut/protocol";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { InboundState } from "../chief/ports.js";
import { DecisionLog } from "../decision-log.js";
import { DecisionTree, DecisionTreeLive } from "./engine.js";
import { inboundV1 } from "./inbound.js";

const base: InboundState = {
  message: "继续处理这个任务",
  messageId: MessageId.make("m"),
  messageIds: [MessageId.make("m")],
  uiAction: null,
  selectedOp: null,
  fixedTargetId: null,
  primaryBotId: BotId.make("aut"),
  bots: [
    { id: BotId.make("aut"), name: "General", description: "General purpose tasks." },
    { id: BotId.make("research"), name: "Research", description: "Research and comparison." },
  ],
  taskCandidates: [
    {
      id: TaskId.make("t1"),
      title: "Current task",
      status: "running",
      description: "Research task; running; created 2 hours ago; most recent.",
    },
    {
      id: TaskId.make("t2"),
      title: "Second task",
      status: "idle",
      description: "Writing task; idle; created 1 day ago; second most recent.",
    },
  ],
  olderTasks: [
    {
      id: TaskId.make("old"),
      title: "Older task",
      status: "archived",
      description: "Archived research task.",
    },
  ],
  pendingRequests: [
    {
      id: RequestId.make("r1"),
      taskId: TaskId.make("t1"),
      kind: "question",
      questions: [{ id: "q1", text: "Which direction?", multiSelect: false, allowFreeText: true }],
      openedAt: Timestamp.make(1),
      raw: {},
    },
    {
      id: RequestId.make("r2"),
      taskId: TaskId.make("t2"),
      kind: "question",
      questions: [{ id: "q2", text: "Which format?", multiSelect: false, allowFreeText: true }],
      openedAt: Timestamp.make(2),
      raw: {},
    },
  ],
  recentMessages: [],
};
interface Answers {
  readonly op?: string;
  readonly opP?: number;
  readonly bot?: string;
  readonly botP?: number;
  readonly target?: string;
  readonly targetP?: number;
  readonly pending?: string;
  readonly pendingP?: number;
  readonly control?: string;
  readonly controlP?: number;
  readonly delivery?: string;
  readonly deliveryP?: number;
  readonly statusOnly?: number;
  readonly multiIntent?: number;
}
const answer = (request: DecisionRequest, values: Answers): DecisionResponse => {
  const choices: Record<string, string> = {
    op: values.op ?? "new_work",
    bot: values.bot ?? "research",
    target: values.target ?? "t1",
    pending: values.pending ?? "r1",
    control: values.control ?? "cancel",
    delivery: values.delivery ?? "queue",
  };
  const probabilities: Record<string, number> = {
    op: values.opP ?? 0.9,
    bot: values.botP ?? 0.9,
    target: values.targetP ?? 0.9,
    pending: values.pendingP ?? 0.9,
    control: values.controlP ?? 0.9,
    delivery: values.deliveryP ?? 0.9,
  };
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    if (question.type === "noul") {
      answers[id] = {
        type: "noul",
        noul: id === "multi_intent" ? (values.multiIntent ?? 0.1) : (values.statusOnly ?? 0.9),
      };
      continue;
    }
    if (question.type !== "choice") continue;
    const keys = Object.keys(question.criteria);
    const selected = choices[id] ?? keys[0] ?? "";
    const probability = keys.length === 1 ? 1 : (probabilities[id] ?? 0.9);
    answers[id] = {
      type: "choice",
      choice: selected,
      confidence: probability,
      probabilities: Object.fromEntries(
        keys.map((key) => [
          key,
          key === selected ? probability : (1 - probability) / (keys.length - 1),
        ]),
      ),
    };
  }
  return { answers, latencyMs: 1 };
};

const runDecision = async (values: Answers, state: InboundState, unavailable: boolean) => {
  const logs: LogRecord[] = [];
  const requests: DecisionRequest[] = [];
  const dependencies = Layer.merge(
    Layer.succeed(Classifier, {
      backend: "fixture",
      model: "fixture-1",
      decide: (request) => {
        requests.push(request);
        return unavailable
          ? Effect.fail(
              new ClassifierError({
                code: "TransportError",
                message: "Synthetic unavailable backend",
              }),
            )
          : Effect.succeed(answer(request, values));
      },
    }),
    Layer.succeed(DecisionLog, {
      write: (log) =>
        Effect.sync(() => {
          logs.push(log);
          return log;
        }),
      get: () => Effect.succeed(Option.none()),
      correct: () => Effect.die("Unused"),
      complete: () => Effect.die("Unused"),
    }),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* DecisionTree).run(inboundV1, {
        id: "fixture-log",
        eventRef: "fixture-event",
        state,
      });
    }).pipe(Effect.provide(DecisionTreeLive().pipe(Layer.provide(dependencies))), Effect.either),
  );
  return { result, logs, requests };
};

const run = async (values: Answers = {}, state: InboundState = base) => {
  const { result, logs, requests } = await runDecision(values, state, false);
  if (result._tag === "Left") throw result.left;
  return { op: Schema.decodeUnknownSync(Op)(result.right.output), logs, requests };
};

describe("inbound v1 branch fixtures", () => {
  it("round-trips the full data-only tree configuration", () => {
    expect(Schema.decodeUnknownSync(TreeConfig)(JSON.parse(JSON.stringify(inboundV1)))).toEqual(
      inboundV1,
    );
  });

  const fixtures: readonly { name: string; values: Answers; expected: object }[] = [
    {
      name: "new work chooses the classified bot",
      values: {},
      expected: { op: "new", botId: "research" },
    },
    {
      name: "bot threshold includes 0.6",
      values: { botP: 0.6 },
      expected: { op: "new", botId: "research" },
    },
    {
      name: "bot below 0.6 uses the primary assistant",
      values: { botP: 0.599 },
      expected: { op: "new", botId: "aut" },
    },
    {
      name: "multi-intent boundary enters slow",
      values: { multiIntent: 0.5 },
      expected: { op: "escalate" },
    },
    {
      name: "single intent below boundary stays fast",
      values: { multiIntent: 0.499 },
      expected: { op: "new" },
    },
    { name: "op below 0.4 enters slow", values: { opP: 0.399 }, expected: { op: "escalate" } },
    { name: "op at 0.4 clarifies", values: { opP: 0.4 }, expected: { op: "clarify" } },
    {
      name: "the discussion option opens a coordination task on the primary assistant",
      values: { op: "other", opP: 0.5 },
      expected: {
        op: "clarify",
        card: {
          options: expect.arrayContaining([
            expect.objectContaining({
              id: "other",
              label: "和主助手讨论",
              op: expect.objectContaining({ op: "escalate" }),
            }),
          ]),
        },
      },
    },
    { name: "op below 0.6 clarifies", values: { opP: 0.599 }, expected: { op: "clarify" } },
    { name: "op at 0.6 acts", values: { opP: 0.6 }, expected: { op: "new" } },
    { name: "other enters slow", values: { op: "other" }, expected: { op: "escalate" } },
    {
      name: "pending at 0.6 answers",
      values: { op: "answer_pending", pendingP: 0.6 },
      expected: {
        op: "answer",
        requestId: "r1",
        answer: { perQuestion: [{ questionId: "q1", text: base.message }] },
      },
    },
    {
      name: "pending below 0.6 clarifies",
      values: { op: "answer_pending", pendingP: 0.599 },
      expected: { op: "clarify" },
    },
    {
      name: "progress target at 0.8 uses fast status",
      values: { op: "ask_progress", targetP: 0.8, statusOnly: 0.6 },
      expected: { op: "ask", mode: "fast", taskId: "t1" },
    },
    {
      name: "content questions use deep ask",
      values: { op: "ask_progress", statusOnly: 0.599 },
      expected: { op: "ask", mode: "deep" },
    },
    {
      name: "progress target below 0.8 clarifies",
      values: { op: "ask_progress", targetP: 0.799 },
      expected: { op: "clarify" },
    },
    {
      name: "talk target at 0.8 queues running work",
      values: { op: "talk_to_task", targetP: 0.8 },
      expected: { op: "send", delivery: "queue", taskId: "t1" },
    },
    {
      name: "talk target below 0.8 clarifies",
      values: { op: "talk_to_task", targetP: 0.799 },
      expected: { op: "clarify" },
    },
    {
      name: "steer is explicit",
      values: { op: "talk_to_task", delivery: "steer" },
      expected: { op: "send", delivery: "steer" },
    },
    {
      name: "restart is explicit",
      values: { op: "talk_to_task", delivery: "restart" },
      expected: { op: "send", delivery: "restart" },
    },
    {
      name: "idle target sends immediately",
      values: { op: "talk_to_task", target: "t2", delivery: "restart" },
      expected: { op: "send", delivery: "immediate", taskId: "t2" },
    },
    {
      name: "destructive target and control at boundaries act",
      values: { op: "control_task", targetP: 0.85, controlP: 0.8 },
      expected: { op: "control", action: "cancel", taskId: "t1" },
    },
    {
      name: "destructive target below threshold clarifies",
      values: { op: "control_task", targetP: 0.849 },
      expected: { op: "clarify" },
    },
    {
      name: "control below threshold clarifies",
      values: { op: "control_task", controlP: 0.799 },
      expected: { op: "clarify" },
    },
    {
      name: "offers an explicit turn restart when a running task cannot be retried",
      values: { op: "control_task", control: "retry", delivery: "restart", deliveryP: 0.8 },
      expected: {
        op: "clarify",
        card: {
          options: [
            {
              id: "restart",
              op: { op: "send", delivery: "restart", taskId: "t1", messageIds: ["m"] },
            },
            { id: "none" },
          ],
        },
      },
    },
    {
      name: "a weak restart guess does not offer the turn restart",
      values: {
        op: "control_task",
        control: "resume",
        controlP: 0.7,
        delivery: "restart",
        deliveryP: 0.799,
      },
      expected: {
        op: "clarify",
        card: { options: [{ op: { op: "control", action: "resume" } }, { id: "none" }] },
      },
    },
    ...(["retry", "resume", "archive"] as const).map((control) => ({
      name: `control ${control}`,
      values: { op: "control_task", control },
      expected: { op: "control", action: control },
    })),
    {
      name: "none target cannot become an invalid task Op",
      values: { op: "talk_to_task", target: "none" },
      expected: { op: "clarify" },
    },
    {
      name: "older target exposes real older tasks",
      values: { op: "ask_progress", target: "older_task" },
      expected: {
        op: "clarify",
        card: {
          options: [
            { id: "old", op: { op: "ask", taskId: "old" } },
            { id: "none", op: { op: "escalate" } },
          ],
        },
      },
    },
  ];
  for (const fixture of fixtures)
    it(fixture.name, async () => {
      const result = await run(fixture.values);
      expect(result.op).toMatchObject(fixture.expected);
      expect(result.requests).toHaveLength(1);
      expect(result.logs[0]?.input.dynamicOptions["classify.target"]).toHaveProperty("older_task");
      expect(result.logs[0]?.classifierCalls[0]?.response).toBeDefined();
      if (result.op.op === "clarify") {
        expect(
          result.op.card.options.every((option) => option.op && Schema.is(Op)(option.op)),
        ).toBe(true);
        expect(result.op.card.options.at(-1)?.op?.op).toBe("escalate");
      }
    });

  it("bypasses classification for trusted card operations and all structured UI actions", async () => {
    const selected: Op = {
      op: "send",
      taskId: TaskId.make("t1"),
      delivery: "queue",
      messageIds: [MessageId.make("original")],
    };
    for (const [state, expected] of [
      [{ ...base, selectedOp: selected }, selected],
      [
        {
          ...base,
          selectedOp: {
            op: "escalate",
            reason: "None",
            decisionLogId: "old-log",
            messageIds: [MessageId.make("m")],
          },
        },
        { op: "escalate", decisionLogId: "fixture-log" },
      ],
      [
        {
          ...base,
          uiAction: { type: "task-control", taskId: TaskId.make("t2"), action: "archive" },
        },
        { op: "control", taskId: "t2", action: "archive" },
      ],
      [
        {
          ...base,
          uiAction: {
            type: "question-answer",
            cardId: "card",
            requestId: RequestId.make("r1"),
            answer: { perQuestion: [{ questionId: "q1", text: "Blue" }] },
          },
        },
        { op: "answer", requestId: "r1" },
      ],
    ] as const) {
      const result = await run({}, state);
      expect(result.op).toMatchObject(expected);
      expect(result.requests).toEqual([]);
    }
  });

  it("omits target when quoting and omits pending questions when none exist", async () => {
    const result = await run(
      { op: "talk_to_task" },
      { ...base, fixedTargetId: TaskId.make("t2"), pendingRequests: [] },
    );
    expect(result.op).toMatchObject({ op: "send", taskId: "t2", delivery: "immediate" });
    expect(result.requests[0]?.questions.target).toBeUndefined();
    expect(result.requests[0]?.questions.pending).toBeUndefined();
    const op = result.requests[0]?.questions.op;
    expect(op?.type === "choice" && Object.hasOwn(op.criteria, "answer_pending")).toBe(false);
  });

  it("requires structured answers for multiple questions instead of duplicating free text", async () => {
    const request = base.pendingRequests[0];
    if (request?.kind !== "question") return;
    const result = await run(
      { op: "answer_pending" },
      {
        ...base,
        pendingRequests: [
          {
            ...request,
            questions: [
              ...request.questions,
              { id: "second", text: "Second question", multiSelect: false, allowFreeText: true },
            ],
          },
        ],
      },
    );
    expect(result.op).toMatchObject({ op: "clarify", card: { requestId: "r1" } });
    expect(JSON.stringify(result.op)).not.toContain('"op":"answer"');
  });

  it("keeps multilingual candidate text in state and indexes it with distinct English criteria", async () => {
    const state: InboundState = {
      ...base,
      bots: base.bots.map((bot, index) => ({
        ...bot,
        name: `助手${index}`,
        description: `天文观测${index}`,
      })),
      taskCandidates: base.taskCandidates.map((task) => ({ ...task, title: "本周观测" })),
      pendingRequests: base.pendingRequests.map((request) => ({
        ...request,
        questions: request.questions.map((q) => ({ ...q, text: "要观测哪颗星？" })),
        raw: "native payload omitted",
      })),
    };
    const {
      requests: [request],
    } = await run({}, state);
    expect(request?.state).toMatchObject({
      bots: state.bots,
      tasks: state.taskCandidates,
      pending: [{ questions: ["要观测哪颗星？"] }, { questions: ["要观测哪颗星？"] }],
    });
    expect(JSON.stringify(request?.state)).not.toContain("native payload omitted");
    expect(JSON.stringify(request?.questions)).not.toMatch(/\p{Script=Han}/u);
    for (const [question, first, second] of [
      ["bot", "aut", "research"],
      ["target", "t1", "t2"],
      ["pending", "r1", "r2"],
    ] as const) {
      const q = request?.questions[question];
      expect(q?.type === "choice" && q.criteria[first]).toContain("index 0");
      expect(q?.type === "choice" && q.criteria[second]).toContain("index 1");
    }
  });

  it.each([null, TaskId.make("t2")])(
    "records failed classification without dispatch for target %s",
    async (fixedTargetId) => {
      const { result, logs } = await runDecision({}, { ...base, fixedTargetId }, true);
      expect(result).toMatchObject({
        _tag: "Left",
        left: { code: "Classification", classifierCode: "TransportError" },
      });
      expect(logs).toHaveLength(1);
      expect(logs[0]?.path).toEqual(["ui", "classify"]);
      expect(logs[0]?.execution).toMatchObject({ ok: false, classifierFailure: "TransportError" });
      expect(logs[0]?.output).toBeUndefined();
      expect(logs[0]?.classifierCalls[0]?.error).toContain("TransportError");
      expect(logs[0]?.input.state).toMatchObject({ fixedTargetId });
    },
  );
});
