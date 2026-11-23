// Search navigation adapted from OpenMausBot src/components/Sidebar.tsx at 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0. See NOTICE.

import type { Task } from "@aut/protocol";
import { Badge } from "@radix-ui/themes";
import { useRef, useState } from "react";
import { Wordmark } from "./brand.js";
import { t } from "./i18n.js";
import { Icon, type IconName } from "./icons.js";
import {
  SidebarSearchPill,
  SidebarSearchToggle,
} from "./openmausbot/components/SidebarSimpleTop.js";
import {
  SidebarThreadRow,
  stampClock,
  useRelativeNow,
} from "./openmausbot/components/SidebarThreadRow.js";

export const pages = {
  conversation: { label: t.conversation, icon: "chat" },
  tasks: { label: t.tasks, icon: "tasks" },
  bots: { label: t.bots, icon: "bot" },
  automations: { label: t.automations, icon: "automation" },
  settings: { label: t.settings, icon: "settings" },
} satisfies Record<string, { label: string; icon: IconName }>;
export type DesktopView = keyof typeof pages;

export function DesktopSidebar({
  tasks,
  botNames,
  view,
  selected,
  latestMessage,
  connected,
  searchOpen,
  onSearchOpen,
  navigate,
  openTask,
}: {
  tasks: readonly Task[];
  botNames: ReadonlyMap<string, string>;
  selected: string | undefined;
  latestMessage: string | undefined;
  view: DesktopView;
  connected: boolean;
  searchOpen: boolean;
  onSearchOpen: (open: boolean) => void;
  navigate: (view: DesktopView) => void;
  openTask: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const toggle = useRef<HTMLButtonElement>(null);
  const now = useRelativeNow();
  const needle = searchOpen ? query.trim().toLocaleLowerCase() : "";
  const listed = needle
    ? tasks.filter((task) =>
        `${task.title || task.id} ${botNames.get(task.botId) ?? task.botId}`
          .toLocaleLowerCase()
          .includes(needle),
      )
    : tasks;
  const closeSearch = () => {
    onSearchOpen(false);
    toggle.current?.focus({ preventScroll: true });
  };
  const nav = (key: DesktopView) => (
    <button
      type="button"
      className="nav-item"
      aria-current={key === view ? "page" : undefined}
      aria-label={pages[key].label}
      data-view={key}
      onClick={() => navigate(key)}
    >
      <Icon name={pages[key].icon} />
      {key === "conversation" ? (
        <span className="nav-copy">
          <strong>{t.conversation}</strong>
          {latestMessage && <small>{latestMessage}</small>}
        </span>
      ) : (
        <span>{pages[key].label}</span>
      )}
    </button>
  );
  return (
    <aside className="sidebar">
      <div className="brand">
        <Wordmark />
        <SidebarSearchToggle
          ref={toggle}
          label={t.searchTasks}
          open={searchOpen}
          onToggle={() => {
            if (searchOpen) closeSearch();
            else {
              setQuery("");
              onSearchOpen(true);
            }
          }}
        />
      </div>
      {searchOpen && (
        <SidebarSearchPill
          label={t.searchTasks}
          query={query}
          onQuery={setQuery}
          onClose={closeSearch}
        />
      )}
      <nav className="navigation">{nav("conversation")}</nav>
      <div className="sidebar-heading">
        {nav("tasks")}
        <Badge color="gray">{tasks.length}</Badge>
      </div>
      <nav className="sidebar-tasks" aria-label={t.allTasks}>
        {listed.map((task) => (
          <SidebarThreadRow
            key={task.id}
            id={task.id}
            title={task.title || task.id}
            preview={`${botNames.get(task.botId) ?? task.botId} · ${t.status[task.status]}`}
            status={task.status}
            updatedAt={task.lastActivityAt}
            now={stampClock(task.lastActivityAt, now)}
            current={view === "tasks" && selected === task.id}
            onSelect={openTask}
          />
        ))}
        {!listed.length && (
          <p className="empty-panel">{needle ? t.noMatchingTasks : t.emptyTasks}</p>
        )}
      </nav>
      <div className="sidebar-footer">
        {nav("bots")}
        {nav("automations")}
        {nav("settings")}
      </div>
      <div className={`connection${connected ? "" : " offline"}`}>
        {connected ? t.connected : t.disconnected}
      </div>
    </aside>
  );
}
