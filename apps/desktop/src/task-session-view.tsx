// Session adapter for OpenMausBot ToolActivity, ActivityRun and TurnNarrationRun,
// commit 738ec88472a3b888ff7b7793755d89da613ed301, Apache-2.0. See NOTICE.

import type { Task, TaskSessionResponse } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { type ComponentProps, memo, useMemo, useSyncExternalStore } from "react";
import { sessionDisplay } from "./session-display-preferences.js";
import { SessionTranscript } from "./session-transcript.js";

const Transcript = memo(SessionTranscript);

export function TaskSessionView({
  task,
  response,
  busy,
  error,
  load,
  onAnswer,
  ...focus
}: {
  task: Task;
  response: TaskSessionResponse | undefined;
  busy: boolean;
  error: string;
  load: (earlier?: boolean) => void;
  onAnswer?: () => void;
} & Pick<ComponentProps<typeof SessionTranscript>, "focusedItemId" | "onFocusConsumed">) {
  const advanced = useSyncExternalStore(sessionDisplay.subscribe, () =>
    sessionDisplay.read("advanced"),
  );
  const tools = useSyncExternalStore(sessionDisplay.subscribe, () =>
    sessionDisplay.read("showToolCalls"),
  );
  const retry = !!error || response?.availability === "unavailable";
  const availability = {
    pending: "工作会话尚未建立，开始执行后会在这里显示记录。",
    unsupported: "当前执行器尚不支持读取工作会话。",
    unavailable: "暂时无法读取工作会话。",
    available: response?.history.turns.length ? "" : "此会话暂时没有回合记录。",
  };
  const message = response
    ? response.message || availability[response.availability]
    : error
      ? "暂时无法读取工作会话。"
      : "正在读取工作会话…";
  const transcript = useMemo(() => response && { ...response, task }, [response, task]);
  const count = task.pendingRequestIds.length;
  return (
    <section className="task-session-view" aria-label="工作会话记录" aria-busy={busy}>
      <Button
        type="button"
        color="gray"
        variant="surface"
        className="task-session-earlier"
        disabled={busy}
        hidden={!response?.hasEarlier}
        onClick={() => load(true)}
      >
        加载更早的回合
      </Button>
      <div className="task-session-notice" hidden={!message && !retry}>
        <p className="task-session-muted" hidden={!message}>
          {message}
        </p>
        <Button
          type="button"
          color="gray"
          variant="surface"
          className="task-session-retry"
          hidden={!retry}
          disabled={busy}
          onClick={() => load()}
        >
          重新读取
        </Button>
      </div>
      <p
        className="task-session-loading"
        role="status"
        hidden={!busy || !!response?.history.turns.length}
      >
        正在更新会话记录…
      </p>
      <p className="task-session-error" role="alert" hidden={!error}>
        {error}
      </p>
      <div className="task-session-pending" hidden={!count}>
        <span>有 {count} 个问题等待你回答</span>
        {onAnswer && (
          <Button type="button" color="gray" variant="surface" onClick={onAnswer}>
            回主会话回答
          </Button>
        )}
      </div>
      <div className="task-session-view-controls">
        <Button
          type="button"
          size="1"
          color="gray"
          variant={tools ? "soft" : "surface"}
          data-session-tools=""
          aria-pressed={tools}
          onClick={() => sessionDisplay.set("showToolCalls", !tools)}
        >
          显示工具调用
        </Button>
        <Button
          type="button"
          size="1"
          color="gray"
          variant={advanced ? "soft" : "surface"}
          data-session-mode=""
          aria-pressed={advanced}
          onClick={() => sessionDisplay.set("advanced", !advanced)}
        >
          详细模式
        </Button>
      </div>
      {transcript && (
        <Transcript response={transcript} advanced={advanced} showToolCalls={tools} {...focus} />
      )}
    </section>
  );
}
