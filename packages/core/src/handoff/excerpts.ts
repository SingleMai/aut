import type { HandoffPacket } from "@aut/protocol";

type Excerpt = Pick<HandoffPacket["excerpts"][number], "messageId" | "at" | "author" | "text">;

const HEADING = "[Relevant excerpts]\n";
const SEPARATOR = "\n";
const renderExcerpt = (excerpt: Excerpt): string =>
  `[message ${JSON.stringify(excerpt.messageId)} | at ${excerpt.at} | author ${JSON.stringify(excerpt.author)}]\n${excerpt.text}\n`;

/** A conservative bound for handoff excerpts, not native session token usage. */
const estimateTokens = (text: string): number => Buffer.byteLength(text, "utf8");

export const renderExcerpts = (excerpts: readonly Excerpt[]): string =>
  excerpts.length ? `${HEADING}${excerpts.map(renderExcerpt).join(SEPARATOR)}` : "";

/** Reserve a separator per candidate so selection is independent of its final position. */
export const estimateExcerptCost = (excerpt: Excerpt): number =>
  estimateTokens(`${renderExcerpt(excerpt)}${SEPARATOR}`);

export const availableExcerptBudget = (budget: number): number =>
  Math.max(0, budget - estimateTokens(HEADING));

export const excerptsFitBudget = (excerpts: readonly Excerpt[], budget: number): boolean =>
  estimateTokens(renderExcerpts(excerpts)) <= budget;
