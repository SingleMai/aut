import type { HandoffPacket } from "@aut/protocol";
import { renderExcerpts } from "./excerpts.js";

const renderRequest = (request: HandoffPacket["request"][number]): string =>
  [
    `[message ${JSON.stringify(request.messageId)} | at ${request.at}]\n${request.text}`,
    ...(request.files?.length
      ? [
          "[Attached file snapshots; read only. Copy to your working directory before editing.]",
          ...request.files.map((file) => JSON.stringify(file)),
        ]
      : []),
  ].join("\n");

export const renderHandoff = (packet: HandoffPacket): string =>
  [
    `[Task]\n${packet.header}`,
    `[Current request]\n${packet.request.map(renderRequest).join("\n\n")}`,
    ...(packet.excerpts.length ? [renderExcerpts(packet.excerpts)] : []),
    ...(packet.relatedTasks.length
      ? [
          `[Related task references]\n${packet.relatedTasks.map((task) => JSON.stringify(task)).join("\n")}`,
        ]
      : []),
    ...(packet.decisionSummary ? [`[Routing decision]\n${packet.decisionSummary}`] : []),
    `[Tools]\n${packet.toolHint}`,
  ].join("\n\n");
