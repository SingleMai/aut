import type { BotConfig, BotModelsResponse } from "@aut/protocol";
import { IconButton, Popover, TextField } from "@radix-ui/themes";
import { useId, useState } from "react";
import { t } from "../i18n.js";
import { Icon } from "../icons.js";
import { useFormFeedback } from "../ui/configuration-form.js";
import { type useBotModelOptions, useModelCatalog } from "./catalog.js";
import { ParameterOptions } from "./parameter-options.js";
import { pickerSize, usePickerAnchor } from "./use-picker-anchor.js";

type Model = BotModelsResponse["models"][number];

export function BotModelField({
  bot,
  bots,
  providers,
  cwd,
  busy,
}: {
  bot?: BotConfig | undefined;
  bots: readonly BotConfig[];
  providers: ReturnType<typeof useBotModelOptions>;
  cwd: string;
  busy: boolean;
}) {
  const seed = (bot ?? bots.find((candidate) => candidate.system === "primary") ?? bots[0])
    ?.modelSelection;
  const [draft, setDraft] = useState(() => ({
    instanceId: seed?.instanceId ?? "",
    provider: providers.options.find((option) => option.instance.id === seed?.instanceId)?.instance
      .name,
    model: seed?.model ?? "",
    label: seed?.model ?? "",
    effort: seed?.effort ?? "",
    speed: seed?.speed ?? "",
  }));
  const [open, setOpen] = useState(false);
  const [browsing, setBrowsing] = useState(draft.instanceId);
  const [search, setSearch] = useState("");
  const { errors } = useFormFeedback();
  const id = useId();
  const placement = usePickerAnchor();
  const error = errors.instance ?? errors.model;

  const source =
    providers.options.find((option) => option.instance.id === browsing) ?? providers.options[0];
  const catalog = useModelCatalog(source, cwd, open, providers.status);
  const providerName =
    providers.options.find((option) => option.instance.id === draft.instanceId)?.instance.name ??
    draft.provider;
  const selectedLabel =
    catalog.modelsFor(draft.instanceId)?.find((model) => model.model === draft.model)?.label ??
    draft.label;

  // Native ordering comes first. Append saved choices that the current catalog no longer lists.
  const choices = new Map<string, Model>(catalog.models.map((model) => [model.model, model]));
  for (const candidate of [bot, ...bots]) {
    const saved = candidate?.modelSelection;
    if (saved && saved.instanceId === source?.instance.id && !choices.has(saved.model))
      choices.set(saved.model, saved);
  }
  const selectedHere = source?.instance.id === draft.instanceId;
  if (selectedHere && draft.model && !choices.has(draft.model))
    choices.set(draft.model, { model: draft.model, label: draft.label });
  const activeModel = selectedHere ? choices.get(draft.model) : undefined;
  const query = search.toLocaleLowerCase();
  const filtered = [...choices.values()].filter((model) =>
    `${model.label ?? ""} ${model.model}`.toLocaleLowerCase().includes(query),
  );
  const pick = (model: Model) => {
    if (!source) return;
    setDraft((previous) => {
      const same = previous.instanceId === source.instance.id && previous.model === model.model;
      return {
        instanceId: source.instance.id,
        provider: source.instance.name,
        model: model.model,
        label: model.label ?? model.model,
        effort: same ? previous.effort : (model.effort ?? ""),
        speed: same ? previous.speed : (model.speed ?? ""),
      };
    });
  };

  return (
    <section className="bot-model-fields" aria-label={t.model}>
      <input type="hidden" name="instance" value={draft.instanceId} />
      <input type="hidden" name="model" value={draft.model} />
      <input type="hidden" name="effort" value={draft.effort} />
      <input type="hidden" name="speed" value={draft.speed} />
      <div data-field="instance">
        <div data-field="model">
          <label className="field-label" htmlFor={id}>
            {t.model}
          </label>
          <Popover.Root
            modal
            open={open}
            onOpenChange={(value) => {
              setOpen(value);
              if (value) {
                setBrowsing(draft.instanceId);
                setSearch("");
              }
            }}
          >
            <Popover.Trigger>
              <button
                type="button"
                ref={placement.trigger}
                id={id}
                className="bot-model-trigger"
                disabled={busy}
                aria-label={t.botModelChoose}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? `${id}-error` : undefined}
              >
                <span className="bot-model-trigger-text">
                  <strong>{draft.model ? selectedLabel : t.botModelChoose}</strong>
                  <span>
                    {[
                      providerName,
                      draft.effort ? t.botModelEffort(draft.effort) : undefined,
                      draft.speed ? t.botModelSpeed(draft.speed) : undefined,
                    ]
                      .filter(Boolean)
                      .join(" · ") || t.botModelChoose}
                  </span>
                </span>
                <Icon name="chevron" />
              </button>
            </Popover.Trigger>
            <Popover.Anchor virtualRef={placement.anchor} />
            <Popover.Content
              ref={placement.content}
              className="bot-model-picker"
              align="start"
              side="bottom"
              sideOffset={0}
              avoidCollisions={false}
              updatePositionStrategy="always"
              style={{ width: pickerSize.width, height: pickerSize.height }}
              aria-label={t.botModelChoose}
            >
              <div className="bot-model-picker-header">
                <TextField.Root
                  aria-label={t.botModelsSearch}
                  placeholder={t.botModelsSearch}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                >
                  <TextField.Slot>
                    <Icon name="search" />
                  </TextField.Slot>
                </TextField.Root>
                <IconButton
                  type="button"
                  size="2"
                  variant="ghost"
                  color="gray"
                  aria-label={t.refresh}
                  title={t.refresh}
                  disabled={catalog.loading}
                  onClick={() => {
                    catalog.clear();
                    providers.refresh();
                  }}
                >
                  <Icon name="refresh" />
                </IconButton>
                <Popover.Close>
                  <IconButton
                    type="button"
                    className="bot-model-close"
                    size="2"
                    variant="ghost"
                    color="gray"
                    aria-label={t.close}
                    title={t.close}
                  >
                    <Icon name="close" />
                  </IconButton>
                </Popover.Close>
              </div>
              <div className="bot-model-browser">
                <nav className="bot-model-programs" aria-label={t.botModelPrograms}>
                  <div className="bot-model-column-label">{t.botModelPrograms}</div>
                  {providers.options.map((option) => (
                    <button
                      type="button"
                      key={option.instance.id}
                      aria-pressed={option.instance.id === source?.instance.id}
                      onClick={() => {
                        setBrowsing(option.instance.id);
                        setSearch("");
                      }}
                    >
                      <span>{option.instance.name}</span>
                      {option.availability === "missing" ? (
                        <small>{t.botProgramNotDetected}</small>
                      ) : option.availability === "unsupported" ? (
                        <small>{t.botProgramNotSupported}</small>
                      ) : option.verification === "preview" ? (
                        <small>{t.botProgramPreview}</small>
                      ) : null}
                    </button>
                  ))}
                </nav>
                <div className="bot-model-results">
                  <div className="bot-model-column-label">{source?.instance.name ?? t.model}</div>
                  {catalog.message && (
                    <p
                      className={catalog.error ? "field-error" : "bot-model-hint"}
                      role={catalog.error ? "alert" : "status"}
                    >
                      {catalog.message}
                    </p>
                  )}
                  <fieldset className="bot-model-list" aria-label={t.model}>
                    {filtered.map((model) => {
                      const active =
                        draft.instanceId === source?.instance.id && draft.model === model.model;
                      return (
                        <button
                          type="button"
                          key={model.model}
                          aria-pressed={active}
                          onClick={() => pick(model)}
                        >
                          <span>
                            <strong>{model.label ?? model.model}</strong>
                          </span>
                          {active && <Icon name="check" />}
                        </button>
                      );
                    })}
                    {!catalog.message && !filtered.length && (
                      <p className="bot-model-hint">{t.botModelsNoMatch}</p>
                    )}
                  </fieldset>
                </div>
                <aside className="bot-model-parameters" aria-label={t.botModelParameters}>
                  {activeModel ? (
                    <>
                      <ParameterOptions
                        title={t.effort}
                        choices={activeModel.efforts}
                        value={draft.effort}
                        onChange={(effort) => setDraft((previous) => ({ ...previous, effort }))}
                        label={t.botModelEffort}
                      />
                      <ParameterOptions
                        title={t.speed}
                        choices={activeModel.speeds}
                        value={draft.speed}
                        onChange={(speed) => setDraft((previous) => ({ ...previous, speed }))}
                        label={t.botModelSpeed}
                      />
                    </>
                  ) : (
                    <p className="bot-model-hint">{t.botModelPickFirst}</p>
                  )}
                </aside>
              </div>
            </Popover.Content>
          </Popover.Root>
          {error && (
            <p id={`${id}-error`} className="field-error">
              {error}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
