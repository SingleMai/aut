import {
  BotId,
  type SessionContext,
  type Task,
  TaskId,
  type TaskSessionResponse,
  Timestamp,
} from "@aut/protocol";
import { Select } from "@radix-ui/themes";
import { useState } from "react";
import { TaskSessionView } from "../task-session-view.js";

const compaction = { turnId: "context-turn", itemId: "compact", status: "completed" as const };
export const contextExamples: Record<
  string,
  { label: string; context?: SessionContext; available?: boolean }
> = {
  measured: { label: "正常用量", context: { usage: { tokens: 104000, window: 200000 } } },
  compacting: { label: "正在整理", context: { compaction: { ...compaction, status: "running" } } },
  compacted: { label: "整理完成，等待读数", context: { compaction } },
  renewed: {
    label: "整理后的新读数",
    context: { compaction, usage: { tokens: 24000, window: 200000 } },
  },
  tokens: { label: "窗口未知", context: { usage: { tokens: 24000 } } },
  unavailable: {
    label: "读取失败",
    context: { usage: { tokens: 104000, window: 200000 } },
    available: false,
  },
  unsupported: { label: "不支持原生状态" },
};
export const contextPreviewTask: Task = {
  id: TaskId.make("context-preview"),
  botId: BotId.make("context-bot"),
  title: "整理项目资料",
  status: "running",
  createdAt: Timestamp.make(1),
  updatedAt: Timestamp.make(2),
  lastActivityAt: Timestamp.make(2),
  session: { instanceId: "preview" },
  pendingRequestIds: [],
  queue: [],
  origin: { kind: "user" },
};
export function contextPreviewResponse(name: string): TaskSessionResponse {
  const example: { context?: SessionContext; available?: boolean } = contextExamples[name] ?? {};
  return {
    task: contextPreviewTask,
    availability: example.available === false ? "unavailable" : "available",
    hasEarlier: false,
    history: {
      ...(example.context ? { context: example.context } : {}),
      turns: [
        {
          id: "context-turn",
          status: "running",
          items: [
            {
              id: "user",
              kind: "user",
              text: "继续整理项目资料，保留前面确认的结论。",
              status: "completed",
            },
            ...(example.context?.compaction
              ? [
                  {
                    id: "compact",
                    kind: "note" as const,
                    noteKind: "context-compaction" as const,
                    text: "",
                    status: example.context.compaction.status,
                  },
                ]
              : []),
            {
              id: "reply",
              kind: "assistant",
              text: "已保留确认过的结论，正在继续整理。",
              status: "completed",
            },
          ],
        },
      ],
    },
  };
}

export function ContextPreview() {
  const [example, setExample] = useState("measured");
  return (
    <section className="preview-section">
      <header className="preview-section-heading">
        <h2>原生上下文状态</h2>
        <p className="muted">合成场景，使用真实工作会话组件。</p>
      </header>
      <Select.Root value={example} onValueChange={setExample}>
        <Select.Trigger aria-label="上下文示例" />
        <Select.Content>
          {Object.entries(contextExamples).map(([key, entry]) => (
            <Select.Item key={key} value={key}>
              {entry.label}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      <TaskSessionView
        task={contextPreviewTask}
        response={contextPreviewResponse(example)}
        busy={false}
        error=""
        load={() => {}}
      />
    </section>
  );
}
