import { Button } from "@radix-ui/themes";
import { Effect, Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { connectionAction, UiError } from "../api.js";
import { PairingPreview } from "../bridge.js";
import { t } from "../i18n.js";
import { Icon } from "../icons.js";
import { Dialog } from "../ui/dialog.js";
import { InputField } from "../ui/form-fields.js";
import { useAction } from "../ui/use-action.js";

export function PairComputerDialog({ onClose }: { onClose: () => void }) {
  const [preview, setPreview] = useState<PairingPreview>();
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const { busy, run } = useAction(setError);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      Effect.runFork(connectionAction({ action: "clear-pairing" }).pipe(Effect.ignore));
    };
  }, []);
  const inspect = (text?: string) => {
    setPreview(undefined);
    setError("");
    run(
      connectionAction({ action: "inspect", ...(text !== undefined ? { text } : {}) }).pipe(
        Effect.flatMap((result) =>
          Schema.decodeUnknown(PairingPreview)(result.preview).pipe(
            Effect.mapError(() => new UiError({ message: t.executionInvalid })),
          ),
        ),
        Effect.tap((result) =>
          Effect.sync(() => {
            if (alive.current) setPreview(result);
          }),
        ),
      ),
    );
    if (input.current) input.current.value = "";
  };
  return (
    <Dialog
      title={t.addComputer}
      maxWidth="540px"
      initialFocus="[data-pair-paste]"
      onClose={onClose}
    >
      <div className="pairing-body">
        <div className="pairing-illustration" aria-hidden="true">
          <span>
            <Icon name="laptop" />
          </span>
          <i />
          <Icon name="link" />
          <i />
          <span>
            <Icon name="computer" />
          </span>
        </div>
        <p className="muted">{t.pairingHint}</p>
        {!preview ? (
          <>
            <ol className="pairing-instructions">
              {t.pairingSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <Button
              data-pair-paste
              disabled={busy}
              className="pairing-paste"
              onClick={() => inspect()}
            >
              <Icon name="clipboard" />
              {t.pairingPaste}
            </Button>
            <details className="pairing-manual">
              <summary>{t.pairingManual}</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  inspect(input.current?.value ?? "");
                }}
              >
                <InputField
                  ref={input}
                  label={t.pairingInput}
                  placeholder={t.pairingPlaceholder}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4096}
                  required
                  disabled={busy}
                />
                <Button type="submit" variant="surface" disabled={busy}>
                  {t.pairingInspect}
                </Button>
              </form>
            </details>
          </>
        ) : (
          <>
            <div className="pairing-recognized">
              <span className="computer-symbol">
                <Icon name="computer" />
              </span>
              <div>
                <span className="settings-eyebrow">{t.pairingRecognized}</span>
                <h3>{preview.name}</h3>
              </div>
              <Icon name="check" />
            </div>
            <p className="muted">{t.pairingReadyHint}</p>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPreview(undefined);
                setError("");
                run(connectionAction({ action: "clear-pairing" }));
              }}
            >
              {t.pairingReplace}
            </Button>
          </>
        )}
        {error && (
          <p className="connection-error" role="alert">
            {error}
          </p>
        )}
        <p className="pairing-privacy">{preview ? t.pairingSwitchHint : t.pairingPrivate}</p>
      </div>
      <div className="form-actions">
        <Button variant="surface" color="gray" onClick={onClose}>
          {t.cancel}
        </Button>
        {preview && (
          <Button
            disabled={busy}
            onClick={() =>
              run(
                connectionAction({ action: "pair", id: preview.id }).pipe(
                  Effect.tap((result) =>
                    Effect.sync(() => {
                      if (!result.cancelled) onClose();
                    }),
                  ),
                ),
              )
            }
          >
            {t.executionConnect}
          </Button>
        )}
      </div>
    </Dialog>
  );
}
