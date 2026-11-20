// Adapted from OpenMausBot src/components/chat-bubble.ts, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0; see NOTICE.
// Session rows project only native text, notes and tool groups. Hidden tools have no visible stamp.

import {
  bubbleJoins,
  cardTucks,
  needsStamp,
  type TranscriptSlot,
} from "./openmausbot/components/chat-bubble.js";
import type { TranscriptItem } from "./openmausbot/lib/activity-runs.js";
import type { Message } from "./openmausbot/types.js";

export function sessionLayout(items: readonly TranscriptItem[], showTools: boolean) {
  let previous: Message | undefined;
  const slots = items.map((item): TranscriptSlot => {
    const rows = item.kind === "message" ? [item.message] : item.messages;
    const first = rows[0];
    const hidden = !showTools && (item.kind !== "message" || first?.kind === "activity");
    const stamped = Boolean(
      first && first.at > 0 && (!previous?.at || needsStamp(previous, first, true)),
    );
    const differentTurn = previous?.turnId !== first?.turnId;
    if (!hidden) previous = rows.at(-1);
    const group =
      item.kind === "message" && first?.kind === "text" && first.role !== "system"
        ? first.role
        : null;
    return {
      group,
      hidden,
      stamped,
      breakBefore: stamped || differentTurn,
      breakAfter: false,
      sender: item.kind === "message" && first?.role === "bot" ? (first.from?.botId ?? null) : null,
    };
  });
  return { joins: bubbleJoins(slots), tucks: cardTucks(slots), slots };
}
