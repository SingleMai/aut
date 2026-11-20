// Read-only adaptation of OpenMausBot src/components/{QuestionCard,AskCard}.tsx,
// commit 738ec88472a3b888ff7b7793755d89da613ed301, Apache-2.0. See NOTICE.

import type { Card, RequestResponse } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { Fragment, useId, useState } from "react";
import { t } from "./i18n.js";
import { Icon } from "./icons.js";

export function SettledQuestion({
  card,
  snapshot,
}: {
  card: Card;
  snapshot?: typeof RequestResponse.Type | undefined;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const valid =
    snapshot?.request.kind === "question" && snapshot.request.id === card.requestId
      ? snapshot
      : undefined;
  const state = valid?.answerState;
  const answer = state === "delivered" ? valid?.deliveredAnswer : undefined;
  const questions = valid?.request.questions ?? [];
  const rows = questions.flatMap((q, index) => {
    const item = answer?.perQuestion.find((entry) => entry.questionId === q.id);
    if (!item) return [];
    const values = [
      ...(item.optionIds ?? []).map((id) => ({
        id: `option:${id}`,
        text: q.options?.find((option) => option.id === id)?.label ?? id,
      })),
      ...(item.text ? [{ id: "text", text: item.text }] : []),
    ];
    if (!values.length) return [];
    const flat = values
      .map((value) => value.text)
      .join("、")
      .replace(/\s+/g, " ")
      .trim();
    return [
      {
        q,
        values,
        choice: !item.text && item.optionIds?.length === 1,
        summary: questions.length === 1 ? flat : `${t.numberedQuestion(index + 1)}：${flat}`,
      },
    ];
  });
  const multi = questions.length > 1;
  const awaiting = !!card.requestId && state !== "delivered";
  const status = awaiting ? (state ? t.readbackStatus[state] : t.deliveryUnconfirmed) : t.answered;
  const prefix = multi ? `${t.answered} · ` : rows[0]?.choice ? t.youChose : t.youAnswered;
  const summary = rows.map((row) => row.summary).join(" · ");
  return (
    <section className="message-card answered-card">
      <div className="settled-question-line" data-awaiting={awaiting ? "true" : undefined}>
        <Icon name={awaiting ? "clock" : "check"} />
        {rows.length ? (
          <span dir="auto" className="settled-summary" aria-live="polite" title={prefix + summary}>
            {prefix}
            <span>{summary}</span>
          </span>
        ) : (
          <>
            <span>{status}</span>
            {!answer && (
              <span className="settled-question-prompt" title={card.prompt}>
                {" "}
                · {card.prompt}
              </span>
            )}
          </>
        )}
        {multi && rows.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="1"
            color="gray"
            className="settled-details-toggle"
            aria-controls={id}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? t.hideAnswerDetails : t.answerDetails}
          </Button>
        )}
      </div>
      {multi && rows.length > 0 && (
        <dl id={id} className="settled-question-answers" hidden={!open}>
          {rows.map(({ q, values }) => (
            <Fragment key={q.id}>
              <dt>{q.text}</dt>
              {values.map((value) => (
                <dd key={value.id}>{value.text}</dd>
              ))}
            </Fragment>
          ))}
        </dl>
      )}
    </section>
  );
}
