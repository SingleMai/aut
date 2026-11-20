// Copied from OpenMausBot, src/components/ToolActivity.tsx, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut uses native desktop styles and local UI ports for the original tool detail behavior.
import { Check, ChevronRight, Circle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAdvancedMode } from "../context.js";
import { isNoticeCode, routineLineText } from "../lib/activity-text.js";
import { t } from "../lib/i18n.js";
import { type Place, placeLabelKey } from "../lib/place.js";
import { toolStepLabel } from "../lib/tool-step-label.js";
import { nameIsCommand } from "../lib/verify-steps.js";
import type { Message } from "../types.js";
import type { MessageAttachmentContext } from "./AttachmentPreview.js";
import { PlaceIcon } from "./PlaceIcon.js";
import { WorkingDots } from "./WorkingIndicator.js";

/** Which stored message a step is: a clipped step (its output cut short in conversation pages) loads the rest from it. */
export function ToolActivity({
  tool,
  place = null,
  live = false,
  source,
}: {
  tool: NonNullable<Message["tool"]>;
  place?: Place | null;
  live?: boolean;
  source?: MessageAttachmentContext;
}) {
  const [expanded, setExpanded] = useState(false);
  const full = useFullOutput(expanded && tool.clipped ? source : undefined, tool.output);
  const output = full.output ?? tool.output;
  const failed = tool.ok === false;
  const advanced = useAdvancedMode();
  const notice = isNoticeCode(tool.nameCode);
  const summary = routineLineText(tool.summaryCode, tool.summary ?? "", tool.summaryParams);
  const problem = failed ? tool.problem : undefined;
  const label = problem ?? (advanced && !notice ? (tool.label ?? tool.name) : toolStepLabel(tool));
  const status =
    tool.ok === undefined
      ? live
        ? t("toolDetail.running")
        : t("toolDetail.unverified")
      : failed
        ? t("toolDetail.failed")
        : t("toolDetail.completed");
  return (
    <details
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="tool-activity"
      data-failed={failed || undefined}
      data-testid="tool-activity"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: Keep the upstream accessible native details/summary control. */}
      <summary
        role="button"
        aria-expanded={expanded}
        aria-label={t("toolDetail.label", { name: label, status })}
        className="tool-summary"
      >
        <span className="tool-state-icon" aria-hidden="true">
          {tool.ok === undefined ? (
            live ? (
              <WorkingDots />
            ) : (
              <Circle size={13} />
            )
          ) : failed ? (
            <X size={13} />
          ) : (
            <Check size={13} className="tool-success" />
          )}
        </span>
        {place && (
          <PlaceIcon
            place={place}
            size={13}
            className="tool-place"
            role="img"
            aria-label={t(placeLabelKey(place))}
            data-testid="tool-place"
          />
        )}
        <span
          className={problem ? "tool-problem" : advanced && !notice ? "tool-name" : "tool-label"}
        >
          {label}
        </span>
        {advanced && tool.summary && tool.summary !== tool.name && !nameIsCommand(tool.name) && (
          <span className="tool-command" title={summary}>
            {summary}
          </span>
        )}
        <ChevronRight size={13} className="tool-chevron" aria-hidden="true" />
      </summary>
      <div className="tool-details">
        <div className="tool-status">{status}</div>
        {label !== tool.name && !notice && (
          <div>
            <div className="tool-field-label">{t("toolDetail.tool")}</div>
            <p dir="ltr" className="tool-identifier" data-testid="tool-name">
              {tool.name}
            </p>
          </div>
        )}
        <div>
          <div className="tool-field-label">{t("toolDetail.input")}</div>
          <pre dir="ltr" className="tool-input">
            {tool.input ?? (tool.summary ? summary : notice ? label : tool.name)}
          </pre>
        </div>
        <div>
          <div className="tool-field-label">{t("toolDetail.output")}</div>
          {output ? (
            <pre dir="ltr" className="tool-output">
              {output}
            </pre>
          ) : (
            <p className="tool-empty">
              {tool.ok === undefined
                ? live
                  ? t("toolDetail.waiting")
                  : t("toolDetail.unverified")
                : t("toolDetail.noOutput")}
            </p>
          )}
        </div>
        {(full.state === "loading" || full.state === "failed") && (
          <p className="tool-hint" role="status">
            {t(full.state === "loading" ? "toolDetail.loadingFull" : "toolDetail.partial")}
          </p>
        )}
        <p className="tool-hint">{t("toolDetail.previewHint")}</p>
      </div>
    </details>
  );
}

type FullOutput = { state: "idle" | "loading" | "done" | "failed"; output?: string | undefined };

/** The whole output of a clipped step, fetched when it is opened: kept once it arrives, asked again after a failure. */
function useFullOutput(
  source: MessageAttachmentContext | undefined,
  preview: string | undefined,
): FullOutput {
  const url =
    source &&
    `/api/threads/${encodeURIComponent(source.threadId)}/messages/${encodeURIComponent(source.messageId)}/tool`;
  const key = url && `${url}#${preview?.length ?? 0}`;
  const [full, setFull] = useState<FullOutput & { key?: string | undefined }>({ state: "idle" });
  const have = full.key === key && full.state === "done";
  useEffect(() => {
    if (!url || have) return;
    let current = true;
    const abort = new AbortController();
    setFull({ state: "loading", key });
    api<{ output: string }>(url, { signal: abort.signal })
      .then((body) => {
        if (current) setFull({ state: "done", key, output: body.output });
      })
      .catch(() => {
        if (current) setFull({ state: "failed", key });
      });
    return () => {
      current = false;
      abort.abort();
    };
  }, [url, key, have]);
  return full.key === key ? full : { state: "idle" };
}
