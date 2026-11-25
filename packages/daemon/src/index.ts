import {
  ChiefLive,
  CoreLive,
  HandoffBuilderLive,
  OperationExecutorLive,
  PrimaryAssistantLive,
  ProgressQueryLive,
  QuestionsServiceLive,
  SessionManagerLive,
  SessionReaderLive,
  SessionReplyGateLive,
  SessionRequestRouterLive,
  SessionSnapshotSourceLive,
  SlowBrainLive,
  StateSourceLive,
  StoredSessionSnapshotSourceLive,
} from "@aut/core";
import { Effect, Layer } from "effect";
import { AdministrationLive } from "./admin.js";
import { AdmissionInboxLive, ChiefIngressLive } from "./admission.js";
import { BridgeBackendLive } from "./bridge-backend.js";
import { BridgeRuntimeLive } from "./bridge-runtime.js";
import { ConfiguredTreeLive } from "./configured-tree.js";
import { FileMaintenanceLive } from "./file-maintenance.js";
import { HttpServerLive } from "./http.js";
import { InboundGatewayLive } from "./inbound.js";
import { McpOAuthLive } from "./mcp-oauth.js";
import { McpSupervisorLive } from "./mcp-supervisor.js";
import { MemoryDreamsLive } from "./memory-dreams.js";
import { AuthenticationLive, OwnershipLive } from "./ownership.js";
import {
  PrimaryAssistantBootstrapLive,
  PrimaryAssistantDefaultsProbeLive,
} from "./primary-assistant.js";
import { RecoveryLive } from "./recovery.js";
import { RouteTestLive } from "./route-test.js";
import { type DaemonOptions, DaemonRuntimeLive, environmentOptions } from "./runtime.js";
import { SecretReaderLive } from "./secret-reader.js";
import { SecretStoreLive } from "./secret-store.js";
import { HarnessResolverLive, SessionBridgeLive, SessionSetupLive } from "./session-setup.js";
import { TriggerSchedulerLive } from "./triggers.js";

export * from "./admin.js";
export * from "./admission.js";
export * from "./bridge-backend.js";
export * from "./bridge-runtime.js";
export * from "./configured-tree.js";
export * from "./errors.js";
export * from "./http.js";
export * from "./inbound.js";
export * from "./mcp-oauth.js";
export * from "./mcp-supervisor.js";
export * from "./memory-dreams.js";
export * from "./ownership.js";
export * from "./primary-assistant.js";
export * from "./recovery.js";
export * from "./route-test.js";
export * from "./runtime.js";
export * from "./secret-reader.js";
export * from "./secret-store.js";
export * from "./session-setup.js";
export * from "./triggers.js";

/** API contract harness, without worker execution or default configuration discovery. */
export const DaemonApiLive = (options: DaemonOptions = {}) => {
  const core = Layer.merge(CoreLive(options), AdmissionInboxLive).pipe(
    Layer.provideMerge(OwnershipLive(options)),
  );
  const tree = ConfiguredTreeLive.pipe(
    Layer.provideMerge(
      Layer.merge(core, SecretReaderLive.pipe(Layer.provideMerge(SecretStoreLive(options)))),
    ),
  );
  const mcp = McpSupervisorLive.pipe(Layer.provide(McpOAuthLive), Layer.provideMerge(tree));
  const services = Layer.mergeAll(
    AuthenticationLive,
    RecoveryLive,
    InboundGatewayLive,
    AdministrationLive,
    RouteTestLive,
    FileMaintenanceLive,
  ).pipe(Layer.provideMerge(mcp));
  const memory = MemoryDreamsLive.pipe(Layer.provideMerge(services));
  const readers = SessionReaderLive.pipe(
    Layer.provideMerge(
      Layer.merge(HarnessResolverLive, StoredSessionSnapshotSourceLive).pipe(
        Layer.provideMerge(memory),
      ),
    ),
  );
  return HttpServerLive(options.port).pipe(Layer.provideMerge(readers));
};

export const DaemonLive = (options: DaemonOptions = {}) => {
  const baseInfrastructure = Layer.mergeAll(
    CoreLive(options),
    AdmissionInboxLive,
    SessionBridgeLive,
    SecretReaderLive.pipe(Layer.provideMerge(SecretStoreLive(options))),
    PrimaryAssistantDefaultsProbeLive,
  ).pipe(Layer.provideMerge(OwnershipLive(options)));
  const infrastructure = McpSupervisorLive.pipe(
    Layer.provide(McpOAuthLive),
    Layer.provideMerge(baseInfrastructure),
  );
  const recovered = Layer.merge(RecoveryLive, PrimaryAssistantBootstrapLive(options)).pipe(
    Layer.provideMerge(infrastructure),
  );
  const tree = ConfiguredTreeLive.pipe(Layer.provideMerge(recovered));
  const memory = MemoryDreamsLive.pipe(Layer.provideMerge(tree));
  const ports = Layer.mergeAll(
    AuthenticationLive,
    InboundGatewayLive,
    AdministrationLive,
    RouteTestLive,
    FileMaintenanceLive,
    HarnessResolverLive,
    SessionSetupLive,
    StateSourceLive,
    PrimaryAssistantLive,
    HandoffBuilderLive(),
    SessionReplyGateLive(),
    SessionRequestRouterLive,
  ).pipe(Layer.provideMerge(memory));
  const sessions = SessionManagerLive().pipe(Layer.provideMerge(ports));
  const readers = SessionReaderLive.pipe(
    Layer.provideMerge(SessionSnapshotSourceLive.pipe(Layer.provideMerge(sessions))),
  );
  const operations = Layer.mergeAll(QuestionsServiceLive, ProgressQueryLive(), SlowBrainLive).pipe(
    Layer.provideMerge(readers),
  );
  const chief = ChiefLive.pipe(
    Layer.provideMerge(OperationExecutorLive.pipe(Layer.provideMerge(operations))),
  );
  const bridge = BridgeRuntimeLive.pipe(
    Layer.provideMerge(BridgeBackendLive.pipe(Layer.provideMerge(chief))),
  );
  const ingress = ChiefIngressLive.pipe(Layer.provideMerge(bridge));
  const scheduler = TriggerSchedulerLive.pipe(
    Layer.provideMerge(chief),
    Layer.provideMerge(recovered),
  );
  return HttpServerLive(options.port).pipe(Layer.provideMerge(Layer.merge(ingress, scheduler)));
};

export const DaemonFromEnvironmentLive = Layer.unwrapEffect(
  environmentOptions.pipe(
    Effect.map((options) => DaemonRuntimeLive.pipe(Layer.provide(DaemonLive(options)))),
  ),
);
