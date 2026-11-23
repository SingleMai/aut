import type { Task } from "@aut/protocol";
import { IconButton } from "@radix-ui/themes";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AutomationsPage } from "./automations-page.js";
import { BotsPage } from "./bots-page.js";
import { ConversationPage } from "./conversation-page.js";
import { createDesktopData } from "./desktop-data.js";
import { DesktopSidebar, type DesktopView, pages } from "./desktop-sidebar.js";
import { t } from "./i18n.js";
import { Icon } from "./icons.js";
import { SettingsPage } from "./settings-page.js";
import { TaskPage } from "./task-page.js";
import { runUi } from "./ui/use-action.js";

export function DesktopApp() {
  const [data] = useState(createDesktopData);
  const snapshot = useSyncExternalStore(data.subscribe, data.snapshot);
  const { tasks, bots, config } = snapshot;
  const [view, setView] = useState<DesktopView>("conversation");
  const [visited, setVisited] = useState<readonly string[]>([]);
  const selected = visited[0];
  const [returnTask, setReturnTask] = useState<{ task: Task }>();
  const [searchOpen, setSearchOpen] = useState(false),
    [connected, setConnected] = useState(true),
    [toast, flash] = useState("");
  const refresh = useCallback(() => runUi(data.refresh(), flash), [data]);
  useEffect(() => {
    const stop = window.aut.onNotice((notice) => {
      if (notice.type === "connection") {
        setConnected(notice.connected);
        if (notice.connected) refresh();
      } else if (notice.type === "changed") runUi(data.refresh(notice.resources), flash);
    });
    refresh();
    return stop;
  }, [data, refresh]);
  const openTask = useCallback(
    (id: string) => {
      setVisited((ids) =>
        ids[0] === id ? ids : [id, ...ids.filter((previous) => previous !== id)],
      );
      setView("tasks");
      setReturnTask(undefined);
      runUi(data.selectTask(id), flash);
    },
    [data],
  );
  const sorted = useMemo(
    () => tasks.toSorted((a, b) => b.lastActivityAt - a.lastActivityAt),
    [tasks],
  );
  const recentId = sorted[0]?.id;
  const tasksById = useMemo(
    () => new Map<string, Task>(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const selectedTask = selected ? tasksById.get(selected) : undefined;
  useEffect(() => {
    if (view === "tasks" && !selected && recentId) openTask(recentId);
  }, [view, selected, recentId, openTask]);
  const navigate = (page: DesktopView) => {
    setReturnTask(undefined);
    if (page === "tasks") {
      setSearchOpen(false);
      const task = selectedTask ?? sorted[0];
      if (task) {
        openTask(task.id);
        return;
      }
    }
    setView(page);
  };
  const botNames = useMemo(() => new Map(bots.map((bot) => [bot.id, bot.name])), [bots]);
  const running = tasks.filter((task) => ["created", "running", "reporting"].includes(task.status));
  const waiting = tasks.filter((task) => task.pendingRequestIds.length > 0).length;
  return (
    <>
      <div className="shell">
        <DesktopSidebar
          tasks={sorted}
          latestMessage={snapshot.messages.at(-1)?.text}
          onSearchOpen={setSearchOpen}
          {...{ botNames, view, selected, connected, searchOpen, navigate, openTask }}
        />
        <main className="workspace" data-view={view}>
          <header className="page-header">
            <div className="title-group">
              <span className="title-mark">
                <Icon name={pages[view].icon} />
              </span>
              <div>
                <h1>{pages[view].label}</h1>
                {view === "tasks" && <p className="page-subtitle">{t.readOnly}</p>}
              </div>
            </div>
            <div className="header-actions">
              <div className="activity-summary">
                {running.length > 0 && (
                  <span>
                    {running.length} {t.status.running}
                  </span>
                )}
                {waiting > 0 && (
                  <span className="activity-waiting">
                    {waiting} {t.pending}
                  </span>
                )}
              </div>
              <IconButton
                type="button"
                color="gray"
                variant="ghost"
                radius="full"
                size="1"
                aria-label={t.refresh}
                title={t.refresh}
                onClick={refresh}
              >
                <Icon name="refresh" />
              </IconButton>
            </div>
          </header>
          <section className="content">
            <ConversationPage
              active={view === "conversation"}
              working={running}
              {...{ data, snapshot, returnTask, flash }}
              openTask={(id) => {
                setSearchOpen(false);
                openTask(id);
              }}
            />
            {visited.map((id) => {
              const task = tasksById.get(id);
              return (
                task && (
                  <TaskPage
                    key={id}
                    {...{ task, data, flash }}
                    botName={botNames.get(task.botId) ?? task.botId}
                    active={view === "tasks" && selected === id}
                    revision={snapshot.taskRevision}
                    onAnswer={() => {
                      setReturnTask({ task });
                      setView("conversation");
                    }}
                  />
                )
              );
            })}
            {view === "tasks" && !selectedTask && (
              <p className="empty-panel">
                {selected ? t.loading : tasks.length ? "从左侧选择任务" : t.emptyTasks}
              </p>
            )}
            {(view === "bots" || view === "settings") && !config && (
              <p className="muted">{t.loading}</p>
            )}
            {view === "bots" && config && (
              <BotsPage {...{ bots, config, data, flash }} settings={() => navigate("settings")} />
            )}
            {view === "automations" && (
              <AutomationsPage {...{ bots, data, flash }} triggers={snapshot.triggers} />
            )}
            {view === "settings" && config && <SettingsPage {...{ config, data, flash }} />}
          </section>
        </main>
      </div>
      <div className="toast" role="alert" hidden={!toast}>
        <p>{toast}</p>
        <IconButton
          type="button"
          color="gray"
          variant="ghost"
          radius="full"
          size="1"
          aria-label={t.close}
          onClick={() => flash("")}
        >
          ×
        </IconButton>
      </div>
    </>
  );
}
