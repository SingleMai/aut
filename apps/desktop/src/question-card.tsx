// Adapted from OpenMausBot src/components/{QuestionCard,AskCard}.tsx, Apache-2.0,
// commit 738ec88472a3b888ff7b7793755d89da613ed301. See NOTICE.

import type { Card, Question, QuestionAnswer, RequestResponse } from "@aut/protocol";
import { Button, Tabs } from "@radix-ui/themes";
import { Effect } from "effect";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { UiError } from "./api.js";
import { t } from "./i18n.js";
import { Icon } from "./icons.js";
import { AskChoices, AskReply } from "./openmausbot/components/AskCard.js";
import { ExpandableText } from "./openmausbot/components/ExpandableText.js";
import {
  answersInOneTap,
  canEditQuestionAnswer,
  questionAnswerComplete,
} from "./question-answer.js";

type Snapshot = typeof RequestResponse.Type;
interface Props {
  typedPast?: boolean;
  card: Card;
  snapshot: Snapshot;
  onAnswer: (answer: QuestionAnswer) => Effect.Effect<void, UiError>;
  onError: (message: string) => void;
  onAccepted?: (returnFocus: boolean) => void;
}
type Draft = { options: readonly string[]; text: string };
const emptyDraft: Draft = { options: [], text: "" };
const complete = (draft: Draft) => draft.options.length > 0 || !!draft.text.trim();

export function activeQuestionControl(container: HTMLElement | null) {
  return container?.querySelector<HTMLElement>(
    "[data-active-question] :is([data-ask-choice],textarea):not(:disabled)",
  );
}

export function QuestionCard(props: Props) {
  const request = props.snapshot.request;
  if (request.kind !== "question")
    return <p className="question-status">此请求不是待回答的问题。</p>;
  return <QuestionEditor key={request.id} {...props} questions={request.questions} />;
}
function QuestionEditor({
  typedPast = false,
  card,
  snapshot,
  onAnswer,
  onError,
  onAccepted,
  questions,
}: Props & { questions: readonly Question[] }) {
  const form = useRef<HTMLFormElement>(null);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, Draft>>(() => new Map());
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [accepted, setAccepted] = useState(false);
  const [retry, setRetry] = useState(false);
  const [error, setError] = useState("");
  const focusPanel = useRef(false);
  const state = snapshot.answerState;
  const editable = canEditQuestionAnswer(state, retry, busy, accepted);
  const needsAnswer = card.state === "open" && editable && state === undefined;
  const single = questions.length === 1;
  const oneTap = answersInOneTap(questions);
  const titled = single && (questions[0]?.text.length ?? 0) <= 160;
  const textOnly = single && !questions[0]?.options?.length;
  const filled = questions.filter((q) => complete(drafts.get(q.id) ?? emptyDraft)).length;
  const allComplete = filled === questions.length;
  const activeDraft = drafts.get(questions[active]?.id ?? "") ?? emptyDraft;
  useEffect(() => {
    if (state !== "registered") setRetry(false);
  }, [state]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus the newly active or reopened question.
  useLayoutEffect(() => {
    if (!focusPanel.current) return;
    activeQuestionControl(form.current)?.focus();
    focusPanel.current = false;
  }, [active, retry]);
  const next = (values: ReadonlyMap<string, Draft>) => {
    const index = questions.findIndex((q) => !complete(values.get(q.id) ?? emptyDraft));
    if (index >= 0) {
      focusPanel.current = true;
      setActive(index);
      if (index === active) activeQuestionControl(form.current)?.focus();
    } else form.current?.querySelector<HTMLButtonElement>("button[type=submit]")?.focus();
  };
  const send = (values: ReadonlyMap<string, Draft>) => {
    if (!editable || submitting.current) return;
    const answer = {
      perQuestion: questions.map((q) => {
        const draft = values.get(q.id) ?? emptyDraft;
        return {
          questionId: q.id,
          optionIds: draft.options,
          ...(draft.text.trim() ? { text: draft.text.trim() } : {}),
        };
      }),
    };
    if (!questionAnswerComplete(questions, answer)) {
      next(values);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError("");
    Effect.runFork(
      onAnswer(answer).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setAccepted(true);
            setRetry(false);
            const focused = document.activeElement;
            onAccepted?.(
              !!form.current && (focused === document.body || form.current.contains(focused)),
            );
          }),
        ),
        Effect.catchAll((e) =>
          Effect.sync(() => {
            setError(e.message);
            onError(e.message);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            submitting.current = false;
            setBusy(false);
          }),
        ),
      ),
    );
  };
  const update = (id: string, value: Draft) => {
    const result = new Map(drafts).set(id, value);
    setDrafts(result);
    return result;
  };
  const hint = state
    ? state === "registered" && retry
      ? t.retryAnswerHint
      : t.answerState[state]
    : busy || accepted
      ? t.answerState.submitting
      : card.state === "expired"
        ? t.expiredQuestion
        : oneTap
          ? questions[0]?.allowFreeText
            ? "选择一项即可回答，也可以填写自己的答案。"
            : "选择一项即可回答。"
          : textOnly
            ? "填写答案后点击箭头提交，Shift + Enter 换行。"
            : t.pendingQuestion;
  const hideSubmit = (oneTap || textOnly) && !retry;
  return (
    <form
      className="questions"
      data-needs-answer={needsAnswer || undefined}
      aria-label={t.question}
      ref={form}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        send(drafts);
      }}
    >
      {needsAnswer && titled && <p className="question-callout">{t.question}</p>}
      <div className="question-heading">
        <h3 className="question-title">{titled ? questions[0]?.text : t.question}</h3>
        <p className="question-progress" aria-live="polite" hidden={single}>
          已回答 {filled} / {questions.length}
        </p>
      </div>
      <Tabs.Root value={String(active)} onValueChange={(value) => setActive(Number(value))}>
        <Tabs.List hidden={single} aria-label="问题列表" size="1" className="question-tabs">
          {questions.map((q, index) => (
            <Tabs.Trigger
              key={q.id}
              value={String(index)}
              aria-label={t.numberedQuestion(index + 1)}
            >
              {complete(drafts.get(q.id) ?? emptyDraft) && <Icon name="check" />}
              {t.numberedQuestion(index + 1)}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {questions.map((q, index) => {
          const draft = drafts.get(q.id) ?? emptyDraft;
          const fields = (
            <>
              {!titled && (
                <div className="question-copy">
                  <ExpandableText text={q.text} />
                </div>
              )}
              <fieldset className="question-group" aria-label={q.text} disabled={!editable}>
                {q.multiSelect && <p className="question-hint">可以选择多项，完成后提交。</p>}
                {!!q.options?.length && (
                  <AskChoices
                    choices={q.options}
                    label={q.text}
                    multi={q.multiSelect}
                    picked={draft.options}
                    disabled={!editable}
                    quiet={typedPast}
                    sending={oneTap && busy ? (draft.options[0] ?? null) : null}
                    onPick={(id) => {
                      if (!editable) return;
                      const options = q.multiSelect
                        ? (q.options ?? [])
                            .filter((option) =>
                              option.id === id
                                ? !draft.options.includes(id)
                                : draft.options.includes(option.id),
                            )
                            .map((option) => option.id)
                        : [id];
                      const updated = update(q.id, {
                        options,
                        text: q.multiSelect ? draft.text : "",
                      });
                      if (oneTap) send(updated);
                      else if (!q.multiSelect) next(updated);
                    }}
                  />
                )}
                {q.allowFreeText && (
                  <AskReply
                    label={`${q.text} · ${t.freeText}`}
                    placeholder={q.options?.length ? "或者填写其他答案…" : t.freeText}
                    submitLabel={single ? "提交文字答案" : "完成本题"}
                    multiline={!q.options?.length}
                    value={draft.text}
                    disabled={!editable}
                    sending={single && busy && draft.options.length === 0}
                    onChange={(text) =>
                      update(q.id, { options: q.multiSelect ? draft.options : [], text })
                    }
                    onSend={() => {
                      if (single) send(drafts);
                      else next(drafts);
                    }}
                  />
                )}
              </fieldset>
            </>
          );
          return single ? (
            <div key={q.id} data-active-question="">
              {fields}
            </div>
          ) : (
            <Tabs.Content
              key={q.id}
              value={String(index)}
              forceMount
              hidden={index !== active}
              data-active-question={index === active ? "" : undefined}
              tabIndex={-1}
            >
              {fields}
            </Tabs.Content>
          );
        })}
      </Tabs.Root>
      <p className="question-status" aria-live="polite">
        {hint}
      </p>
      <p className="question-error" role="alert" hidden={!error}>
        {error}
      </p>
      <div className="question-footer" hidden={hideSubmit && (state !== "registered" || retry)}>
        <Button
          type="submit"
          hidden={hideSubmit}
          disabled={
            !editable || (single || retry || allComplete ? !allComplete : !complete(activeDraft))
          }
        >
          {retry ? t.retryAnswer : single ? "完成" : allComplete ? t.submitAnswers : "继续回答"}
        </Button>
        <Button
          type="button"
          color="gray"
          variant="surface"
          hidden={state !== "registered" || retry}
          disabled={busy}
          onClick={() => {
            if (state === "registered" && !busy) {
              setAccepted(false);
              focusPanel.current = true;
              setRetry(true);
            }
          }}
        >
          {t.retryAnswer}
        </Button>
      </div>
    </form>
  );
}
