import { Effect } from "effect";
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { UiError } from "../api.js";
import type { FieldErrors, FieldMessages } from "../configuration-forms.js";
import { type Flash, useAction } from "./use-action.js";

const Feedback = createContext<{
  errors: FieldMessages;
  report: (errors: FieldMessages) => void;
}>({ errors: {}, report: () => {} });
export const useFormFeedback = () => useContext(Feedback);

export function ConfigurationForm({
  className,
  flash,
  submit,
  children,
  onErrors,
}: {
  className: string;
  flash: Flash;
  submit: (data: FormData) => Effect.Effect<unknown, FieldErrors | UiError>;
  children: (busy: boolean) => ReactNode;
  onErrors?: (errors: FieldMessages) => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [errors, setErrors] = useState<FieldMessages>({});
  const focus = useRef<FieldMessages>(null);
  const save = useAction(flash);
  function report(next: FieldMessages) {
    onErrors?.(next);
    focus.current = next;
    setErrors((previous) => ({ ...previous, ...next }));
  }

  useLayoutEffect(() => {
    const reported = focus.current;
    if (!reported) return;
    focus.current = null;
    let first: HTMLElement | undefined;
    for (const field of form.current?.querySelectorAll<HTMLElement>("[data-field]") ?? []) {
      if (!reported[field.dataset.field ?? ""] || !errors[field.dataset.field ?? ""]) continue;
      const control = field.querySelector<HTMLElement>('[aria-invalid="true"]');
      if (!control) continue;
      for (
        let details = control.closest("details");
        details;
        details = details.parentElement?.closest("details") ?? null
      )
        details.open = true;
      first ??= control;
    }
    first?.focus();
  }, [errors]);

  return (
    <Feedback.Provider value={{ errors, report }}>
      <form
        className={className}
        ref={form}
        noValidate
        onChange={(event) => {
          const name =
            event.target instanceof Element &&
            event.target.closest<HTMLElement>("[data-field]")?.dataset.field;
          if (name && errors[name])
            setErrors((previous) => {
              const next = { ...previous };
              delete next[name];
              return next;
            });
        }}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          setErrors({});
          save.run(
            submit(data).pipe(
              Effect.catchTag("FieldErrors", (error) => Effect.sync(() => report(error.fields))),
            ),
          );
        }}
      >
        {children(save.busy)}
      </form>
    </Feedback.Provider>
  );
}
