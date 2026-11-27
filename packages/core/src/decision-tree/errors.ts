import type { ClassifierErrorCode } from "@aut/protocol";
import { Data } from "effect";

export class TreeError extends Data.TaggedError("TreeError")<{
  readonly code:
    | "Validation"
    | "Expression"
    | "StepBudget"
    | "Rewrite"
    | "Unsupported"
    | "Classification";
  readonly message: string;
  readonly classifierCode?: ClassifierErrorCode;
}> {}
