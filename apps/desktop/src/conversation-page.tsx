// Conversation, composer and reply interactions adapted from OpenMausBot ChatView.tsx,
// Composer.tsx and ReplyQuote.tsx at 738ec88472a3b888ff7b7793755d89da613ed301, Apache-2.0. See NOTICE.

import { CharacterPlayer, wink } from "@aut/characters";
import type { MainThreadMessage, Task } from "@aut/protocol";
import { Button, IconButton } from "@radix-ui/themes";
import { Effect } from "effect";
import { ArrowUpRight, Bot, ListChecks, Waypoints } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { desktopApi, type UiError } from "./api.js";
import { BotAvatar, botCharacter } from "./characters/bot-avatar.js";
import { deriveMessageLayout } from "./chat-layout.js";
import { clearSubmittedDraft } from "./composer-input.js";
import { ConversationBody } from "./conversation-body.js";
import { ConversationMessage } from "./conversation-message.js";
import { useConversationViewport } from "./conversation-viewport.js";
import type { DesktopData } from "./desktop-data.js";
import { t } from "./i18n.js";
import { Icon } from "./icons.js";
import { useTallPill } from "./openmausbot/components/composer-wrap.js";
import { ReplyQuote } from "./openmausbot/components/ReplyQuote.js";
import { escapeCancelsReply } from "./openmausbot/lib/replies.js";
import { imeComposing, sendsMessage } from "./openmausbot/lib/send-key.js";
import { activeQuestionControl } from "./question-card.js";
import { Dialog } from "./ui/dialog.js";
import { type Flash, runUi, useAction } from "./ui/use-action.js";

const examples = [
  { prompt: t.examplePlan, icon: Waypoints },
  { prompt: t.exampleProgress, icon: ListChecks },
  { prompt: t.exampleBot, icon: Bot },
];

export function ConversationPage({
  active,
  working,
  data,
  snapshot,
  openTask,
  returnTask,
  flash,
}: {
  active: boolean;
  working: readonly Task[];
  data: DesktopData;
  snapshot: ReturnType<DesktopData["snapshot"]>;
  openTask: (id: string) => void;
  returnTask: { task: Task } | undefined;
  flash: Flash;
}) {
  const { messages, messageStatus, bots, requestRevision, hasOlder } = snapshot;
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const activeBotId = working[0]?.botId;
  const activeBot =
    activeBotId && working.every((task) => task.botId === activeBotId)
      ? botsById.get(activeBotId)
      : undefined;
  const viewport = useConversationViewport(active, hasOlder, messages[0]?.id, messages.at(-1)?.id);
  const { feed, release } = viewport;
  const [quote, setQuote] = useState<MainThreadMessage>(),
    [draft, setDraft] = useState(""),
    [report, setReport] = useState<string>();
  const currentQuote = useRef(quote);
  currentQuote.current = quote;
  const input = useRef<HTMLTextAreaElement>(null),
    form = useRef<HTMLFormElement>(null);
  const composing = useRef(false);
  const tall = useTallPill(form, active);
  const pendingMessage = useRef<{ id: string; text: string } | undefined>(undefined);
  const send = useAction(flash),
    older = useAction(flash);
  const layouts = useMemo(() => deriveMessageLayout(messages), [messages]);
  // The initial page and prepended history are already at rest. Only appended rows enter live.
  const lastTail = useRef<string | null | undefined>(undefined);
  const tail = lastTail.current;
  const previousEnd = tail == null ? -1 : messages.findIndex((message) => message.id === tail);
  useLayoutEffect(() => {
    if (messageStatus === "ready") lastTail.current = messages.at(-1)?.id ?? null;
  }, [messages, messageStatus]);
  const lastTyped = messages.findLastIndex((m) => m.author === "user" && m.kind === "text");
  const scrollTo = (id: string) =>
    feed.current
      ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
      ?.scrollIntoView({ block: "center" });
  // Returning to an older question may need several history pages and a request detail read.
  useEffect(() => {
    if (!active || !returnTask) return;
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      observer.disconnect();
    };
    const targetTask = returnTask.task;
    const observer = new MutationObserver(() => focus());
    let targetId: string | undefined;
    function focus() {
      if (cancelled || !targetId || !feed.current) return;
      const row = feed.current.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(targetId)}"]`,
      );
      if (!row) return;
      row.scrollIntoView({ block: "center" });
      const control = activeQuestionControl(row);
      if (control) {
        control.focus({ preventScroll: true });
        observer.disconnect();
      }
    }
    if (!targetTask.pendingRequestIds.length) {
      const source = data
        .snapshot()
        .messages.findLast((m) => m.taskId === targetTask.id && m.author !== "user");
      if (source) setQuote(source);
      input.current?.focus();
      return;
    }
    release();
    if (feed.current) observer.observe(feed.current, { childList: true, subtree: true });
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("keydown", cancel, true);
    const find = () =>
      data
        .snapshot()
        .messages.find(
          (m) => m.card?.requestId && targetTask.pendingRequestIds.includes(m.card.requestId),
        );
    runUi(
      Effect.gen(function* () {
        let item = find();
        while (!cancelled && !item && data.snapshot().hasOlder) {
          yield* data.loadOlder;
          item = find();
        }
        if (cancelled) return;
        if (item) {
          targetId = item.id;
          focus();
        } else flash("未找到待回答的问题卡，请刷新主会话确认问题状态。");
      }),
      flash,
    );
    return () => {
      cancel();
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("keydown", cancel, true);
    };
  }, [active, returnTask, data, feed, release, flash]);
  const speakerFor = (author: MainThreadMessage["author"]) => {
    if (typeof author === "string") return { source: author === "user" ? t.you : t.chief };
    const bot = botsById.get(author.botId);
    return { source: bot?.name ?? author.botId, character: botCharacter(bot) };
  };
  const placeDraft = (value: string) => {
    const field = input.current;
    if (!field) return;
    if (examples.some(({ prompt }) => prompt.draft === field.value)) field.select();
    field.setRangeText(value, field.selectionStart, field.selectionEnd, "end");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.focus();
  };
  return (
    <div className="conversation-view" ref={viewport.page} hidden={!active}>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard readers scroll the log with Page Up, Home and the arrow keys. */}
      <div className="message-feed" ref={feed} role="log" aria-label={t.conversation} tabIndex={0}>
        <div ref={viewport.stream} className={!messages.length ? "empty-stream" : undefined}>
          {messageStatus !== "ready" ? (
            <p className="muted">
              {messageStatus === "loading" ? t.loading : t.conversationUnavailable}
            </p>
          ) : !messages.length ? (
            <div className="empty-conversation">
              <div className="welcome-mark">
                <CharacterPlayer character={wink} size="regular" />
              </div>
              <h2>{t.welcome}</h2>
              <p>{t.emptyHint}</p>
              <div className="example-prompts">
                {examples.map(({ prompt, icon: PromptIcon }) => (
                  <button
                    type="button"
                    key={prompt.label}
                    className="example-prompt"
                    onClick={() => placeDraft(prompt.draft)}
                  >
                    <PromptIcon className="example-icon" aria-hidden="true" />
                    <span>{prompt.label}</span>
                    <ArrowUpRight className="example-arrow" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                size="1"
                color="gray"
                className="older-button"
                hidden={!hasOlder}
                disabled={older.busy}
                onClick={() => {
                  viewport.rememberAnchor();
                  older.run(data.loadOlder);
                }}
              >
                {older.busy ? t.loading : t.older}
              </Button>
              {messages.map((message, index) => {
                const layout = layouts[index];
                if (!layout) return null;
                return (
                  <ConversationMessage
                    key={message.id}
                    {...{ message, layout, data, openTask, flash }}
                    {...speakerFor(message.author)}
                    revision={requestRevision}
                    arrived={active && (tail === null || (previousEnd >= 0 && index > previousEnd))}
                    typedPast={!!message.card?.requestId && index < lastTyped}
                    onQuote={(m) => {
                      setQuote(m);
                      input.current?.focus();
                    }}
                    focusComposer={() => input.current?.focus()}
                    showReport={(ref) =>
                      runUi(
                        desktopApi
                          .getReport(ref)
                          .pipe(Effect.tap((value) => Effect.sync(() => setReport(value.text)))),
                        flash,
                      )
                    }
                  />
                );
              })}
              {working.length > 0 && (
                <div className="working-line">
                  <BotAvatar
                    name={activeBot?.name ?? t.chief}
                    character={activeBot ? botCharacter(activeBot) : wink}
                    initialClassName="avatar"
                    state="thinking"
                    animateEntry
                  />
                  <span>
                    {working.length} {t.workingTasks}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <IconButton
        type="button"
        variant="surface"
        color="gray"
        radius="full"
        className={`jump-latest${viewport.unseen ? " has-new-messages" : ""}`}
        hidden={!viewport.jump || !messages.length}
        title={viewport.unseen ? t.newMessages : t.latest}
        aria-label={viewport.unseen ? t.newMessages : t.latest}
        onClick={viewport.toEnd}
      >
        <Icon name="arrow" />
        <span className="visually-hidden">{viewport.unseen ? t.newMessages : t.latest}</span>
      </IconButton>
      <div className="composer-dock" ref={viewport.dock}>
        <form
          className={tall ? "composer is-multiline" : "composer"}
          ref={form}
          onSubmit={(e) => {
            e.preventDefault();
            const text = input.current?.value;
            if (!text?.trim() || send.busy) return;
            viewport.toEnd();
            const outgoing = quote;
            if (!pendingMessage.current || pendingMessage.current.text !== text)
              pendingMessage.current = { id: crypto.randomUUID(), text };
            const operation: Effect.Effect<unknown, UiError> = outgoing
              ? desktopApi.sendAction({ type: "quote-reply", quotedMessageId: outgoing.id, text })
              : desktopApi.sendMessage(pendingMessage.current);
            send.run(
              operation.pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    const cleared = input.current && clearSubmittedDraft(input.current, text);
                    pendingMessage.current = undefined;
                    if (cleared && currentQuote.current === outgoing) setQuote(undefined);
                  }),
                ),
                Effect.zipRight(data.refresh(["messages", "tasks"])),
              ),
            );
          }}
        >
          <div className="quote-preview" hidden={!quote}>
            {quote && (
              <ReplyQuote
                name={speakerFor(quote.author).source}
                text={quote.text}
                onJump={() => {
                  release();
                  scrollTo(quote.id);
                }}
                onClear={() => {
                  setQuote(undefined);
                  input.current?.focus();
                }}
              />
            )}
          </div>
          <div className="composer-line">
            <textarea
              ref={input}
              placeholder={t.compose}
              aria-label={t.compose}
              title={t.sendHint}
              rows={1}
              dir="auto"
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              onKeyDown={(e) => {
                if (composing.current || imeComposing(e.nativeEvent)) return;
                if (escapeCancelsReply(e.nativeEvent, { replying: !!quote, recording: false })) {
                  e.preventDefault();
                  setQuote(undefined);
                } else if (sendsMessage(e.nativeEvent, "enter")) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              onInput={(e) => setDraft(e.currentTarget.value)}
            />
            <IconButton
              type="submit"
              color="gray"
              radius="full"
              className="send-button"
              aria-label={t.send}
              title={t.send}
              hidden={!draft.trim()}
              disabled={send.busy || !draft.trim()}
            >
              <Icon name="send" />
            </IconButton>
          </div>
        </form>
        <p className="composer-hint">{t.sendHint}</p>
      </div>
      {report !== undefined && (
        <Dialog title={t.fullReport} onClose={() => setReport(undefined)}>
          <div className="report-prose">
            <ConversationBody document text={report} user={false} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
