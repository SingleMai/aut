import { useCallback, useEffect, useState } from "react";

interface PreviewFrame {
  state: string;
  action?: string;
  holdMs?: number;
  still?: boolean;
}

const conversation = [
  { state: "thinking", holdMs: 1450 },
  { state: "question", holdMs: 1800 },
  { state: "idle", action: "received" },
  { state: "idle", action: "report" },
  { state: "idle", still: true },
] as const satisfies readonly PreviewFrame[];

interface Preview {
  frame: PreviewFrame;
  remaining: readonly PreviewFrame[];
  revision: number;
}

export function useCharacterPreview() {
  const [preview, setPreview] = useState<Preview>({
    frame: { state: "question" },
    remaining: [],
    revision: 0,
  });
  const { frame, remaining, revision } = preview;
  const advance = useCallback(() => {
    setPreview((current) => {
      // A manual selection may have replaced the frame while its timer was completing.
      if (current !== preview) return current;
      const [next, ...rest] = current.remaining;
      return {
        frame: next ?? { state: current.frame.state, still: true },
        remaining: rest,
        revision: current.revision + 1,
      };
    });
  }, [preview]);

  // A sustained pose has a demo dwell time. A gesture advances through the player's onActionEnd.
  useEffect(() => {
    if (frame.holdMs === undefined) return;
    const timer = window.setTimeout(advance, frame.holdMs);
    return () => window.clearTimeout(timer);
  }, [frame.holdMs, advance]);

  function play(first: PreviewFrame, ...rest: PreviewFrame[]) {
    setPreview((current) => ({ frame: first, remaining: rest, revision: current.revision + 1 }));
  }
  const demo = remaining.length > 0;
  return {
    revision,
    state: frame.state,
    animateEntry: !frame.still,
    demo,
    event: frame.action === undefined ? undefined : { name: frame.action, key: revision },
    showState: (state: string) => play({ state }),
    playAction: (action: string) => play({ state: frame.state, action }),
    toggleDemo: () => (demo ? play({ state: "idle" }) : play(...conversation)),
    onActionEnd: advance,
  };
}
