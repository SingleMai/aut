import type { HarnessAdapter as HarnessAdapterShape } from "@aut/protocol";
import { Context } from "effect";

export class HarnessAdapter extends Context.Tag("@aut/adapters/HarnessAdapter")<
  HarnessAdapter,
  HarnessAdapterShape
>() {}

export {
  AdapterError,
  type AdapterErrorCode,
  type HarnessAdapter as HarnessAdapterShape,
  type SessionHandle,
} from "@aut/protocol";
