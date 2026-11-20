import { paperBird } from "./builtins/paper-bird/index.js";
import { wink } from "./builtins/wink/index.js";
import { createCharacterRegistry } from "./character.js";

export * from "./character.js";
export * from "./player.js";
export { paperBird, wink };
export const characters = createCharacterRegistry([wink, paperBird]);
