// Copied from OpenMausBot, src/components/ActivityRun.tsx, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut adaptation: local UI ports and native styles; original group and disclosure behavior.

import { Check, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useAdvancedMode } from "../context.js";
import { describeRun } from "../lib/activity-runs.js";
import { t } from "../lib/i18n.js";
import { toolStepLabel } from "../lib/tool-step-label.js";
import type { Message } from "../types.js";

export function ActivityRun({
  messages,
  forceOpen = false,
  children,
}: {
  messages: Message[];
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  const advanced = useAdvancedMode();
  const summary = advanced ? describeRun(messages) : describeRun(messages, toolStepLabel);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <div className="tool-run">
      <div className="tool-run-heading">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={open ? undefined : t("chat.run.showSteps")}
          className="tool-run-toggle"
        >
          {open ? (
            <ChevronRight size={13} className="tool-chevron" />
          ) : (
            <Check size={13} className="tool-success" />
          )}
          <span className="tool-run-label">{summary}</span>
          {!open && <ChevronRight size={13} className="tool-chevron" />}
        </button>
      </div>
      {open && children}
    </div>
  );
}
