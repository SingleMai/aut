// Tool-row integration adapted from OpenMausBot src/components/ChatView.tsx,
// commit 738ec88472a3b888ff7b7793755d89da613ed301. Apache-2.0; see NOTICE.
// aut owns the read-only session boundary; imported tool components and grouping are copied.
import type { TaskSessionResponse } from "@aut/protocol";
import { Fragment, useEffect, useMemo, useRef } from "react";
import { ConversationBody } from "./conversation-body.js";
import { ActivityRun } from "./openmausbot/components/ActivityRun.js";
import type { BubbleJoin } from "./openmausbot/components/chat-bubble.js";
import { ToolActivity } from "./openmausbot/components/ToolActivity.js";
import { TurnNarrationRun } from "./openmausbot/components/TurnNarrationRun.js";
import { WorkingDots, WorkingTimer } from "./openmausbot/components/WorkingIndicator.js";
import { AdvancedModeProvider } from "./openmausbot/context.js";
import { groupTranscript } from "./openmausbot/lib/activity-runs.js";
import { t } from "./openmausbot/lib/i18n.js";
import { toolPlace } from "./openmausbot/lib/place.js";
import { toolStepLabel } from "./openmausbot/lib/tool-step-label.js";
import type { Message } from "./openmausbot/types.js";
import { projectSession } from "./session-presentation.js";
import { sessionLayout } from "./session-row-layout.js";

type Response = typeof TaskSessionResponse.Type;

function TextRow({
  message,
  itemId,
  advanced,
  join,
}: {
  message: Message;
  itemId: string | undefined;
  advanced: boolean;
  join: BubbleJoin | undefined;
}) {
  const text = message.text ?? "";
  return (
    <article
      className={`task-session-item task-session-item-${message.role === "user" ? "user" : message.role === "system" ? "note" : "assistant"}${message.turnTerminal ? " task-session-final" : ""}`}
      data-joined-above={(!advanced && join?.above) || undefined}
      data-joined-below={(!advanced && join?.below) || undefined}
      data-item-id={itemId}
      data-mid={message.id}
      data-turn-id={message.turnId}
    >
      {advanced && (
        <div className="task-session-item-heading">
          <span className="task-session-item-label">
            {message.role === "user"
              ? "本轮输入"
              : message.role === "system"
                ? "过程记录"
                : message.turnTerminal
                  ? "结果"
                  : "助手"}
          </span>
          {message.at > 0 && (
            <time className="task-session-time" dateTime={new Date(message.at).toISOString()}>
              {new Date(message.at).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          )}
        </div>
      )}
      <div className="task-session-text">
        {text && message.role !== "system" ? (
          <ConversationBody text={text} user={message.role === "user"} />
        ) : (
          text || "（此条记录没有文本内容）"
        )}
      </div>
    </article>
  );
}

export function SessionTranscript({
  response,
  advanced,
  showToolCalls,
  focusedItemId,
  onFocusConsumed,
}: {
  response: Response;
  advanced: boolean;
  showToolCalls: boolean;
  focusedItemId?: string;
  onFocusConsumed?: (itemId: string) => void;
}) {
  const projection = useMemo(() => projectSession(response), [response]);
  const { items, turnStatuses } = useMemo(() => {
    const byTurn = new Map<string, Message[]>();
    for (const message of projection.messages) {
      if (!message.turnId) continue;
      const rows = byTurn.get(message.turnId) ?? [];
      rows.push(message);
      byTurn.set(message.turnId, rows);
    }
    const messages: Message[] = [];
    const turnStatuses = new Map<string, string>();
    for (const turn of response.history.turns) {
      messages.push(...(byTurn.get(turn.id) ?? []));
      const text =
        turn.error ||
        (turn.status === "interrupted"
          ? "此回合已中断。"
          : turn.status === "failed"
            ? "此回合执行失败。"
            : "");
      if (!text) continue;
      const id = `turn-status:${turn.id}`;
      turnStatuses.set(id, text);
      // A host status row belongs to its turn, even when that turn has no visible messages.
      // The upstream grouping receives this ordinary non-tool boundary without rule changes.
      messages.push({
        id,
        at: turn.completedAt ?? turn.startedAt ?? 0,
        role: "system",
        kind: "text",
        text,
        turnId: turn.id,
      });
    }
    return { items: groupTranscript(messages), turnStatuses };
  }, [projection, response.history.turns]);
  const layout = useMemo(() => sessionLayout(items, showToolCalls), [items, showToolCalls]);
  const lastTurn = response.history.turns.at(-1);
  const active =
    lastTurn?.status === "running" &&
    (response.task.status === "running" || response.task.status === "waiting_user");
  const inFlight = projection.messages.findLast(
    (row) => row.turnId === lastTurn?.id && row.tool && projection.liveMessageIds.has(row.id),
  )?.tool;
  const lastVisible = items.findLast((_, i) => !layout.slots[i]?.hidden);
  const underBubble =
    lastVisible?.kind === "message" &&
    lastVisible.message.role === "bot" &&
    lastVisible.message.kind === "text";
  const host = useRef<HTMLDivElement>(null);
  const focusedId = projection.messages.find(
    (message) =>
      message.id === focusedItemId || projection.itemIds.get(message.id) === focusedItemId,
  )?.id;
  useEffect(() => {
    if (!focusedId || !focusedItemId || !showToolCalls) return;
    // Let the upstream group's forceOpen effect mount its children before locating the row.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const row = Array.from(
          host.current?.querySelectorAll<HTMLElement>("[data-mid]") ?? [],
        ).find((element) => element.dataset.mid === focusedId);
        const control = row?.querySelector<HTMLElement>("summary,button");
        // display:contents wrappers have no layout box; reveal the actual control instead.
        const target =
          control ?? (row?.classList.contains("session-tool-row") ? row.firstElementChild : row);
        target?.scrollIntoView({ block: "center" });
        control?.focus({ preventScroll: true });
        if (target) onFocusConsumed?.(focusedItemId);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [focusedId, focusedItemId, showToolCalls, onFocusConsumed]);
  const toolRow = (message: Message) => (
    <div
      key={message.id}
      className="session-tool-row"
      data-mid={message.id}
      data-item-id={projection.itemIds.get(message.id)}
      data-turn-id={message.turnId}
    >
      {message.tool && (
        <ToolActivity
          tool={message.tool}
          live={projection.liveMessageIds.has(message.id)}
          place={toolPlace(message.tool.name, "local")}
          source={{ threadId: response.task.id, messageId: message.id }}
        />
      )}
    </div>
  );
  return (
    <AdvancedModeProvider value={advanced}>
      <div className="task-session-items" data-session-simple={!advanced || undefined} ref={host}>
        {items.map((item, i) => {
          if (layout.slots[i]?.hidden) return null;
          const first = item.kind === "message" ? item.message : item.messages[0];
          const row = (() => {
            if (item.kind === "turn" || item.kind === "run") {
              if (!showToolCalls) return null;
              const forceOpen = item.messages.some((step) => step.id === focusedId);
              const steps = item.messages.map(toolRow);
              return item.kind === "turn" ? (
                <TurnNarrationRun
                  key={item.id}
                  label={item.label}
                  title={t("chat.run.showSteps")}
                  forceOpen={forceOpen}
                >
                  {steps}
                </TurnNarrationRun>
              ) : (
                <ActivityRun key={item.id} messages={item.messages} forceOpen={forceOpen}>
                  {steps}
                </ActivityRun>
              );
            }
            const message = item.message;
            const turnStatus = turnStatuses.get(message.id);
            if (turnStatus) {
              return (
                <p
                  key={message.id}
                  className="task-session-turn-error"
                  data-turn-id={message.turnId}
                >
                  {turnStatus}
                </p>
              );
            }
            if (message.kind === "activity") return showToolCalls ? toolRow(message) : null;
            return (
              <TextRow
                key={message.id}
                message={message}
                advanced={advanced}
                join={layout.joins[i]}
                itemId={projection.itemIds.get(message.id)}
              />
            );
          })();
          return (
            <Fragment key={item.kind === "message" ? item.message.id : item.id}>
              {!advanced && layout.slots[i]?.stamped && first && (
                <time className="task-session-stamp" dateTime={new Date(first.at).toISOString()}>
                  {new Date(first.at).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              )}
              {!advanced && layout.tucks[i] ? (
                <div className="task-session-tucked">{row}</div>
              ) : (
                row
              )}
            </Fragment>
          );
        })}
        {active && (
          <div
            className="task-session-running"
            data-under-bubble={(!advanced && underBubble) || undefined}
            role="status"
          >
            <WorkingDots />
            {inFlight
              ? toolStepLabel(inFlight)
              : response.task.status === "waiting_user"
                ? "有待答问题"
                : "助手正在工作…"}
            {advanced && lastTurn.startedAt != null && lastTurn.startedAt > 0 && (
              <span aria-hidden="true">
                {" "}
                · <WorkingTimer since={lastTurn.startedAt} />
              </span>
            )}
          </div>
        )}
      </div>
    </AdvancedModeProvider>
  );
}
