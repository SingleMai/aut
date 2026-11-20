import type { DispatchChange, MainThreadMessage } from "@aut/protocol";
import { Button, Select } from "@radix-ui/themes";
import { Effect } from "effect";
import { useState } from "react";
import { desktopApi } from "./api.js";
import type { DesktopData } from "./desktop-data.js";
import { t } from "./i18n.js";
import { Dialog } from "./ui/dialog.js";
import { SelectField } from "./ui/form-fields.js";
import { type Flash, useAction } from "./ui/use-action.js";

export function DispatchCorrection({
  dispatch,
  decisionLogId,
  data,
  flash,
}: {
  dispatch: NonNullable<MainThreadMessage["dispatch"]>;
  decisionLogId: string;
  data: DesktopData;
  flash: Flash;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const action = useAction(flash);
  if (dispatch.status !== "open")
    return <span className="message-text">{t.dispatchStatus[dispatch.status]}</span>;
  const targets = data.snapshot().bots.filter((bot) => bot.id !== dispatch.botId);
  if (!dispatch.canUndo && targets.length === 0) return null;
  const target = targets.find((bot) => bot.id === selected);
  const submit = (change: DispatchChange) =>
    action.run(
      desktopApi.sendAction({ type: "correct-dispatch", decisionLogId, change }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setOpen(false);
            flash(t.correctionSubmitted);
          }),
        ),
        Effect.zipRight(data.refresh(["messages", "tasks"])),
      ),
    );
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="1"
        className="report-link"
        disabled={action.busy}
        onClick={() => {
          setSelected("");
          setOpen(true);
        }}
      >
        {t.correctDispatch}
      </Button>
      {open && (
        <Dialog maxWidth="480px" title={t.correctDispatch} onClose={() => setOpen(false)}>
          <div className="editor-form">
            {targets.length > 0 && (
              <div className="form-body">
                <SelectField
                  label={t.rerouteBot}
                  placeholder={t.choose}
                  value={target?.id ?? ""}
                  disabled={action.busy}
                  onValueChange={setSelected}
                >
                  {targets.map((bot) => (
                    <Select.Item key={bot.id} value={bot.id}>
                      {bot.name} ({bot.id})
                    </Select.Item>
                  ))}
                </SelectField>
                <p className="muted">{t.rerouteHint}</p>
              </div>
            )}
            <div className="form-actions">
              {dispatch.canUndo && (
                <Button
                  type="button"
                  color="gray"
                  variant="surface"
                  disabled={action.busy}
                  onClick={() => submit({ kind: "undo" })}
                >
                  {t.undoDispatch}
                </Button>
              )}
              {targets.length > 0 && (
                <Button
                  type="button"
                  disabled={action.busy || !target}
                  onClick={() => target && submit({ kind: "reroute", botId: target.id })}
                >
                  {t.reroute}
                </Button>
              )}
            </div>
          </div>
        </Dialog>
      )}
    </>
  );
}
