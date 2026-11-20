import type { Task } from "@aut/protocol";
import { Badge, Button } from "@radix-ui/themes";
import { Effect } from "effect";
import { desktopApi } from "./api.js";
import type { DesktopData } from "./desktop-data.js";
import { formatTime, t } from "./i18n.js";
import { TaskHistory } from "./task-history.js";
import { sessionIdentity } from "./task-session-state.js";
import { type Flash, useAction } from "./ui/use-action.js";

type Control = keyof typeof t.control;
const controlAppearance = {
  cancel: { color: "red", variant: "soft" },
  archive: { color: "gray", variant: "surface" },
  resume: {},
  retry: {},
} as const;
const controlsByStatus: Record<Task["status"], readonly Control[]> = {
  created: ["cancel"],
  running: ["cancel"],
  waiting_user: ["cancel"],
  reporting: ["cancel"],
  failed: ["retry", "archive"],
  interrupted: ["resume", "archive"],
  idle: ["archive"],
  cancelled: ["archive"],
  archived: [],
};
export function TaskPage({
  task,
  botName,
  active,
  revision,
  data,
  onAnswer,
  flash,
}: {
  task: Task;
  botName: string;
  active: boolean;
  revision: number;
  data: DesktopData;
  onAnswer: () => void;
  flash: Flash;
}) {
  const control = useAction(flash);
  const identity = sessionIdentity(task);
  return (
    <div className="task-detail-view" hidden={!active}>
      <section className="task-workspace">
        <section className="detail-card task-detail">
          <div className="section-heading">
            <h2>{task.title || task.id}</h2>
            <Badge className="task-status" color="gray" data-status={task.status}>
              {t.status[task.status]}
            </Badge>
          </div>
          <p className="muted">{botName}</p>
          <div className="toolbar task-actions">
            <details className="task-metadata" data-section="information">
              <summary data-focus-key="information">任务信息</summary>
              <p className="muted">
                {t.createdAt} {formatTime(task.createdAt)}
              </p>
              <div className="task-stats">
                <Badge color="gray">
                  {t.pending} {task.pendingRequestIds.length}
                </Badge>
                <Badge color="gray">
                  {t.queue} {task.queue.length}
                </Badge>
              </div>
              <p className="identifier">{task.id}</p>
              {task.lastReport && (
                <details className="task-metadata" data-section="report">
                  <summary data-focus-key="report">{t.recentReport}</summary>
                  <pre className="report-text">{task.lastReport.full}</pre>
                </details>
              )}
            </details>
            {!task.pendingRequestIds.length && (
              <Button type="button" color="gray" variant="surface" onClick={onAnswer}>
                回主会话继续
              </Button>
            )}
            {controlsByStatus[task.status].map((action) => (
              <Button
                type="button"
                key={action}
                size="1"
                {...controlAppearance[action]}
                data-task-control={action}
                disabled={control.busy}
                onClick={() =>
                  control.run(
                    desktopApi
                      .sendAction({ type: "task-control", taskId: task.id, action })
                      .pipe(Effect.zipRight(data.refresh(["tasks", "messages"]))),
                  )
                }
              >
                {t.control[action]}
              </Button>
            ))}
          </div>
        </section>
        <TaskHistory key={identity} {...{ task, identity, active, revision, data, onAnswer }} />
      </section>
    </div>
  );
}
