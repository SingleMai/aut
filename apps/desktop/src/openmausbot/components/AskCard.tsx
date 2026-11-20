// Extracted from OpenMausBot src/components/AskCard.tsx at 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0. See NOTICE.
// Native options carry stable IDs. The enclosing question form owns whole-group submission.
import { Button, IconButton, Spinner } from "@radix-ui/themes";
import { ArrowUp, Check } from "lucide-react";
import type { KeyboardEvent } from "react";
import { imeComposing } from "../lib/send-key.js";

export type AskChoice = { id: string; label: string; description?: string | undefined };

/** The answers a question offers, one button each, stacked so a long label wraps instead of being cut. */
export function AskChoices({
  choices,
  label,
  onPick,
  sending = null,
  picked = [],
  multi = false,
  disabled = false,
  quiet = false,
}: {
  choices: readonly AskChoice[];
  /** The question, for screen readers. */
  label: string;
  onPick(id: string): void;
  /** The choice on its way: it shows that it is being sent, and the others wait. */
  sending?: string | null;
  picked?: readonly string[];
  multi?: boolean;
  disabled?: boolean;
  /** The person has written past this card: its choices recede but still answer. */
  quiet?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: Both dynamic group roles accept a label and delegate arrow keys from their choices.
    <div
      role={multi ? "group" : "radiogroup"}
      aria-label={label}
      onKeyDown={moveChoiceFocus}
      className="question-choices"
      data-quiet={quiet || undefined}
    >
      {choices.map((choice) => {
        const on = picked.includes(choice.id) || sending === choice.id;
        return (
          <Button
            key={choice.id}
            type="button"
            data-ask-choice={choice.id}
            role={multi ? "checkbox" : "radio"}
            aria-checked={on}
            aria-busy={sending === choice.id || undefined}
            disabled={disabled || (sending !== null && sending !== choice.id)}
            onClick={() => onPick(choice.id)}
            variant={on ? "soft" : "surface"}
            {...(on ? {} : { color: "gray" as const })}
            className="question-choice"
          >
            <span className="choice-copy">
              <span dir="auto" className="choice-label">
                {choice.label}
              </span>
              {choice.description && (
                <span dir="auto" className="choice-description">
                  {choice.description}
                </span>
              )}
            </span>
            {sending === choice.id ? (
              <Spinner size="1" />
            ) : (
              on && (
                <Check size={16} strokeWidth={2.4} aria-hidden="true" className="choice-check" />
              )
            )}
          </Button>
        );
      })}
    </div>
  );
}

/** The person's own words: a field and a send button in the asking bot's colour. */
export function AskReply({
  label,
  placeholder,
  submitLabel,
  onSend,
  sending = false,
  disabled = false,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  disabled?: boolean;
  onSend(text: string): void;
  sending?: boolean;
  value: string;
  onChange(text: string): void;
  multiline?: boolean;
}) {
  const ready = value.trim().length > 0 && !sending && !disabled;
  const send = () => {
    if (ready) onSend(value.trim());
  };
  return (
    <div className="question-reply" data-multiline={multiline || undefined}>
      <textarea
        dir="auto"
        rows={1}
        value={value}
        aria-label={label}
        placeholder={placeholder}
        disabled={disabled || sending}
        onInput={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || imeComposing(event.nativeEvent)) return;
          event.preventDefault();
          send();
        }}
      />
      <IconButton
        type="button"
        onClick={send}
        disabled={!ready}
        aria-label={submitLabel}
        title={submitLabel}
        aria-busy={sending || undefined}
        color="gray"
        radius="full"
        className="question-send"
      >
        {sending ? (
          <Spinner size="1" />
        ) : (
          <ArrowUp size={16} strokeWidth={2.4} aria-hidden="true" />
        )}
      </IconButton>
    </div>
  );
}

function moveChoiceFocus(event: KeyboardEvent<HTMLElement>): void {
  const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const group = event.currentTarget;
  const items = Array.from(
    group.querySelectorAll<HTMLElement>("[data-ask-choice]:not([disabled])"),
  );
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  const rtl = getComputedStyle(group).direction === "rtl";
  const forward = event.key === "ArrowDown" || event.key === (rtl ? "ArrowLeft" : "ArrowRight");
  const backward = event.key === "ArrowUp" || event.key === (rtl ? "ArrowRight" : "ArrowLeft");
  let next = current;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (forward) next = current < 0 ? 0 : (current + 1) % items.length;
  else if (backward)
    next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
  event.preventDefault();
  items[next]?.focus();
}
