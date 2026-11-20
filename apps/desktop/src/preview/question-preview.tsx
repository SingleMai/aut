import { CharacterPlayer, wink } from "@aut/characters";
import { TaskId } from "@aut/protocol";
import { Select } from "@radix-ui/themes";
import { Effect } from "effect";
import { useState } from "react";
import { ConversationBody } from "../conversation-body.js";
import { QuestionCard } from "../question-card.js";
import { SettledQuestion } from "../settled-question.js";
import { questionFixture, sampleAnswer, samples } from "./question-fixtures.js";

type Phase = keyof typeof samples;
export function QuestionPreview() {
  const [phase, setPhase] = useState<Phase>("pending");
  const [answer, setAnswer] = useState(sampleAnswer);
  const { card, snapshot } = questionFixture(samples[phase], TaskId.make("qa-review"), 0, answer);
  return (
    <section className="preview-section">
      <header className="preview-section-heading">
        <h2>会话问答</h2>
        <Select.Root value={phase} onValueChange={(value) => setPhase(value as Phase)}>
          <Select.Trigger aria-label="问答状态" variant="surface" />
          <Select.Content>
            <Select.Item value="pending">待回答</Select.Item>
            <Select.Item value="queued">已排队</Select.Item>
            <Select.Item value="delivered">已送达</Select.Item>
          </Select.Content>
        </Select.Root>
      </header>
      <div className="preview-conversation">
        <div className="message message-user">
          <div className="message-row">
            <div className="message-body">
              <ConversationBody user text="先确认界面风格吧。" />
            </div>
          </div>
        </div>
        <div className="message message-assistant">
          <div className="message-meta">
            <span className="avatar">
              <CharacterPlayer character={wink} state={phase === "pending" ? "question" : "idle"} />
            </span>
            <strong>研究助手</strong>
          </div>
          {phase === "pending" ? (
            <section className="message-card">
              <QuestionCard
                card={card}
                snapshot={snapshot}
                onAnswer={(value) =>
                  Effect.sync(() => {
                    setAnswer(value);
                    setPhase("queued");
                  })
                }
                onError={() => {}}
              />
            </section>
          ) : (
            <SettledQuestion key={phase} card={card} snapshot={snapshot} />
          )}
        </div>
      </div>
    </section>
  );
}
