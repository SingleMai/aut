// Extracted from OpenMausBot src/components/chat-bubble.ts at 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0. See NOTICE.
// The host supplies slot boundaries and timestamps from either transcript.
// biome-ignore-all lint/style/noNonNullAssertion: Preserve upstream bounded iteration.
import { localDay } from "../lib/transcript-derivations.js";

export interface BubbleJoin {
  above: boolean;
  below: boolean;
}

export interface TranscriptSlot {
  /** The bubble group this row joins, or null for a row that is no bubble (a card, a chip, a separator line). */
  group: "bot" | "user" | null;
  /** The row draws nothing, so it neither joins nor breaks a group. */
  hidden: boolean;
  /** Something stands between this row and the one above it: a day stamp, the unread line, a caption. */
  breakBefore: boolean;
  /** Something follows this row before the next one: an offer card. */
  breakAfter: boolean;
  /** A time stamp or the unread line stands above the row. */
  stamped?: boolean;
  /** The bot whose own row this is, so its cards sit close under its bubbles. */
  sender?: string | null;
}

/** Each row's joins to its neighbours: a bubble joins the nearest drawn row on either side when that row is a bubble
 * of the same group and nothing stands between them. */
export function bubbleJoins(slots: readonly TranscriptSlot[]): BubbleJoin[] {
  const shown = slots.map((slot, index) => ({ slot, index })).filter(({ slot }) => !slot.hidden);
  const joins: BubbleJoin[] = slots.map(() => ({ above: false, below: false }));
  for (let at = 1; at < shown.length; at++) {
    const upper = shown[at - 1]!;
    const lower = shown[at]!;
    if (
      !upper.slot.group ||
      upper.slot.group !== lower.slot.group ||
      upper.slot.breakAfter ||
      lower.slot.breakBefore
    )
      continue;
    joins[upper.index]!.below = true;
    joins[lower.index]!.above = true;
  }
  return joins;
}

/** Simple mode: a card sits 12px under its own bot's bubble, and a bubble 12px under its card, instead of the 16px
 * between senders. Two bubbles join instead, and a stamp between rows keeps the full gap. */
export function cardTucks(slots: readonly TranscriptSlot[]): boolean[] {
  const tucks = slots.map(() => false);
  let previous: TranscriptSlot | null = null;
  slots.forEach((slot, index) => {
    if (slot.hidden) return;
    tucks[index] = Boolean(
      previous &&
        slot.sender &&
        slot.sender === previous.sender &&
        !slot.stamped &&
        !previous.breakAfter &&
        !(slot.group && previous.group),
    );
    previous = slot;
  });
  return tucks;
}

/** Simple mode stamps the time again after a quiet spell, not only when the day changes. */
export const STAMP_GAP_MS = 15 * 60_000;

export function needsStamp(
  prev: { readonly at: number } | undefined,
  first: { readonly at: number },
  simple: boolean,
): boolean {
  return (
    !prev ||
    localDay(prev.at) !== localDay(first.at) ||
    (simple && first.at - prev.at >= STAMP_GAP_MS)
  );
}
