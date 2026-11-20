import { Data } from "effect";

export class TreeError extends Data.TaggedError("TreeError")<{
  readonly code: "Validation" | "Expression" | "StepBudget" | "Rewrite" | "Unsupported";
  readonly message: string;
}> {}
