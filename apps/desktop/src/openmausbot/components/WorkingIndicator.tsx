// Copied from OpenMausBot, src/components/WorkingIndicator.tsx, commit 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and OpenMausBot contributors. Apache-2.0; see NOTICE.
// aut adaptation: local ESM paths; original dots and once-per-second timer retained.
import { useEffect, useRef } from "react";
import { formatElapsed } from "../lib/working-time.js";

export function WorkingDots() {
  return (
    <span className="working-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function WorkingTimer({ since }: { since: number }) {
  const node = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (node.current) node.current.textContent = formatElapsed(Date.now() - since);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={node} className="working-timer" />;
}
