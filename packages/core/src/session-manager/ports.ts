import type {
  BotConfig,
  HarnessAdapter,
  MainThreadMessage,
  SessionHandle,
  SessionRequest,
  StartSessionInput,
  Task,
  TurnInput,
} from "@aut/protocol";
import { Context, type Effect, type Scope } from "effect";
import type { CoreError } from "../errors.js";
import type { ReportFiles } from "../message-files.js";

export class HarnessResolver extends Context.Tag("aut/SessionManager/HarnessResolver")<
  HarnessResolver,
  {
    readonly resolve: (instanceId: string) => Effect.Effect<HarnessAdapter, CoreError>;
  }
>() {}

/** Includes the aut MCP bridge. No global provider or workspace configuration writes. */
export class SessionSetup extends Context.Tag("aut/SessionManager/SessionSetup")<
  SessionSetup,
  {
    readonly prepare: (
      task: Task,
      bot: BotConfig,
    ) => Effect.Effect<StartSessionInput, CoreError, Scope.Scope>;
  }
>() {}

export interface HandoffInput {
  readonly task: Task;
  readonly bot: BotConfig;
  readonly messages: readonly MainThreadMessage[];
  readonly mode: "new" | "send";
}
export class HandoffBuilder extends Context.Tag("aut/SessionManager/HandoffBuilder")<
  HandoffBuilder,
  {
    readonly build: (input: HandoffInput) => Effect.Effect<TurnInput, CoreError>;
  }
>() {}

export interface SessionReplyInput {
  readonly task: Task;
  readonly report: string;
  readonly reportEventId: string;
  readonly session: SessionHandle;
  readonly adapter: HarnessAdapter;
  readonly sessionInput: StartSessionInput;
}
export interface SessionReplyResult extends ReportFiles {
  readonly delivered: string;
  readonly rewrites: number;
}
export interface SessionSnapshot {
  readonly task: Task;
  readonly live?: {
    readonly session: Pick<SessionHandle, "cursor" | "fork" | "transcript" | "readSession">;
    readonly adapter: HarnessAdapter;
    readonly input: StartSessionInput;
  };
}
/** Returns checked text; the manager atomically publishes it only while ownership is current. */
export class SessionReplyGate extends Context.Tag("aut/SessionManager/SessionReplyGate")<
  SessionReplyGate,
  {
    readonly check: (
      input: SessionReplyInput,
    ) => Effect.Effect<SessionReplyResult, CoreError, Scope.Scope>;
  }
>() {}

/** The adapter already handles permissions; this port logs routing and relays question cards. */
export class SessionRequestRouter extends Context.Tag("aut/SessionManager/SessionRequestRouter")<
  SessionRequestRouter,
  {
    readonly opened: (request: SessionRequest, eventId: string) => Effect.Effect<void, CoreError>;
  }
>() {}
