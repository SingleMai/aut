import { MessageFiles } from "@aut/core";
import { Effect, Layer, Schedule } from "effect";

/** Only unreferenced, expired upload drafts are eligible; reports remain permanent. */
export const FileMaintenanceLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const files = yield* MessageFiles;
    yield* files.collect.pipe(
      Effect.catchAll(() =>
        Effect.logWarning("Attachment cleanup failed; retrying on the next scheduled pass"),
      ),
      Effect.repeat({ schedule: Schedule.spaced("1 hour") }),
      Effect.forkScoped,
    );
  }),
);
