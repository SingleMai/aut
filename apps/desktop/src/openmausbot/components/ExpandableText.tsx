// Copied from OpenMausBot, src/components/ExpandableText.tsx, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut adaptation: aut styling, original thresholds and disclosure behavior.
import { Button } from "@radix-ui/themes";
import { useState } from "react";
import { t } from "../lib/i18n.js";

export const EXPANDABLE_TEXT_LIMIT = 280;

export function expandableTextIsLong(text: string): boolean {
  return text.length > EXPANDABLE_TEXT_LIMIT || text.split("\n").length > 6;
}

export function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = expandableTextIsLong(text);
  return (
    <div>
      <div className="expandable-text">{text}</div>
      {long && (
        <Button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          variant="ghost"
          size="1"
          className="expandable-toggle"
        >
          {expanded ? t("question.showLess") : t("question.showFull")}
        </Button>
      )}
    </div>
  );
}
