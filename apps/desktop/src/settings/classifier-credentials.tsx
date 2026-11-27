import { type ClassifierBackendConfig, JEV_DEFAULT_KEY_REF, SecretSaveInput } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { Effect, Schema } from "effect";
import { useState } from "react";
import { desktopApi } from "../api.js";
import { type ClassifierSlot, validKeyReference } from "../configuration-forms.js";
import { t } from "../i18n.js";
import { Icon } from "../icons.js";
import { useFormFeedback } from "../ui/configuration-form.js";
import { InputField } from "../ui/form-fields.js";
import { type Flash, useAction } from "../ui/use-action.js";

export function ClassifierCredentials({
  slot,
  custom,
  value,
  flash,
}: {
  slot: ClassifierSlot;
  custom: boolean;
  value: ClassifierBackendConfig | undefined;
  flash: Flash;
}) {
  const { report } = useFormFeedback();
  const [secretName] = useState(() => {
    const ref = value?.apiKeyRef;
    if (ref === `secret:${slot}` || ref?.startsWith(`secret:${slot}-`))
      return ref.slice("secret:".length);
    return `${slot}-${crypto.randomUUID()}`;
  });
  // A new custom destination gets its own key, independent of the official account.
  const defaultRef = custom && !value ? `secret:${secretName}` : "";
  const [keyRef, setKeyRef] = useState(value?.apiKeyRef ?? "");
  const effectiveRef = keyRef.trim() || defaultRef;
  const [credential, setCredential] = useState("");
  const [status, setStatus] = useState("");
  const save = useAction(flash);
  const check = useAction(flash);

  function saveKey() {
    const input = { name: secretName, key: credential.trim() };
    if (!Schema.is(SecretSaveInput)(input)) {
      report({ [`${slot}.credential`]: t.validation.credential });
      return;
    }
    save.run(
      Effect.gen(function* () {
        const result = yield* desktopApi.saveSecret(input);
        setKeyRef(result.apiKeyRef);
        setCredential("");
        setStatus(t.keySaved);
        report({ [`${slot}.credential`]: "", [`${slot}.key`]: "" });
      }),
    );
  }

  function checkKey() {
    const reference = effectiveRef || JEV_DEFAULT_KEY_REF;
    if (!validKeyReference(reference)) {
      report({ [`${slot}.key`]: t.validation.keyReference });
      return;
    }
    check.run(
      Effect.gen(function* () {
        const result = yield* desktopApi.getSecretStatus(reference);
        setStatus(result.configured ? t.keyConfigured : t.keyMissing);
      }),
    );
  }

  return (
    <>
      <input type="hidden" name={`${slot}.key`} value={effectiveRef} />
      {credential.length > 0 && (
        <input type="hidden" name={`${slot}.pendingCredential`} value="1" />
      )}
      <div className="credential-row">
        <InputField
          label={t.fastBrainKey}
          fieldName={`${slot}.credential`}
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          disabled={save.busy}
          value={credential}
          onChange={(e) => setCredential(e.target.value)}
        />
        <div className="credential-actions">
          <Button
            type="button"
            color="gray"
            variant="surface"
            disabled={save.busy || !credential.trim()}
            onClick={saveKey}
          >
            {t.saveKey}
          </Button>
          <Button type="button" variant="ghost" size="1" disabled={check.busy} onClick={checkKey}>
            {t.checkKey}
          </Button>
        </div>
      </div>
      <p className="credential-status" aria-live="polite">
        {status}
      </p>
      <details className="fast-brain-key-options">
        <summary>
          {t.useExistingKey}
          <Icon name="chevron" />
        </summary>
        <InputField
          label={t.keyRef}
          fieldName={`${slot}.key`}
          value={keyRef}
          placeholder={defaultRef || JEV_DEFAULT_KEY_REF}
          onChange={(event) => {
            setKeyRef(event.target.value);
            setStatus("");
          }}
        />
      </details>
    </>
  );
}
