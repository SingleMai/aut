// Copied from OpenMausBot, src/components/TurnNarrationRun.tsx, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut adaptation: local UI ports and native styles; original group and disclosure behavior.
// Providers such as Grok narrate before tools.

import { Check, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { t } from "../lib/i18n.js";

export function TurnNarrationRun({
  label,
  title,
  forceOpen = false,
  children,
}: {
  label: string;
  title?: string;
  forceOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(forceOpen);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <div className="tool-run narrated-run">
      <div className="tool-run-heading">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title={title ?? t(open ? "chat.narration.hide" : "chat.narration.show")}
          className="tool-run-toggle"
        >
          <Check size={13} className="tool-success" />
          <span>{label}</span>
          <ChevronRight size={13} className="tool-chevron" />
        </button>
      </div>
      {open && children}
    </div>
  );
}
