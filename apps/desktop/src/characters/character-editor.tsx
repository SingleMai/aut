import { CharacterPlayer, characters } from "@aut/characters";
import type { BotConfig } from "@aut/protocol";
import { Button, RadioCards } from "@radix-ui/themes";
import { Play, Square } from "lucide-react";
import { useId, useState } from "react";
import { t } from "../i18n.js";
import { BotAvatar, botCharacter } from "./bot-avatar.js";
import { useCharacterPreview } from "./use-character-preview.js";

export function CharacterEditor({ bot, name }: { bot?: BotConfig | undefined; name: string }) {
  const [id, setId] = useState(bot?.characterId ?? "");
  const preview = useCharacterPreview();
  const heading = useId();
  const character = botCharacter(bot, id);
  const missing =
    bot?.characterId && !characters.get(bot.characterId) ? bot.characterId : undefined;
  const caption =
    (preview.event && character?.actions[preview.event.name]?.label) ??
    character?.states[preview.state]?.label ??
    t.characterInitial;

  return (
    <section className="character-editor" aria-labelledby={heading}>
      <div className="character-heading">
        <h3 id={heading}>{t.character}</h3>
        {character && (
          <Button type="button" variant="ghost" size="1" color="gray" onClick={preview.toggleDemo}>
            {preview.demo ? <Square size={12} /> : <Play size={13} />}
            {preview.demo ? t.stopPreview : t.previewConversation}
          </Button>
        )}
      </div>
      <input type="hidden" name="characterId" value={id} />
      <RadioCards.Root
        size="1"
        className="character-choices"
        aria-labelledby={heading}
        value={id}
        onValueChange={(next) => {
          setId(next);
          const nextCharacter = botCharacter(bot, next);
          preview.showState(
            nextCharacter && Object.hasOwn(nextCharacter.states, preview.state)
              ? preview.state
              : "question",
          );
        }}
      >
        <RadioCards.Item value="">{t.characterDefault}</RadioCards.Item>
        {characters.list.map((item) => (
          <RadioCards.Item key={item.id} value={item.id}>
            <CharacterPlayer character={item} />
            {item.label}
          </RadioCards.Item>
        ))}
        {missing && (
          <RadioCards.Item value={missing}>{t.characterUnavailable(missing)}</RadioCards.Item>
        )}
      </RadioCards.Root>
      <div className="character-preview">
        <div className="character-stage">
          <BotAvatar
            key={preview.revision}
            name={name}
            character={character}
            initialClassName="character-monogram"
            state={preview.state}
            event={preview.event}
            size="regular"
            animateEntry={preview.animateEntry}
            onActionEnd={preview.onActionEnd}
          />
          <span className="character-caption" aria-live="polite">
            {caption}
          </span>
        </div>
        {character ? (
          <div className="character-controls">
            <fieldset>
              <legend className="field-label">{t.previewState}</legend>
              <div className="character-buttons">
                {Object.entries(character.states).map(([value, pose]) => (
                  <Button
                    key={value}
                    type="button"
                    variant={preview.state === value ? "soft" : "surface"}
                    {...(preview.state !== value && { color: "gray" as const })}
                    size="1"
                    aria-pressed={preview.state === value}
                    onClick={() => preview.showState(value)}
                  >
                    {pose.label}
                  </Button>
                ))}
              </div>
            </fieldset>
            <fieldset>
              <legend className="field-label">{t.previewAction}</legend>
              <div className="character-buttons">
                {Object.entries(character.actions).map(([value, action]) => (
                  <Button
                    key={value}
                    type="button"
                    size="1"
                    variant={preview.event?.name === value ? "soft" : "surface"}
                    color="gray"
                    onClick={() => preview.playAction(value)}
                  >
                    {action.label}
                  </Button>
                ))}
              </div>
            </fieldset>
          </div>
        ) : (
          <p className="muted">{t.initialPreviewHint}</p>
        )}
      </div>
    </section>
  );
}
