import { CharacterPlayer, type CharacterPlayerProps, characters, wink } from "@aut/characters";
import type { BotConfig } from "@aut/protocol";

export function botCharacter(bot?: BotConfig, selectedId = bot?.characterId) {
  return characters.get(selectedId) ?? (bot?.system === "primary" ? wink : undefined);
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function botInitial(name: string) {
  return graphemes.segment(name.trim()).containing(0)?.segment ?? "·";
}

type BotAvatarProps = Omit<CharacterPlayerProps, "character"> & {
  character: CharacterPlayerProps["character"] | undefined;
  name: string;
  initialClassName?: string;
};

export function BotAvatar({ character, name, initialClassName, ...playback }: BotAvatarProps) {
  if (character) return <CharacterPlayer character={character} {...playback} />;
  return (
    <span className={initialClassName} aria-hidden="true">
      {botInitial(name)}
    </span>
  );
}
