import { type ClassifierBackendConfig, SecretSaveInput } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { Effect, Schema } from "effect";
import { useState } from "react";
import { desktopApi } from "./api.js";
import { type ClassifierSlot, validKeyReference } from "./configuration-forms.js";
import { t } from "./i18n.js";
import { useFormFeedback } from "./ui/configuration-form.js";
import { InputField } from "./ui/form-fields.js";
import { type Flash, useAction } from "./ui/use-action.js";

export function ClassifierModelFields({
  slot,
  value,
  required,
}: {
  slot: ClassifierSlot;
  value?: Pick<ClassifierBackendConfig, "model" | "endpoint"> | undefined;
  required?: boolean;
}) {
  return (
    <>
      <InputField
        name={`${slot}.model`}
        label={t.model}
        defaultValue={value?.model ?? ""}
        required={required}
      />
      <InputField
        name={`${slot}.endpoint`}
        label={t.endpoint}
        defaultValue={value?.endpoint ?? ""}
        required={required}
        wide
      />
    </>
  );
}

export function ClassifierSettings({
  slot,
  value,
  flash,
}: {
  slot: ClassifierSlot;
  value?: ClassifierBackendConfig | undefined;
  flash: Flash;
}) {
  const { report } = useFormFeedback();
  const [keyRef, setKeyRef] = useState(value?.apiKeyRef ?? "");
  const [credential, setCredential] = useState("");
  const [status, setStatus] = useState("");
  const save = useAction(flash);
  const check = useAction(flash);
  const label = slot === "primary" ? t.primary : t.fallback;
  return (
    <section className="settings-section">
      <h2>{label}</h2>
      <div className="form-grid">
        <InputField
          name={`${slot}.backend`}
          label={t.backend}
          defaultValue={value?.backend ?? ""}
        />
        <ClassifierModelFields slot={slot} value={value} />
        <InputField
          label={t.keyRef}
          wide
          name={`${slot}.key`}
          value={keyRef}
          onChange={(e) => {
            setKeyRef(e.target.value);
            setStatus("");
          }}
        />
      </div>
      <div className="credential-row">
        <InputField
          label={`${label}密钥`}
          fieldName={`${slot}.credential`}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          aria-label={`${label}密钥`}
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
        />
        <div className="credential-actions">
          <Button
            type="button"
            color="gray"
            variant="surface"
            disabled={save.busy}
            onClick={() => {
              const input = { name: slot, key: credential.trim() };
              if (!Schema.is(SecretSaveInput)(input)) {
                report({ [`${slot}.credential`]: t.validation.credential });
                return;
              }
              save.run(
                desktopApi.saveSecret(input).pipe(
                  Effect.tap((result) =>
                    Effect.sync(() => {
                      setKeyRef(result.apiKeyRef);
                      setCredential("");
                      setStatus(t.keySaved);
                    }),
                  ),
                ),
              );
            }}
          >
            {t.saveKey}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="1"
            disabled={check.busy}
            onClick={() => {
              if (keyRef.trim() && !validKeyReference(keyRef.trim())) {
                report({ [`${slot}.key`]: t.validation.keyReference });
                return;
              }
              check.run(
                desktopApi
                  .getSecretStatus(keyRef.trim() || "env:TYPESAFE_API_KEY")
                  .pipe(
                    Effect.tap((result) =>
                      Effect.sync(() =>
                        setStatus(result.configured ? t.keyConfigured : t.keyMissing),
                      ),
                    ),
                  ),
              );
            }}
          >
            {t.checkKey}
          </Button>
        </div>
      </div>
      <p className="credential-status" aria-live="polite">
        {status}
      </p>
      <p className="credential-hint">{t.keyHint}</p>
    </section>
  );
}
