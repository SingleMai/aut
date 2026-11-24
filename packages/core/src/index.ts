import { Layer } from "effect";
import { ChangesLive } from "./changes.js";
import { ConfigStoreLive } from "./config-store.js";
import type { CoreOptions } from "./data-directory.js";
import { DecisionLogLive } from "./decision-log.js";
import { EventBusLive } from "./event-bus.js";
import { MainThreadLive } from "./main-thread.js";
import { McpRegistryLive } from "./mcp-registry.js";
import { MessageFilesLive } from "./message-files.js";
import { SessionRecordsLive } from "./session-records.js";
import { StoreLive } from "./sqlite-store.js";
import { TaskRegistryLive } from "./task-registry.js";
import { TriggerRegistryLive } from "./triggers.js";

export * from "./bot-creation.js";
export * from "./changes.js";
export * from "./chief/chief.js";
export * from "./chief/ports.js";
export * from "./chief/state-source.js";
export * from "./config-store.js";
export * from "./data-directory.js";
export * from "./decision-log.js";
export * from "./decision-tree/engine.js";
export * from "./decision-tree/errors.js";
export * from "./decision-tree/expression.js";
export * from "./decision-tree/handoff-prune.js";
export * from "./decision-tree/inbound.js";
export * from "./decision-tree/reply-gate.js";
export * from "./decision-tree/request.js";
export * from "./decision-tree/trigger.js";
export * from "./errors.js";
export * from "./event-bus.js";
export * from "./handoff/builder.js";
export * from "./handoff/render.js";
export * from "./main-thread.js";
export * from "./mcp-registry.js";
export * from "./message-files.js";
export * from "./operations.js";
export * from "./primary-assistant.js";
export * from "./progress/progress.js";
export * from "./progress/template.js";
export * from "./questions.js";
export * from "./reply-gate.js";
export { expireTaskRequests, validateQuestionAnswer } from "./request-cards.js";
export * from "./session-manager/manager.js";
export * from "./session-manager/op-executor.js";
export * from "./session-manager/ports.js";
export * from "./session-reader.js";
export * from "./session-records.js";
export * from "./slow-brain/service.js";
export * from "./sqlite-store.js";
export * from "./storage-model.js";
export * from "./store.js";
export * from "./task-registry.js";
export * from "./triggers.js";

export const CoreLive = (options: CoreOptions = {}) =>
  Layer.mergeAll(
    Layer.mergeAll(
      MainThreadLive,
      TaskRegistryLive,
      DecisionLogLive,
      McpRegistryLive,
      SessionRecordsLive,
      TriggerRegistryLive,
      MessageFilesLive(options),
    ).pipe(Layer.provideMerge(StoreLive(options)), Layer.provideMerge(ConfigStoreLive(options))),
    EventBusLive,
  ).pipe(Layer.provideMerge(ChangesLive));
