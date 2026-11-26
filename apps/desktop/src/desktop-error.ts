import { Data } from "effect";

export class DesktopError extends Data.TaggedError("DesktopError")<{
  readonly code: string;
  readonly message: string;
}> {}

export const desktopError = (code: string, message: string) => new DesktopError({ code, message });
