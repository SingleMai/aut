import type { HandoffPacket } from "@aut/protocol";

export const EXCERPT_HEADING = "[Relevant excerpts]\n";
export const renderExcerpt = (
  excerpt: Pick<HandoffPacket["excerpts"][number], "messageId" | "at" | "author" | "text">,
): string =>
  `[message ${JSON.stringify(excerpt.messageId)} | at ${excerpt.at} | author ${JSON.stringify(excerpt.author)}]\n${excerpt.text}\n`;

/** UTF-8 bytes conservatively bound byte-tokenizer tokens, including rendered metadata. */
export const estimateTokens = (text: string): number => Buffer.byteLength(text, "utf8");

export const renderHandoff = (packet: HandoffPacket): string =>
  [
    `[Task]\n${packet.header}`,
    `[Current request]\n${packet.request.map((request) => `[message ${JSON.stringify(request.messageId)} | at ${request.at}]\n${request.text}`).join("\n\n")}`,
    ...(packet.excerpts.length
      ? [`${EXCERPT_HEADING}${packet.excerpts.map(renderExcerpt).join("\n")}`]
      : []),
    ...(packet.relatedTasks.length
      ? [
          `[Related task references]\n${packet.relatedTasks.map((task) => JSON.stringify(task)).join("\n")}`,
        ]
      : []),
    ...(packet.decisionSummary ? [`[Routing decision]\n${packet.decisionSummary}`] : []),
    `[Tools]\n${packet.toolHint}`,
  ].join("\n\n");
