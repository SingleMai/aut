// ContextRing and Meter presentation adapted from OpenMausBot ComposerContextMenu.tsx.
// Copyright 2026 Milind Soni and contributors. Apache-2.0.
// Commit 619a6b7b22a8bf970416c7d9cbf4e8b3c5ba4ddc. See NOTICE.
// aut uses a read-only SessionHistory snapshot and Radix Popover; no compaction actions.
import type { SessionContext } from "@aut/protocol";
import { Button, Popover } from "@radix-ui/themes";
import { Gauge, Shrink } from "lucide-react";
import { t } from "./i18n.js";
import { contextReading, formatTokens } from "./openmausbot/lib/context-usage.js";

const RING = 16;
const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function ContextRing({ percent }: { percent: number }) {
  const filled = (RING_LENGTH * Math.min(100, Math.max(4, percent))) / 100;
  return (
    <svg
      aria-hidden="true"
      width={RING}
      height={RING}
      viewBox={`0 0 ${RING} ${RING}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      className="session-context-ring"
    >
      <circle cx={RING / 2} cy={RING / 2} r={RING_RADIUS} opacity={0.3} />
      <circle
        cx={RING / 2}
        cy={RING / 2}
        r={RING_RADIUS}
        strokeLinecap="round"
        strokeDasharray={`${filled} ${RING_LENGTH}`}
      />
    </svg>
  );
}

export function SessionContextStatus({
  context,
  available,
  active,
}: {
  context: SessionContext | undefined;
  available: boolean;
  active: boolean;
}) {
  if (!context) return null;
  const status = context.compaction?.status;
  const effectiveStatus = status === "running" && !active ? "unknown" : status;
  const compacting = available && effectiveStatus === "running";
  const reading =
    available && !compacting ? contextReading(context.usage?.tokens, context.usage?.window) : null;
  const label = compacting
    ? t.sessionCompaction.running
    : `${t.sessionContext}${reading ? ` ${reading.percent === undefined ? `${formatTokens(reading.tokens)} tokens` : `${reading.percent}%`}` : ""}`;
  const note = !available
    ? t.sessionContextUnavailable
    : effectiveStatus
      ? t.sessionCompaction[effectiveStatus]
      : t.sessionContextEmpty;
  const tokens = reading
    ? `${formatTokens(reading.tokens)}${reading.window ? ` / ${formatTokens(reading.window)}` : ""} tokens`
    : "";
  return (
    <div className="session-context" data-tone={reading?.tone}>
      <Popover.Root>
        <Popover.Trigger>
          <Button
            type="button"
            size="1"
            color="gray"
            variant="ghost"
            className="session-context-trigger"
            aria-label={label}
          >
            {compacting ? (
              <Shrink size={16} aria-hidden="true" />
            ) : reading?.percent !== undefined ? (
              <ContextRing percent={reading.percent} />
            ) : (
              <Gauge size={16} aria-hidden="true" />
            )}
            <span>{label}</span>
          </Button>
        </Popover.Trigger>
        <Popover.Content
          size="1"
          side="bottom"
          align="start"
          className="session-context-popover"
          aria-label={t.sessionContextDetails}
        >
          <p className="session-context-title">{t.sessionContextDetails}</p>
          {reading && (
            <div className="session-context-meter" data-tone={reading.tone}>
              <div className="session-context-figures">
                <strong>
                  {reading.percent === undefined ? tokens : t.sessionContextUsed(reading.percent)}
                </strong>
                {reading.percent !== undefined && <span>{tokens}</span>}
              </div>
              {reading.percent !== undefined && (
                <meter
                  className="session-context-track"
                  aria-label={t.sessionContext}
                  min={0}
                  max={100}
                  value={Math.min(100, reading.percent)}
                  aria-valuetext={`${reading.percent}% · ${tokens}`}
                />
              )}
              <p className="session-context-caption">{t.sessionContextReading}</p>
            </div>
          )}
          {(!reading || effectiveStatus) && (
            <p className="session-context-note" role="status">
              {note}
            </p>
          )}
          {available && effectiveStatus === "completed" && !reading && (
            <p className="session-context-caption">{t.sessionContextAwaiting}</p>
          )}
        </Popover.Content>
      </Popover.Root>
    </div>
  );
}
