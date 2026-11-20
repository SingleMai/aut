import type { ComponentType } from "react";

export const conversationStates = {
  idle: { label: "待命" },
  thinking: { label: "思考", entryMs: 1100 },
  question: { label: "等你回答", entryMs: 900 },
} as const;

export const conversationActions = {
  received: { label: "答案已送达", durationMs: 1650 },
  report: { label: "报告就绪", durationMs: 1870 },
} as const;

export interface CharacterEvent {
  readonly name: string;
  readonly key: string | number;
}

export interface CharacterPose {
  readonly state: string;
  readonly action: string | undefined;
  readonly size: "small" | "regular";
  readonly animate: boolean;
}

interface Action {
  readonly label: string;
  readonly durationMs: number;
}

interface State {
  readonly label: string;
  readonly entryMs?: number;
}

type Catalogue<RequiredIds extends string, Value> = Readonly<
  Record<RequiredIds, Value> & Record<string, Value>
>;

export interface CharacterDefinition {
  readonly id: string;
  readonly label: string;
  readonly Render: ComponentType<CharacterPose>;
  readonly states: Catalogue<keyof typeof conversationStates, State>;
  readonly actions: Catalogue<keyof typeof conversationActions, Action>;
}

/** A registry belongs to its host. Extending it never changes another consumer's catalogue. */
export function createCharacterRegistry(definitions: readonly CharacterDefinition[]) {
  const byId = new Map<string, CharacterDefinition>();
  for (const character of definitions) {
    if (!character.id.trim() || byId.has(character.id)) {
      throw new TypeError(`Invalid or duplicate character ID: ${character.id}`);
    }
    byId.set(character.id, character);
  }
  return {
    list: Object.freeze([...byId.values()]),
    get: (id: string | undefined) => (id === undefined ? undefined : byId.get(id)),
  };
}
