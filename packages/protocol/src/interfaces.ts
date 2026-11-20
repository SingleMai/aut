import { Data, type Effect, type Scope, type Stream } from "effect";
import type { JsonValue, RequestId } from "./common.js";
import type {
  AdapterCapabilities,
  DecisionRequest,
  DecisionResponse,
  QuestionAnswer,
  ResumeCursor,
  SessionEvent,
  StartSessionInput,
  TranscriptEntry,
  TurnInput,
} from "./domain.js";
import type { SessionHistory } from "./session-history.js";

export type AdapterErrorCode =
  | "NotSupported"
  | "ProcessExited"
  | "TransportError"
  | "ProtocolError"
  | "InvalidResponse"
  | "InvalidAnswer"
  | "RequestExpired"
  | "DeliveryIndeterminate";

export class AdapterError extends Data.TaggedError("AdapterError")<{
  readonly code: AdapterErrorCode;
  readonly message: string;
  readonly detail?: JsonValue;
}> {}

export type ClassifierErrorCode =
  | "NotConfigured"
  | "Timeout"
  | "RateLimited"
  | "TransportError"
  | "InvalidResponse";

export class ClassifierError extends Data.TaggedError("ClassifierError")<{
  readonly code: ClassifierErrorCode;
  readonly message: string;
  readonly detail?: JsonValue;
}> {}

export interface HarnessAdapter {
  readonly kind: string;
  readonly capabilities: AdapterCapabilities;
  readonly startSession: (
    input: StartSessionInput,
  ) => Effect.Effect<SessionHandle, AdapterError, Scope.Scope>;
  readonly resumeSession: (
    cursor: ResumeCursor,
    input: StartSessionInput,
  ) => Effect.Effect<SessionHandle, AdapterError, Scope.Scope>;
  /** Read persisted history without resuming execution or starting a model turn. */
  readonly readSession?: (
    cursor: ResumeCursor,
  ) => Effect.Effect<SessionHistory, AdapterError, Scope.Scope>;
}

export interface SessionHandle {
  readonly cursor: ResumeCursor;
  readonly events: Stream.Stream<SessionEvent>;
  readonly startTurn: (input: TurnInput) => Effect.Effect<void, AdapterError>;
  readonly steer: (
    input: TurnInput,
  ) => Effect.Effect<"steered" | "refused" | "indeterminate", AdapterError>;
  readonly interrupt: () => Effect.Effect<void, AdapterError>;
  /**
   * Validate the response against the complete pending request before delivery.
   * Permission approval must never satisfy a question. RequestExpired means the
   * answer is known not to have been delivered and may be submitted as a new turn.
   * DeliveryIndeterminate must not trigger a second delivery.
   */
  readonly respond: (
    requestId: RequestId,
    response: { readonly allow: true } | QuestionAnswer,
  ) => Effect.Effect<void, AdapterError>;
  /** The supplied scope owns only the fork; closing it must preserve the parent. */
  readonly fork: () => Effect.Effect<SessionHandle, AdapterError, Scope.Scope>;
  readonly transcript: () => Effect.Effect<ReadonlyArray<TranscriptEntry>, AdapterError>;
  /** Read the current session without taking ownership of the worker scope. */
  readonly readSession?: () => Effect.Effect<SessionHistory, AdapterError>;
}

export interface Classifier {
  readonly backend: string;
  readonly model: string;
  readonly decide: (request: DecisionRequest) => Effect.Effect<DecisionResponse, ClassifierError>;
}
