import {
  type AutConfig,
  type BotConfig,
  RouteTestInput,
  type RouteTestResponse,
} from "@aut/protocol";
import { Badge, Button, IconButton, Progress } from "@radix-ui/themes";
import { Effect } from "effect";
import { useState } from "react";
import { desktopApi, validate } from "./api.js";
import { BotEditor } from "./bot-editor.js";
import { BotAvatar, botCharacter } from "./characters/bot-avatar.js";
import type { DesktopData } from "./desktop-data.js";
import { t } from "./i18n.js";
import { Dialog } from "./ui/dialog.js";
import { TextAreaField } from "./ui/form-fields.js";
import { type Flash, useAction } from "./ui/use-action.js";

function RouteExperiment({ flash }: { flash: Flash }) {
  const [result, setResult] = useState<RouteTestResponse>();
  const test = useAction(flash);
  return (
    <section className="detail-card route-experiment">
      <h2>{t.routeTest}</h2>
      <p className="muted">{t.routeHint}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const text = String(new FormData(e.currentTarget).get("text") ?? "").trim();
          test.run(
            validate(RouteTestInput, { text }).pipe(
              Effect.flatMap(desktopApi.testRoute),
              Effect.tap((value) => Effect.sync(() => setResult(value))),
            ),
          );
        }}
      >
        <TextAreaField name="text" label={t.routeText} />
        <div className="form-actions inline-actions">
          <Button type="submit" disabled={test.busy}>
            {t.test}
          </Button>
        </div>
      </form>
      {result && (
        <div>
          <p className="muted">
            {result.backend} · {result.model}
          </p>
          {result.probabilities
            .toSorted((a, b) => b.probability - a.probability)
            .map((v) => (
              <div key={v.botId} className="probability-row">
                <div className="section-heading">
                  <strong>{v.name}</strong>
                  <span>{(v.probability * 100).toFixed(1)}%</span>
                  {result.selectedBotId === v.botId && <Badge color="gray">推荐</Badge>}
                </div>
                <Progress size="1" value={v.probability * 100} aria-label={v.name} />
              </div>
            ))}
          <p className="identifier">决策记录 · {result.decisionLogId}</p>
        </div>
      )}
    </section>
  );
}
export function BotsPage({
  bots,
  config,
  data,
  flash,
  settings,
}: {
  bots: readonly BotConfig[];
  config: AutConfig;
  data: DesktopData;
  flash: Flash;
  settings: () => void;
}) {
  const [editor, setEditor] = useState<{ bot?: BotConfig; focusCharacter: boolean }>();
  const [deleting, setDeleting] = useState<BotConfig>();
  const remove = useAction(flash);
  return (
    <>
      <div className="section-heading">
        <p className="muted">{t.botHint}</p>
        <Button type="button" onClick={() => setEditor({ focusCharacter: false })}>
          {t.newBot}
        </Button>
      </div>
      <div className="bots-grid">
        {!bots.length && <p className="empty-panel">{t.noBots}</p>}
        {bots.map((bot) => (
          <article key={bot.id} className="bot-card">
            <div className="section-heading">
              <IconButton
                type="button"
                className="bot-avatar"
                color="gray"
                variant="soft"
                aria-label={t.changeCharacter(bot.name)}
                title={t.changeCharacter(bot.name)}
                aria-haspopup="dialog"
                onClick={() => setEditor({ bot, focusCharacter: true })}
              >
                <BotAvatar character={botCharacter(bot)} name={bot.name} />
              </IconButton>
              <h2>{bot.name}</h2>
              {bot.system && (
                <Badge color="gray" className="bot-role">
                  {t.primaryAssistant}
                </Badge>
              )}
            </div>
            <p className="muted">{bot.description}</p>
            <Badge color="gray">{bot.modelSelection.model}</Badge>
            <p className="identifier">{bot.cwd}</p>
            <div className="toolbar bot-card-actions">
              <Button
                type="button"
                color="gray"
                variant="surface"
                onClick={() => setEditor({ bot, focusCharacter: false })}
              >
                {t.edit}
              </Button>
              {!bot.system && (
                <Button
                  type="button"
                  variant="ghost"
                  size="1"
                  color="red"
                  className="bot-delete"
                  onClick={() => setDeleting(bot)}
                >
                  {t.delete}
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      <RouteExperiment flash={flash} />
      {editor && (
        <BotEditor
          {...editor}
          {...{ bots, config, flash, settings, data }}
          close={() => setEditor(undefined)}
        />
      )}
      {deleting && (
        <Dialog maxWidth="460px" title={t.delete} onClose={() => setDeleting(undefined)}>
          <div className="editor-form">
            <div className="form-body">
              <p className="muted">删除「{deleting.name}」？关联已有任务的 Bot 不能删除。</p>
            </div>
            <div className="form-actions">
              <Button
                type="button"
                color="gray"
                variant="surface"
                onClick={() => setDeleting(undefined)}
              >
                {t.cancel}
              </Button>
              <Button
                type="button"
                color="red"
                variant="soft"
                disabled={remove.busy}
                onClick={() =>
                  remove.run(
                    desktopApi.deleteBot(deleting.id).pipe(
                      Effect.tap(() => Effect.sync(() => setDeleting(undefined))),
                      Effect.zipRight(data.refresh(["bots"])),
                    ),
                  )
                }
              >
                {t.delete}
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
