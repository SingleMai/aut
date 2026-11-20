import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";
import type { CharacterDefinition, CharacterEvent, CharacterPose } from "./character.js";

// A host may further reduce motion for a preview or a specific surface.
export const ReducedCharacterMotion = createContext(false);

const motionQuery = "(prefers-reduced-motion: reduce)";
const prefersStill = () => window.matchMedia?.(motionQuery).matches ?? false;
const serverStill = () => true;
const listenToNothing = () => () => {};
function watchMotion(notify: () => void) {
  const media = window.matchMedia?.(motionQuery);
  media?.addEventListener("change", notify);
  return () => media?.removeEventListener("change", notify);
}

export interface CharacterPlayerProps {
  character: CharacterDefinition;
  state?: string;
  event?: CharacterEvent | undefined;
  size?: CharacterPose["size"];
  animateEntry?: boolean;
  onActionEnd?: ((event: CharacterEvent) => void) | undefined;
}

function Playback({
  character,
  state = "idle",
  event,
  size = "small",
  duration,
  onActionEnd,
}: CharacterPlayerProps & { duration: number }) {
  const [finished, setFinished] = useState(false);
  const playing = duration > 0 && !finished;
  const reduceMotion = useContext(ReducedCharacterMotion);
  const still = useSyncExternalStore(
    playing ? watchMotion : listenToNothing,
    playing ? prefersStill : serverStill,
    serverStill,
  );
  const finish = useEffectEvent(() => {
    setFinished(true);
    if (event) onActionEnd?.(event);
  });
  useEffect(() => {
    if (duration <= 0 || finished) return;
    const timer = window.setTimeout(finish, duration);
    return () => window.clearTimeout(timer);
  }, [duration, finished]);
  const action = playing ? event?.name : undefined;
  return (
    <span
      className="aut-character"
      data-character={character.id}
      data-state={state}
      data-action={action}
      aria-hidden="true"
    >
      <character.Render
        state={state}
        action={action}
        size={size}
        animate={playing && !still && !reduceMotion}
      />
    </span>
  );
}

export function CharacterPlayer({
  character,
  state: requested = "idle",
  event,
  animateEntry = false,
  ...props
}: CharacterPlayerProps) {
  const state = Object.hasOwn(character.states, requested) ? requested : "idle";
  const action =
    event && Object.hasOwn(character.actions, event.name)
      ? character.actions[event.name]
      : undefined;
  // An event owns its timer across state updates. A different occurrence starts a fresh renderer.
  const key =
    action && event
      ? ["event", event.name, event.key]
      : [character.id, "state", state, animateEntry];
  const duration = action?.durationMs ?? (animateEntry ? character.states[state]?.entryMs : 0) ?? 0;
  return (
    <Playback
      key={JSON.stringify(key)}
      character={character}
      state={state}
      event={action ? event : undefined}
      duration={duration}
      {...props}
    />
  );
}
