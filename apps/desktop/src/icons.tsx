// Small SVG controls for the OpenMausBot-style compact conversation chrome.
const paths = {
  chat: "M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z",
  tasks: "M9 5h12M9 12h12M9 19h12M3 5h.01M3 12h.01M3 19h.01",
  bot: "M8 4h8M12 4V2M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2ZM9 12h.01M15 12h.01M9 16h6M2 12h2M20 12h2",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
  automation: "M12 3a9 9 0 1 0 9 9h-2a7 7 0 1 1-7-7V3ZM12 7v5l3 2",
  mcp: "M8 7V5a4 4 0 0 1 8 0v2M8 17v2a4 4 0 0 0 8 0v-2M5 9h14v6H5a3 3 0 1 1 0-6ZM9 12h.01M15 12h.01",
  send: "M12 19V5M5 12l7-7 7 7",
  report: "M8 3h8l4 4v14H4V3h4ZM16 3v5h4M8 12h8M8 16h6",
  arrow: "M12 5v14M5 12l7 7 7-7",
  close: "M6 6l12 12M18 6 6 18",
  refresh: "M20 11a8 8 0 1 0-2 6M20 4v7h-7",
  panel: "M3 4h18v16H3zM9 4v16",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 1 1 18 0ZM12 7v5l3 2",
  check: "M5 12l4 4L19 6",
} as const;

export type IconName = keyof typeof paths;
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
