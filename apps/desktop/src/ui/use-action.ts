import { Effect } from "effect";
import { useCallback, useRef, useState } from "react";
import type { UiError } from "../api.js";
import { t } from "../i18n.js";

export type Flash = (message: string) => void;
export const runUi = <A>(effect: Effect.Effect<A, UiError>, flash: Flash) =>
  Effect.runFork(
    effect.pipe(
      Effect.catchAll((error) => Effect.sync(() => flash(`${t.error}：${error.message}`))),
    ),
  );

export function useAction(flash: Flash) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const run = useCallback(
    <A>(effect: Effect.Effect<A, UiError>) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      runUi(
        effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              pending.current = false;
              setBusy(false);
            }),
          ),
        ),
        flash,
      );
    },
    [flash],
  );
  return { busy, run };
}
