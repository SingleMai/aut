import {
  type CharacterDefinition,
  type CharacterPose,
  conversationActions,
  conversationStates,
} from "../../character.js";

function PaperBird({ state, action, animate, size }: CharacterPose) {
  return (
    <svg
      className="aut-paper-bird"
      viewBox="0 0 112 110"
      fill="currentColor"
      aria-hidden="true"
      data-expression={action ?? state}
      data-animate={animate || undefined}
    >
      <g className="aut-bird-body">
        <path className="aut-bird-shadow" d="M8 62 40 72 53 92 34 83Z" />
        <path className="aut-bird-paper" d="M32 68 13 19 60 62 77 49 69 79 51 92Z" />
        <path className="aut-bird-shadow" d="M32 68 51 92 74 72 84 50 55 63Z" />
        <g className="aut-bird-head">
          <path className="aut-bird-dark" d="m54 68 18-32 12-7 11 13-9 12-17 24Z" />
          <path className="aut-bird-beak" d="m91 39 15 8-17 1 5-6Z" />
          {state === "resting" ? (
            <path
              d="m81 40 5 1"
              fill="none"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          ) : (
            <circle cx="84" cy="40" r={size === "small" ? 4 : 3} fill="white" />
          )}
          {action === "report" && (
            <g className="aut-bird-letter" transform="rotate(13 96 49)">
              <rect x="87" y="49" width="20" height="14" rx="1.5" />
              <path d="m88 50 9 7 9-7" />
            </g>
          )}
        </g>
        <g className="aut-bird-wing">
          <path className="aut-bird-paper" d="M8 28 68 62 48 79Z" />
          <path className="aut-bird-fold" d="m8 28 45 39 15-5Z" />
          <path className="aut-bird-shadow" d="m8 28 40 51 5-12Z" />
        </g>
      </g>
    </svg>
  );
}

export const paperBird: CharacterDefinition = {
  id: "paper-bird",
  label: "纸鸟",
  Render: PaperBird,
  states: {
    ...conversationStates,
    thinking: { ...conversationStates.thinking, entryMs: 850 },
    question: { ...conversationStates.question, entryMs: 760 },
    resting: { label: "收翼休息" },
  },
  actions: {
    received: { ...conversationActions.received, durationMs: 1000 },
    report: { ...conversationActions.report, durationMs: 1700 },
    flutter: { label: "扇翅", durationMs: 920 },
  },
};
