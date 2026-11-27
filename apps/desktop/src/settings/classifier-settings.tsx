import {
  type ClassifierBackendConfig,
  JEV_ENDPOINT,
  JEV_MODEL,
  JevServiceConfig,
} from "@aut/protocol";
import { Schema } from "effect";
import { useId, useState } from "react";
import { type ClassifierSlot, classifierSource } from "../configuration-forms.js";
import { t } from "../i18n.js";
import { useFormFeedback } from "../ui/configuration-form.js";
import { InputField } from "../ui/form-fields.js";
import type { Flash } from "../ui/use-action.js";
import { ClassifierCredentials } from "./classifier-credentials.js";

export function ClassifierModelFields({
  slot,
  value,
  required,
  official,
  onEndpointChange,
}: {
  slot: ClassifierSlot;
  value?: Pick<ClassifierBackendConfig, "model" | "endpoint"> | undefined;
  required?: boolean;
  official?: boolean;
  onEndpointChange?: (endpoint: string) => void;
}) {
  return (
    <>
      {!official && (
        <InputField
          name={`${slot}.endpoint`}
          label={t.endpoint}
          defaultValue={value?.endpoint ?? ""}
          onChange={(event) => onEndpointChange?.(event.target.value)}
          placeholder="https://…/v1/systemone"
          required={required}
          wide
        />
      )}
      <InputField
        name={`${slot}.model`}
        label={t.fastBrainVersion}
        defaultValue={value?.model ?? JEV_MODEL}
        required={required}
      />
    </>
  );
}

const endpointOrigin = (endpoint: string) =>
  URL.canParse(endpoint) ? new URL(endpoint).origin : "";

export function ClassifierSettings({
  slot,
  value,
  flash,
}: {
  slot: ClassifierSlot;
  value?: ClassifierBackendConfig | undefined;
  flash: Flash;
}) {
  const original = value && classifierSource(value);
  const [source, setSource] = useState(original ?? (slot === "fallback" ? "official" : undefined));
  const [customEndpoint, setCustomEndpoint] = useState(
    original === "custom" ? (value?.endpoint ?? "") : "",
  );
  const { errors } = useFormFeedback();
  const field = `${slot}.source`;
  const errorId = useId();
  const selected = source === original ? value : undefined;
  const endpoint = source === "official" ? JEV_ENDPOINT : customEndpoint;
  const destination = endpointOrigin(endpoint.trim());
  const sources = [
    "official",
    "custom",
    ...(original === "existing" ? ["existing" as const] : []),
  ] as const;
  return (
    <div className="fast-brain-service">
      <fieldset className="fast-brain-source" data-field={field}>
        <legend className="field-label">{t.fastBrainSource}</legend>
        <div className="fast-brain-choices">
          {sources.map((option) => (
            <label key={option}>
              <input
                type="radio"
                name={field}
                value={option}
                checked={source === option}
                required
                aria-invalid={errors[field] && (source ?? "official") === option ? true : undefined}
                aria-describedby={errors[field] ? errorId : undefined}
                onChange={() => setSource(option)}
              />
              <span>{t.fastBrainSources[option]}</span>
            </label>
          ))}
        </div>
        {errors[field] && (
          <p id={errorId} className="field-error">
            {errors[field]}
          </p>
        )}
      </fieldset>
      {source === "existing" && value && (
        <>
          <p className="fast-brain-note">{t.fastBrainLegacy(value.backend, value.model)}</p>
          <input type="hidden" name={`${slot}.backend`} value={value.backend} />
          <input type="hidden" name={`${slot}.model`} value={value.model} />
          <input type="hidden" name={`${slot}.endpoint`} value={value.endpoint} />
          <input type="hidden" name={`${slot}.key`} value={value.apiKeyRef ?? ""} />
        </>
      )}
      {(source === "official" || source === "custom") && (
        <>
          {source === "custom" && <p className="fast-brain-note">{t.fastBrainCustomHint}</p>}
          <div className="form-grid">
            <ClassifierModelFields
              key={source}
              slot={slot}
              official={source === "official"}
              value={{ model: selected?.model ?? JEV_MODEL, endpoint }}
              onEndpointChange={setCustomEndpoint}
            />
          </div>
          {Schema.is(JevServiceConfig.fields.endpoint)(endpoint.trim()) && (
            <ClassifierCredentials
              key={`${source}:${destination}`}
              slot={slot}
              custom={source === "custom"}
              value={
                selected && destination === endpointOrigin(selected.endpoint) ? selected : undefined
              }
              flash={flash}
            />
          )}
        </>
      )}
    </div>
  );
}
