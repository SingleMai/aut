// Conversation rows adapted from OpenMausBot src/components/ChatView.tsx and ReplyQuote.tsx
// at 738ec88472a3b888ff7b7793755d89da613ed301 (Apache-2.0). See NOTICE.

import { type CharacterDefinition, type CharacterEvent, wink } from "@aut/characters";
import type { BotCreationReceipt, MainThreadMessage, MessageId } from "@aut/protocol";
import { Button } from "@radix-ui/themes";
import { Effect } from "effect";
import { Copy, List, Reply } from "lucide-react";
import { useState } from "react";
import { UiError } from "./api.js";
import { BotAvatar } from "./characters/bot-avatar.js";
import type { MessageLayout } from "./chat-layout.js";
import { ConversationBody } from "./conversation-body.js";
import { MessageCard, NativeRequest, type QuestionRead } from "./conversation-card.js";
import type { DesktopData } from "./desktop-data.js";
import { DispatchCorrection } from "./dispatch-correction.js";
import { formatClockTime, formatTime, t } from "./i18n.js";
import { Icon } from "./icons.js";
import { MessageActions, type MessageMenuItem } from "./message-actions.js";
import { MessageFilesView } from "./message-files.js";
import { WebAddress } from "./openmausbot/components/ConversationMarkdown.js";
import { copyText } from "./openmausbot/lib/copy-feedback.js";
import { type Flash, runUi, useAction } from "./ui/use-action.js";

function BotCreationAction({
  receipt,
  messageId,
  data,
  flash,
}: {
  receipt: BotCreationReceipt;
  messageId: MessageId;
  data: DesktopData;
  flash: Flash;
}) {
  const action = useAction(flash);
  if (receipt.status !== "available")
    return (
      <span className="message-text" role="status">
        {t.botCreationStatus[receipt.status]}
      </span>
    );
  return (
    <Button
      type="button"
      variant="ghost"
      size="1"
      className="report-link"
      disabled={action.busy}
      onClick={() => action.run(data.undoBotCreation(messageId))}
    >
      {t.undoBotCreation}
    </Button>
  );
}
interface MessageProps {
  message: MainThreadMessage;
  layout: MessageLayout;
  source: string;
  character?: CharacterDefinition | undefined;
  typedPast: boolean;
  arrived?: boolean;
  data: DesktopData;
  revision: number;
  flash: Flash;
  onQuote: (message: MainThreadMessage) => void;
  openTask: (id: string) => void;
  showReport: (ref: string) => void;
  focusComposer: () => void;
}

export function ConversationMessage(props: MessageProps) {
  const card = props.message.card;
  if (card?.requestId)
    return (
      <NativeRequest key={card.requestId} card={card} revision={props.revision}>
        {(native) => <MessageRow {...props} native={native} />}
      </NativeRequest>
    );
  return <MessageRow {...props} />;
}

function SpeakerAvatar({
  message,
  layout,
  source,
  character,
  native,
  arrived,
}: MessageProps & { native?: QuestionRead | undefined }) {
  const [enteredLive] = useState(!!arrived);
  const [openedHere] = useState(message.card?.state === "open");
  const [initialReport] = useState(enteredLive ? undefined : layout.reportId);
  let event: CharacterEvent | undefined;
  if (native?.justDelivered && message.card?.requestId) {
    event = { name: "received", key: message.card.requestId };
  } else if (layout.reportId && layout.reportId !== initialReport) {
    event = { name: "report", key: layout.reportId };
  }
  const state = native?.snapshot?.answerState;
  // The card and its request refresh separately. Hold the question through that gap.
  const waitingForReceipt = native && openedHere && message.card?.state === "answered";
  const asking =
    (message.card?.state === "open" || waitingForReceipt) &&
    state !== "delivered" &&
    state !== "queued" &&
    (!native?.snapshot || native.snapshot.request.kind === "question");
  return (
    <BotAvatar
      name={source}
      character={message.author === "chief" ? wink : character}
      state={asking ? "question" : "idle"}
      animateEntry={enteredLive}
      event={event}
    />
  );
}

function MessageRow(props: MessageProps & { native?: QuestionRead }) {
  const {
    message,
    layout,
    source,
    typedPast,
    data,
    flash,
    onQuote,
    openTask,
    showReport,
    focusComposer,
    native,
  } = props;
  const self = message.author === "user",
    notice = message.kind === "ack" || message.kind === "notice";
  const actions: MessageMenuItem[] = [
    { key: "quote", label: t.quote, icon: <Reply />, onSelect: () => onQuote(message) },
    {
      key: "copy",
      label: t.copy,
      icon: <Copy />,
      onSelect: () =>
        runUi(
          Effect.tryPromise({
            try: () => copyText(message.text),
            catch: () => new UiError({ message: t.copyFailed }),
          }).pipe(
            Effect.tap((result) =>
              Effect.sync(() => flash(result === "copied" ? t.copied : t.copyFailed)),
            ),
          ),
          flash,
        ),
    },
  ];
  const taskId =
    message.taskId ?? (typeof message.author === "object" ? message.author.taskId : undefined);
  if (taskId)
    actions.push({
      key: "source",
      label: t.sourceTask,
      icon: <List />,
      onSelect: () => openTask(taskId),
    });
  const ref = message.fullReportRef;
  return (
    <>
      {layout.showTime && <div className="time-divider">{formatTime(message.at)}</div>}
      <article
        data-message-row
        data-message-id={message.id}
        data-typed-past={typedPast ? "true" : undefined}
        className={[
          "message",
          self ? "message-user" : "message-assistant",
          `kind-${message.kind}`,
          layout.joinedAbove ? "joined-above" : "",
          layout.joinedBelow ? "joined-below" : "",
        ].join(" ")}
      >
        <div className="message-meta" hidden={!layout.showAuthor}>
          <span className="avatar" aria-hidden="true">
            {layout.showAuthor && <SpeakerAvatar {...props} />}
          </span>
          <strong>{source}</strong>
          <time>{formatTime(message.at)}</time>
        </div>
        <div className="message-row">
          <MessageActions side={self ? "user" : "bot"} menu={notice ? [] : actions}>
            {(!message.card || message.text !== message.card.prompt) &&
              (notice ? (
                <p className="message-text">{message.text}</p>
              ) : (
                <div className="message-text">
                  <ConversationBody text={message.text} user={self} />
                </div>
              ))}
            {message.dispatch && message.decisionLogId && (
              <DispatchCorrection
                dispatch={message.dispatch}
                decisionLogId={message.decisionLogId}
                data={data}
                flash={flash}
              />
            )}
            {message.botCreation && (
              <BotCreationAction
                receipt={message.botCreation}
                messageId={message.id}
                data={data}
                flash={flash}
              />
            )}
            {message.card && (
              <MessageCard
                key={message.card.id}
                card={message.card}
                {...{ typedPast, data, flash, focusComposer, native }}
              />
            )}
          </MessageActions>
          {!notice && (
            <time className="message-clock" dateTime={new Date(message.at).toISOString()}>
              {formatClockTime(message.at)}
            </time>
          )}
        </div>
        {!!message.sources?.length && (
          <details className="message-sources" open={message.sources.length <= 3}>
            <summary>
              {t.reportSources}（{message.sources.length}）
            </summary>
            <ol>
              {message.sources.map((source) => (
                <li key={source.url}>
                  <WebAddress href={source.url}>{source.label}</WebAddress>
                </li>
              ))}
            </ol>
          </details>
        )}
        {!!message.files?.length && <MessageFilesView files={message.files} flash={flash} />}
        {!!message.fileIssues?.length && (
          <div className="file-issues" role="status">
            {message.fileIssues.map((issue, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: these are immutable entries on one persisted message, including repeated display names.
              <p key={`${index}:${issue.name}`} title={issue.message}>
                {t.fileUnavailable}：{issue.name} · {t.fileDeliveryRetry}
              </p>
            ))}
          </div>
        )}
        {ref && (
          <div className="message-links">
            <Button
              type="button"
              variant="ghost"
              size="1"
              className="report-link"
              onClick={() => showReport(ref)}
            >
              <Icon name="report" />
              <span>{t.fullReport}</span>
            </Button>
          </div>
        )}
      </article>
    </>
  );
}
