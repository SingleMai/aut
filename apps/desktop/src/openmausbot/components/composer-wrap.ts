// Extracted from OpenMausBot src/components/composer-wrap.ts at 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0. See NOTICE.
// The shell ref may point to the desktop composer form.
import { type RefObject, useLayoutEffect, useState } from "react";

/** Simple: anything that grows the pill past its one 44px row (a second line, a reply strip) rounds its corners in. */
export function useTallPill(shellRef: RefObject<HTMLElement | null>, on: boolean): boolean {
  const [tall, setTall] = useState(false);
  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!on || !shell || typeof ResizeObserver === "undefined") return;
    const measure = () => setTall(shell.getBoundingClientRect().height > 44.5);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [shellRef, on]);
  return tall;
}
