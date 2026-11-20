// Adapted from OpenMausBot (Apache-2.0), commit 738ec88472a3b888ff7b7793755d89da613ed301:
// src/components/chat-bubble.ts, src/lib/transcript-derivations.ts,
// src/lib/bottom-follow.ts, src/lib/transcript-follow.ts and src/hooks/use-transcript-viewport.ts.
// Adaptation: group aut messages by both author and task; never join cards or status rows.
import type { MainThreadMessage } from "@aut/protocol";
import {
  bubbleJoins,
  needsStamp,
  type TranscriptSlot,
} from "./openmausbot/components/chat-bubble.js";
import { BOTTOM_FOLLOW_THRESHOLD } from "./openmausbot/lib/bottom-follow.js";

export interface MessageLayout {
  readonly showTime: boolean;
  readonly joinedAbove: boolean;
  readonly joinedBelow: boolean;
  readonly showAuthor: boolean;
  readonly reportId?: string;
}

const isBubble = (message: MainThreadMessage): boolean =>
  message.card === undefined && (message.kind === "text" || message.kind === "reply");

const taskOf = (message: MainThreadMessage) =>
  message.taskId ?? (typeof message.author === "object" ? message.author.taskId : undefined);

const sameAuthor = (a: MainThreadMessage, b: MainThreadMessage): boolean => {
  if (typeof a.author === "string" || typeof b.author === "string") return a.author === b.author;
  return a.author.botId === b.author.botId && a.author.taskId === b.author.taskId;
};

/** Input order is the daemon's message order; visual grouping never reorders the transcript. */
export const deriveMessageLayout = (
  messages: readonly MainThreadMessage[],
): readonly MessageLayout[] => {
  const slots = messages.map((message, index) => {
    const previous = messages[index - 1];
    const stamped = needsStamp(previous, message, true);
    return {
      group: isBubble(message) ? (message.author === "user" ? "user" : "bot") : null,
      hidden: false,
      breakBefore:
        stamped ||
        (previous !== undefined &&
          (!sameAuthor(previous, message) || taskOf(previous) !== taskOf(message))),
      breakAfter: false,
      stamped,
    } satisfies TranscriptSlot;
  });
  const rows: MessageLayout[] = bubbleJoins(slots).map(({ above, below }, index) => {
    // biome-ignore lint/style/noNonNullAssertion: bubbleJoins returns exactly one row per slot.
    const message = messages[index]!;
    return {
      showTime: slots[index]?.stamped ?? false,
      joinedAbove: above,
      joinedBelow: below,
      showAuthor:
        message.author !== "user" && message.kind !== "ack" && message.kind !== "notice" && !above,
    };
  });
  // A joined reply shares the avatar at the beginning of its bubble group.
  let header = 0;
  for (const [index, message] of messages.entries()) {
    if (!rows[index]?.joinedAbove) header = index;
    const row = rows[header];
    if (row && message.kind === "reply" && message.fullReportRef) {
      rows[header] = { ...row, reportId: message.id };
    }
  }
  return rows;
};

export interface ConversationScrollMetrics {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
}

/** Match the upstream live-end tolerance, including fractional pixels and browser overscroll. */
export const isAtConversationEnd = ({
  scrollHeight,
  scrollTop,
  clientHeight,
}: ConversationScrollMetrics): boolean =>
  scrollHeight - scrollTop - clientHeight < BOTTOM_FOLLOW_THRESHOLD;

type ConversationExtent = Pick<ConversationScrollMetrics, "scrollHeight" | "clientHeight">;

export const canScrollConversation = ({
  scrollHeight,
  clientHeight,
}: ConversationExtent): boolean => scrollHeight - clientHeight >= 1;

/** aut keeps all loaded rows mounted, so only older daemon history can extend a short view. */
export const canScrollConversationUp = (metrics: ConversationExtent, hasOlder: boolean): boolean =>
  canScrollConversation(metrics) || hasOlder;
