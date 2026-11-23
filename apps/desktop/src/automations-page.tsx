import {
  type BotConfig,
  CreateTriggerInput,
  type Trigger,
  type TriggerRun,
  TriggerSchedule,
  UpdateTriggerInput,
} from "@aut/protocol";
import { Badge, Button, Select } from "@radix-ui/themes";
import { Effect } from "effect";
import { type SyntheticEvent, useEffect, useMemo, useState } from "react";
import { UiError, validate } from "./api.js";
import type { DesktopData } from "./desktop-data.js";
import { formatTime, t } from "./i18n.js";
import { Icon } from "./icons.js";
import { ConfigurationForm } from "./ui/configuration-form.js";
import { Dialog } from "./ui/dialog.js";
import { InputField, SelectField, TextAreaField } from "./ui/form-fields.js";
import type { Flash } from "./ui/use-action.js";
import { useAction } from "./ui/use-action.js";

type ScheduleKind = TriggerSchedule["kind"];

const localDateTimeValue = (at: number) => {
  const date = new Date(at);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(at - offset).toISOString().slice(0, 16);
};

const intervalText = (everyMs: number) => {
  const units = [
    { size: 86_400_000, label: "天" },
    { size: 3_600_000, label: "小时" },
    { size: 60_000, label: "分钟" },
    { size: 1_000, label: "秒" },
  ];
  const unit = units.find(({ size }) => everyMs >= size && everyMs % size === 0);
  if (!unit) return `${everyMs} 毫秒`;
  return `${everyMs / unit.size} ${unit.label}`;
};

const scheduleText = (trigger: Trigger) => {
  switch (trigger.schedule.kind) {
    case "once":
      return `${t.automationOnce} · ${formatTime(trigger.schedule.at)}`;
    case "daily":
      return `${t.automationDaily} · ${trigger.schedule.at} (${trigger.schedule.timeZone ?? "UTC"})`;
    case "interval":
      return `${t.automationInterval} · ${t.automationEveryUnit} ${intervalText(trigger.schedule.everyMs)}`;
    case "cron":
      return `${t.automationCron} · ${trigger.schedule.expression} (${trigger.schedule.timeZone ?? "UTC"})`;
  }
};

const runStatus = (status: TriggerRun["status"]) => t.automationRunStatus[status];

const readText = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

const readSchedule = (form: FormData): Effect.Effect<TriggerSchedule, UiError> => {
  const kind = readText(form, "kind") as ScheduleKind;
  switch (kind) {
    case "once": {
      const at = Date.parse(readText(form, "onceAt"));
      return validate(TriggerSchedule, { kind, at: Number.isFinite(at) ? at : -1 });
    }
    case "daily": {
      const at = readText(form, "dailyAt");
      const timeZone = readText(form, "timeZone");
      return validate(TriggerSchedule, {
        kind,
        at,
        ...(timeZone ? { timeZone } : {}),
      });
    }
    case "interval": {
      const everyMs = Number(readText(form, "everyMs"));
      const startAt = Number(readText(form, "intervalStartAt")) || Date.now();
      return validate(TriggerSchedule, { kind, startAt, everyMs });
    }
    case "cron": {
      const expression = readText(form, "cron");
      const timeZone = readText(form, "timeZone");
      return validate(TriggerSchedule, {
        kind,
        expression,
        ...(timeZone ? { timeZone } : {}),
      });
    }
    default:
      return Effect.fail(new UiError({ message: "请选择有效的执行计划。" }));
  }
};

function TriggerEditor({
  trigger,
  bots,
  data,
  flash,
  close,
}: {
  trigger?: Trigger;
  bots: readonly BotConfig[];
  data: DesktopData;
  flash: Flash;
  close: () => void;
}) {
  const initialSchedule = trigger?.schedule;
  const [kind, setKind] = useState<ScheduleKind>(initialSchedule?.kind ?? "daily");
  const submit = (form: FormData) =>
    Effect.gen(function* () {
      const schedule = yield* readSchedule(form);
      const name = readText(form, "name");
      const botId = readText(form, "botId");
      const prompt = readText(form, "prompt");
      if (trigger) {
        const input = yield* validate(UpdateTriggerInput, { name, botId, prompt, schedule });
        yield* data.updateTrigger(trigger.id, input);
        flash(t.automationUpdated);
      } else {
        const input = yield* validate(CreateTriggerInput, {
          name,
          botId,
          prompt,
          payload: {},
          schedule,
          enabled: true,
        });
        yield* data.createTrigger(input);
        flash(t.automationCreated);
      }
      close();
    });

  return (
    <Dialog
      title={trigger ? `${t.edit} ${trigger.name}` : t.newAutomation}
      onClose={close}
      initialFocus='[name="name"]'
    >
      <ConfigurationForm className="editor-form" flash={flash} submit={submit}>
        {(busy) => (
          <>
            <div className="form-body">
              <InputField
                name="name"
                label={t.automationName}
                defaultValue={trigger?.name ?? ""}
                required
              />
              <SelectField
                name="botId"
                label="Bot"
                required
                defaultValue={trigger?.botId ?? bots[0]?.id}
              >
                {bots.map((bot) => (
                  <Select.Item key={bot.id} value={bot.id}>
                    {bot.name}
                  </Select.Item>
                ))}
              </SelectField>
              <TextAreaField
                name="prompt"
                label={t.automationPrompt}
                defaultValue={trigger?.prompt ?? ""}
                rows={4}
                required
              />
              <SelectField
                name="kind"
                label={t.automationSchedule}
                value={kind}
                onValueChange={(value) => setKind(value as ScheduleKind)}
              >
                <Select.Item value="once">{t.automationOnce}</Select.Item>
                <Select.Item value="daily">{t.automationDaily}</Select.Item>
                <Select.Item value="interval">{t.automationInterval}</Select.Item>
                <Select.Item value="cron">{t.automationCron}</Select.Item>
              </SelectField>
              {kind === "once" && (
                <InputField
                  name="onceAt"
                  label={t.automationAt}
                  type="datetime-local"
                  defaultValue={
                    initialSchedule?.kind === "once" ? localDateTimeValue(initialSchedule.at) : ""
                  }
                  required
                />
              )}
              {kind === "daily" && (
                <div className="form-grid">
                  <InputField
                    name="dailyAt"
                    label={t.automationAt}
                    type="time"
                    defaultValue={initialSchedule?.kind === "daily" ? initialSchedule.at : "09:00"}
                    required
                  />
                  <InputField
                    name="timeZone"
                    label={t.automationTimezone}
                    defaultValue={
                      initialSchedule?.kind === "daily"
                        ? (initialSchedule.timeZone ?? "UTC")
                        : "UTC"
                    }
                  />
                </div>
              )}
              {kind === "interval" && (
                <div className="form-grid">
                  <InputField
                    name="everyMs"
                    label={t.automationEvery}
                    type="number"
                    min="1"
                    defaultValue={
                      initialSchedule?.kind === "interval"
                        ? String(initialSchedule.everyMs)
                        : "3600000"
                    }
                    required
                  />
                  <input
                    type="hidden"
                    name="intervalStartAt"
                    value={
                      initialSchedule?.kind === "interval" ? initialSchedule.startAt : Date.now()
                    }
                    readOnly
                  />
                </div>
              )}
              {kind === "cron" && (
                <div className="form-grid">
                  <InputField
                    name="cron"
                    label={t.automationCron}
                    defaultValue={
                      initialSchedule?.kind === "cron" ? initialSchedule.expression : "0 9 * * *"
                    }
                    required
                  />
                  <InputField
                    name="timeZone"
                    label={t.automationTimezone}
                    defaultValue={
                      initialSchedule?.kind === "cron" ? (initialSchedule.timeZone ?? "UTC") : "UTC"
                    }
                  />
                </div>
              )}
            </div>
            <div className="form-actions">
              <Button type="button" color="gray" variant="surface" onClick={close}>
                {t.cancel}
              </Button>
              <Button type="submit" disabled={busy || !bots.length}>
                {t.save}
              </Button>
            </div>
          </>
        )}
      </ConfigurationForm>
    </Dialog>
  );
}

function TriggerRuns({
  trigger,
  data,
  flash,
}: {
  trigger: Trigger;
  data: DesktopData;
  flash: Flash;
}) {
  const [runs, setRuns] = useState<readonly TriggerRun[]>([]);
  const [loaded, setLoaded] = useState(false);
  const load = useAction(flash);
  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    if (!event.currentTarget.open || loaded || load.busy) return;
    load.run(
      data.listTriggerRuns(trigger.id).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            setRuns(value);
            setLoaded(true);
          }),
        ),
      ),
    );
  };
  return (
    <details className="automation-runs" onToggle={onToggle}>
      <summary aria-label={`${t.automationRuns} ${trigger.name}`}>{t.automationRuns}</summary>
      {load.busy && (
        <p className="muted" role="status">
          {t.automationRunLoading}
        </p>
      )}
      {!load.busy && loaded && !runs.length && <p className="muted">{t.automationNoRuns}</p>}
      {!load.busy && runs.length > 0 && (
        <ul className="automation-run-list">
          {runs.slice(0, 10).map((run) => (
            <li key={run.id} className="automation-run">
              <div>
                <span className="automation-run-status" data-status={run.status}>
                  {runStatus(run.status)}
                </span>
                <time dateTime={new Date(run.scheduledAt).toISOString()}>
                  {formatTime(run.scheduledAt)}
                </time>
              </div>
              {run.taskId && <code>{run.taskId}</code>}
              {run.error && <p className="automation-run-error">{run.error}</p>}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function AutomationCard({
  trigger,
  botName,
  data,
  flash,
  edit,
}: {
  trigger: Trigger;
  botName: string;
  data: DesktopData;
  flash: Flash;
  edit: () => void;
}) {
  const toggle = useAction(flash);
  return (
    <article className="detail-card automation-card">
      <div className="section-heading">
        <div className="automation-title">
          <h2>{trigger.name}</h2>
          <Badge color={trigger.enabled ? "green" : "gray"}>
            {trigger.enabled ? t.automationEnabled : t.automationPaused}
          </Badge>
        </div>
        <div className="toolbar automation-actions">
          <Button
            type="button"
            color="gray"
            variant="surface"
            aria-label={`${t.edit} ${trigger.name}`}
            onClick={edit}
          >
            {t.edit}
          </Button>
          <Button
            type="button"
            variant={trigger.enabled ? "soft" : "solid"}
            disabled={toggle.busy}
            aria-label={`${trigger.enabled ? t.automationPause : t.automationResume} ${trigger.name}`}
            onClick={() => toggle.run(data.toggleTrigger(trigger.id, !trigger.enabled))}
          >
            {trigger.enabled ? t.automationPause : t.automationResume}
          </Button>
        </div>
      </div>
      <p className="automation-meta">
        {botName} · {scheduleText(trigger)}
      </p>
      <p className="automation-prompt">{trigger.prompt}</p>
      <div className="automation-card-footer">
        <span className="automation-next">
          <Icon name="clock" />
          {trigger.nextAt === undefined
            ? t.automationNoNext
            : `${t.automationNext} · ${formatTime(trigger.nextAt)}`}
        </span>
        <span className="identifier">{trigger.id}</span>
      </div>
      <TriggerRuns {...{ trigger, data, flash }} />
    </article>
  );
}

export function AutomationsPage({
  triggers,
  bots,
  data,
  flash,
}: {
  triggers: readonly Trigger[];
  bots: readonly BotConfig[];
  data: DesktopData;
  flash: Flash;
}) {
  const [editor, setEditor] = useState<{ trigger?: Trigger }>();
  const botNames = useMemo(() => new Map(bots.map((bot) => [bot.id, bot.name])), [bots]);
  useEffect(() => {
    void Effect.runPromise(data.refresh(["triggers"])).catch(() => undefined);
  }, [data]);
  return (
    <>
      <div className="automation-page">
        <div className="section-heading automation-heading">
          <div>
            <p className="muted">{t.automationHint}</p>
            {!bots.length && <p className="muted">{t.noBots}</p>}
          </div>
          <Button type="button" disabled={!bots.length} onClick={() => setEditor({})}>
            {t.newAutomation}
          </Button>
        </div>
        {triggers.length === 0 ? (
          <div className="detail-card automation-empty">
            <p className="muted">{t.automationEmpty}</p>
          </div>
        ) : (
          <div className="automation-list">
            {triggers.map((trigger) => (
              <AutomationCard
                key={trigger.id}
                trigger={trigger}
                botName={botNames.get(trigger.botId) ?? trigger.botId}
                data={data}
                flash={flash}
                edit={() => setEditor({ trigger })}
              />
            ))}
          </div>
        )}
      </div>
      {editor && (
        <TriggerEditor
          key={editor.trigger?.id ?? "new"}
          bots={bots}
          data={data}
          flash={flash}
          close={() => setEditor(undefined)}
          {...(editor.trigger ? { trigger: editor.trigger } : {})}
        />
      )}
    </>
  );
}
