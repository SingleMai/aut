// Extracted from OpenMausBot src/lib/bottom-follow.ts at 738ec88472a3b888ff7b7793755d89da613ed301.
// Copyright 2026 Milind Soni and contributors. Apache-2.0. See NOTICE.
// Resize observation stays with the desktop hook so the dock and transcript resize together.
export const BOTTOM_FOLLOW_THRESHOLD = 4;

interface BottomFollowScroller {
  scrollHeight: number;
  scrollTo(options?: ScrollToOptions): void;
}

export function followBottomGrowth(
  scroller: BottomFollowScroller,
  following: boolean,
  smooth = false,
): boolean {
  if (!following) return false;
  scroller.scrollTo(
    smooth ? { top: scroller.scrollHeight, behavior: "smooth" } : { top: scroller.scrollHeight },
  );
  return true;
}
