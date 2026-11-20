// Card actions adapted from OpenMausBot src/components/OptionsCardRow.tsx and QuestionCard.tsx
// at 738ec88472a3b888ff7b7793755d89da613ed301 (Apache-2.0). See NOTICE.

import type { Card, RequestResponse } from "@aut/protocol";
import { Badge, Button } from "@radix-ui/themes";
import { Effect, Fiber } from "effect";
import { type ReactNode, useEffect, useState } from "react";
import { desktopApi } from "./api.js";
import type { DesktopData } from "./desktop-data.js";
import { t } from "./i18n.js";
import { QuestionCard } from "./question-card.js";
import { SettledQuestion } from "./settled-question.js";
import { type Flash, runUi, useAction } from "./ui/use-action.js";

type Snapshot = typeof RequestResponse.Type;
export interface QuestionRead {
  snapshot?: Snapshot | undefined;
  justDelivered: boolean;
  error: string;
  retry: () => void;
}
interface CardProps {
  card: Card;
  typedPast: boolean;
  data: DesktopData;
  flash: Flash;
  focusComposer: () => void;
  native?: QuestionRead | undefined;
}
export function NativeRequest({
  card,
  revision,
  children,
}: {
  card: Card;
  revision: number;
  children: (read: QuestionRead) => ReactNode;
}) {
  const [read, setRead] = useState<{ snapshot?: Snapshot; justDelivered: boolean }>({
    justDelivered: false,
  });
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const state = read.snapshot?.answerState;
  const terminal = state === "delivered" || state === "queued";
  const closed = card.state === "answered";
  const requestId = card.requestId;
  // Re-read pending claims on daemon invalidation, including cards whose visible status just closed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision and attempt invalidate this read.
  useEffect(() => {
    if (!requestId || terminal) return;
    const fiber = Effect.runFork(
      desktopApi.getRequest(requestId).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            if (value.request.id === requestId) {
              setRead((previous) => ({
                snapshot: value,
                justDelivered:
                  value.request.kind === "question" &&
                  value.answerState === "delivered" &&
                  previous.snapshot?.request.kind === "question" &&
                  previous.snapshot.request.id === value.request.id &&
                  (previous.justDelivered || previous.snapshot.answerState !== "delivered"),
              }));
              setError("");
            }
          }),
        ),
        Effect.catchAll((e) => Effect.sync(() => setError(e.message))),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [requestId, terminal, closed, revision, attempt]);
  return children({ ...read, error, retry: () => setAttempt((n) => n + 1) });
}

function NativeCard({
  card,
  typedPast,
  data,
  flash,
  focusComposer,
  native,
}: CardProps & { native: QuestionRead }) {
  const { snapshot, error, retry } = native;
  const requestId = card.requestId;
  if (
    card.state === "answered" ||
    snapshot?.answerState === "queued" ||
    snapshot?.answerState === "delivered"
  )
    return <SettledQuestion card={card} snapshot={snapshot} />;
  return (
    <section className="message-card">
      {snapshot && requestId ? (
        <QuestionCard
          {...{ card, snapshot, typedPast }}
          onAnswer={(answer) =>
            desktopApi
              .sendAction({ type: "question-answer", cardId: card.id, requestId, answer })
              .pipe(Effect.asVoid)
          }
          onAccepted={(returnFocus) => {
            if (returnFocus) focusComposer();
            runUi(data.refresh(["messages", "requests", "tasks"]), flash);
          }}
          onError={(message) => flash(`${t.error}：${message}`)}
        />
      ) : (
        <p className="question-status">
          {error || t.loading}
          {error && (
            <Button type="button" color="gray" variant="surface" onClick={retry}>
              {t.refresh}
            </Button>
          )}
        </p>
      )}
    </section>
  );
}
export function MessageCard(props: CardProps) {
  const { card, data, flash } = props;
  const action = useAction(flash);
  if (props.native) return <NativeCard {...props} native={props.native} />;
  if (card.state === "answered") return <SettledQuestion card={card} />;
  return (
    <section className="message-card">
      <h3>{card.prompt}</h3>
      {card.state === "expired" ? (
        <Badge color="gray">{t.expired}</Badge>
      ) : (
        <div className="card-options">
          {card.options.map((option) => (
            <Button
              type="button"
              key={option.id}
              disabled={action.busy}
              variant="ghost"
              size="1"
              color="gray"
              className="option-button"
              onClick={() =>
                action.run(
                  desktopApi
                    .sendAction({ type: "card-choice", cardId: card.id, optionId: option.id })
                    .pipe(Effect.zipRight(data.refresh(["messages", "tasks"]))),
                )
              }
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
