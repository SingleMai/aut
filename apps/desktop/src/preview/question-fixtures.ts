import {
  type Card,
  type Question,
  type QuestionAnswer,
  RequestId,
  type RequestResponse,
  type TaskId,
} from "@aut/protocol";

const color: Question = {
  id: "color",
  text: "你希望先使用哪种界面风格？",
  options: [
    { id: "quiet", label: "简洁浅色", description: "保留清楚的对话层级和紧凑输入框。" },
    { id: "contrast", label: "高对比", description: "提高界面文字与背景的对比。" },
  ],
  multiSelect: false,
  allowFreeText: true,
};
const checks: Question = {
  id: "checks",
  text: "这次需要检查哪些交互？",
  options: [
    { id: "compose", label: "消息输入" },
    { id: "questions", label: "问题卡片" },
    { id: "history", label: "历史记录" },
  ],
  multiSelect: true,
  allowFreeText: true,
};
const name: Question = {
  id: "notes",
  text: "还有什么需要补充？",
  multiSelect: false,
  allowFreeText: true,
};
export const phases = ["registered", "submitting", "indeterminate", "queued", "delivered"] as const;

interface QuestionCase {
  id: string;
  title: string;
  questions: readonly Question[];
  phase?: (typeof phases)[number];
}

export const samples = {
  pending: { id: "qa-single", title: "请选择界面风格", questions: [color] },
  queued: {
    id: "qa-queued",
    title: "已转为后续消息：不可重复提交",
    questions: [color],
    phase: "queued",
  },
  delivered: {
    id: "qa-delivered",
    title: "已确认送达的题目",
    questions: [color],
    phase: "delivered",
  },
} satisfies Record<string, QuestionCase>;

export const questionCases: QuestionCase[] = [
  {
    id: "qa-registered",
    title: "已登记答案：只有显式重提才可再次提交",
    questions: [color],
    phase: "registered",
  },
  {
    id: "qa-indeterminate",
    title: "投递结果未知：不可重复提交",
    questions: [color],
    phase: "indeterminate",
  },
  {
    id: "qa-submitting",
    title: "答案正在投递：不可重复提交",
    questions: [color],
    phase: "submitting",
  },
  samples.queued,
  samples.delivered,
  { id: "qa-open", title: "开放问题", questions: [name] },
  { id: "qa-multi", title: "请确认这次界面验收", questions: [color, checks, name] },
  samples.pending,
  { id: "qa-latch", title: "确认提交后保持锁定", questions: [{ ...color, allowFreeText: false }] },
];

export const sampleAnswer: QuestionAnswer = {
  perQuestion: [{ questionId: color.id, optionIds: ["quiet"] }],
};

export function questionFixture(
  item: QuestionCase,
  taskId: TaskId,
  openedAt: number,
  answer = sampleAnswer,
) {
  const requestId = RequestId.make(item.id);
  const delivered = item.phase === "delivered";
  const card = {
    id: `${item.id}-card`,
    requestId,
    prompt: item.title,
    state: delivered ? "answered" : "open",
    options: [],
    multiSelect: false,
    allowFreeText: true,
  } satisfies Card;
  const snapshot = {
    request: {
      id: requestId,
      taskId,
      kind: "question",
      openedAt,
      raw: null,
      questions: item.questions,
    },
    ...(item.phase && { answerState: item.phase }),
    ...(delivered && { deliveredAnswer: answer }),
  } satisfies typeof RequestResponse.Type;
  return { card, snapshot };
}
