import { t } from "./i18n.js";

export function Wordmark() {
  return (
    <svg
      className="aut-wordmark"
      viewBox="-6 11 192 92"
      fill="currentColor"
      role="img"
      aria-label={t.app}
    >
      <use href="#aut-wordmark" />
    </svg>
  );
}
