import type { BotModelsResponse } from "@aut/protocol";
import { t } from "../i18n.js";
import { Icon } from "../icons.js";

export function ParameterOptions({
  title,
  choices,
  value,
  onChange,
  label,
}: {
  title: string;
  choices: BotModelsResponse["models"][number]["efforts"];
  value: string;
  onChange: (value: string) => void;
  label: (value: string, fallback?: string) => string;
}) {
  const options = new Map<string, string>();
  if (choices?.length || value) options.set("", t.botModelAuto);
  for (const choice of choices ?? []) options.set(choice.value, label(choice.value, choice.label));
  if (value && !options.has(value)) options.set(value, `${label(value)} · ${t.botModelRetained}`);
  return (
    <fieldset className="bot-model-parameter" aria-label={title}>
      <legend>{title}</legend>
      <div className="bot-model-parameter-values">
        {options.size ? (
          [...options].map(([choice, text]) => (
            <button
              type="button"
              key={choice}
              aria-pressed={value === choice}
              onClick={() => onChange(choice)}
            >
              <span>{text}</span>
              {value === choice && <Icon name="check" />}
            </button>
          ))
        ) : (
          <p className="bot-model-hint">{t.botModelDecides}</p>
        )}
      </div>
    </fieldset>
  );
}
