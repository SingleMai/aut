// Extracted from OpenMausBot src/components/SidebarThreadRow.tsx at 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0. See NOTICE.
// Read-only panel row. aut supplies task identity, activity and the selection callback.
import { memo, useEffect, useRef, useState } from "react";
import { intlLocale, t } from "../lib/i18n.js";

function formatUpdatedAt(at: number): string {
  if (!Number.isFinite(new Date(at).getTime()) || at <= 0) return "";
  return new Date(at).toLocaleString(intlLocale(), { dateStyle: "short", timeStyle: "short" });
}

function threadUpdatedLabel(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return t("task.updated.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("task.updated.minutes", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (seconds < 86_400) return t("task.updated.hours", { count: hours });
  const days = Math.round(hours / 24);
  if (days === 1) return t("task.updated.yesterday");
  return t("task.updated.days", { count: days });
}

export function stampClock(at: number, now: number): number | undefined {
  if (!Number.isFinite(at) || at <= 0 || !Number.isFinite(now)) return undefined;
  return Math.max(0, Math.round((now - at) / 1000)) < 7 * 86_400 ? now : undefined;
}

export function useRelativeNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const sync = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    const timer = window.setInterval(sync, 30_000);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return now;
}

export const SidebarThreadRow = memo(function SidebarThreadRow({
  id,
  title,
  preview,
  status,
  updatedAt,
  now,
  current,
  onSelect,
}: {
  id: string;
  title: string;
  preview: string;
  status: string;
  updatedAt: number;
  now: number | undefined;
  current: boolean;
  onSelect: (id: string) => void;
}) {
  const row = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!current || !row.current) return;
    row.current.scrollIntoView({ block: "nearest" });
    // A message action can navigate away from the element that held keyboard focus.
    if (document.activeElement === document.body || document.activeElement?.closest("[hidden]"))
      row.current.focus({ preventScroll: true });
  }, [current]);
  const stamp = formatUpdatedAt(updatedAt);
  const updatedLabel = stamp && now !== undefined ? threadUpdatedLabel(updatedAt, now) : stamp;
  return (
    <button
      type="button"
      ref={row}
      data-sidebar-thread-row={id}
      data-task-id={id}
      aria-current={current ? "page" : undefined}
      title={[title, stamp, preview].filter(Boolean).join(" · ")}
      onClick={() => onSelect(id)}
      className="sidebar-task"
    >
      <span className="sidebar-task-copy">
        <span className="sidebar-task-title">
          <span dir="auto" className="sidebar-task-name">
            {title}
          </span>
          <span aria-hidden="true" className="status-dot" data-status={status} />
        </span>
        <span className="sidebar-task-meta">
          <span dir="auto" className="sidebar-task-preview">
            {preview}
          </span>
          {updatedLabel && (
            <time dateTime={new Date(updatedAt).toISOString()} className="sidebar-task-time">
              {updatedLabel}
            </time>
          )}
        </span>
      </span>
    </button>
  );
});
