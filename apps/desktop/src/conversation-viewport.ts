// Adapted from OpenMausBot bottom-follow.ts and use-transcript-viewport.ts (Apache-2.0),
// commit 738ec88472a3b888ff7b7793755d89da613ed301. See NOTICE.
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  canScrollConversation,
  canScrollConversationUp,
  isAtConversationEnd,
} from "./chat-layout.js";
import { followBottomGrowth } from "./openmausbot/lib/bottom-follow.js";
import {
  FOLLOWING,
  initialTranscriptFollow,
  rowScrollTop,
  type TranscriptFollow,
  topRow,
  transitionTranscriptFollow,
  wantsJumpToLatest,
} from "./openmausbot/lib/transcript-follow.js";

export function useConversationViewport(
  active: boolean,
  hasOlder: boolean,
  oldest?: string,
  newest?: string,
) {
  const feed = useRef<HTMLDivElement>(null),
    stream = useRef<HTMLDivElement>(null),
    dock = useRef<HTMLDivElement>(null),
    page = useRef<HTMLDivElement>(null);
  const follow = useRef<TranscriptFollow>(FOLLOWING);
  const [jump, setJump] = useState(false),
    [unseen, setUnseen] = useState(false);
  const latest = useRef(newest);
  const anchor = useRef<ReturnType<typeof topRow>>(null);
  const sync = useCallback((state: TranscriptFollow) => {
    follow.current = state;
    setJump(wantsJumpToLatest(state));
    if (state.mode === "following") setUnseen(false);
  }, []);
  const toEnd = useCallback(() => {
    sync(FOLLOWING);
    if (feed.current) followBottomGrowth(feed.current, true);
  }, [sync]);
  const release = useCallback(() => sync(initialTranscriptFollow(false)), [sync]);
  const rememberAnchor = () => {
    release();
    anchor.current = feed.current && stream.current ? topRow(feed.current, stream.current) : null;
  };
  useLayoutEffect(() => {
    if (!active || !feed.current) return;
    if (follow.current.mode === "following") toEnd();
    else if (newest && latest.current && latest.current !== newest) setUnseen(true);
    latest.current = newest;
  }, [newest, active, toEnd]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restore the visible row after a page is prepended.
  useLayoutEffect(() => {
    const prior = anchor.current,
      el = feed.current;
    if (!prior || !el || !stream.current || !active) return;
    const top = rowScrollTop(el, stream.current, prior.rowId, prior.offsetWithinRow);
    if (top !== undefined) el.scrollTop = top;
    anchor.current = null;
  }, [oldest, active]);
  useLayoutEffect(() => {
    const el = feed.current,
      body = stream.current,
      composer = dock.current,
      wrapper = page.current;
    if (!active || !el || !body || !composer || !wrapper) return;
    const resize = () => {
      wrapper.style.setProperty("--composer-height", `${composer.offsetHeight}px`);
      if (!followBottomGrowth(el, follow.current.mode === "following") && !isAtConversationEnd(el))
        sync(transitionTranscriptFollow(follow.current, { type: "leftEnd" }));
    };
    const observer = new ResizeObserver(resize);
    observer.observe(body);
    observer.observe(composer);
    observer.observe(el);
    resize();
    const navigate = () => sync(transitionTranscriptFollow(follow.current, { type: "navigated" }));
    const scroll = () =>
      sync(
        transitionTranscriptFollow(follow.current, {
          type: isAtConversationEnd(el) ? "reachedEnd" : "leftEnd",
        }),
      );
    const wheel = (e: WheelEvent) => {
      if (e.deltaY < 0 && canScrollConversationUp(el, hasOlder)) navigate();
      else if (isAtConversationEnd(el)) sync(FOLLOWING);
    };
    let start: number | undefined;
    const touchStart = (e: TouchEvent) => {
      start = e.touches[0]?.clientY;
    };
    const touchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      if (
        start !== undefined &&
        y !== undefined &&
        y - start > 4 &&
        canScrollConversationUp(el, hasOlder)
      )
        navigate();
      else if (isAtConversationEnd(el)) sync(FOLLOWING);
    };
    const pointer = (e: PointerEvent) => {
      if (e.target === el && e.offsetX >= el.clientWidth && canScrollConversation(el)) navigate();
    };
    const key = (e: KeyboardEvent) => {
      if (
        e.target instanceof Element &&
        e.target.closest("input,textarea,select,button,[contenteditable=true]")
      )
        return;
      if (canScrollConversation(el) && ["ArrowUp", "PageUp", "Home"].includes(e.key)) navigate();
    };
    el.addEventListener("scroll", scroll, { passive: true });
    el.addEventListener("wheel", wheel, { passive: true });
    el.addEventListener("touchstart", touchStart, { passive: true });
    el.addEventListener("touchmove", touchMove, { passive: true });
    el.addEventListener("pointerdown", pointer);
    el.addEventListener("keydown", key);
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", scroll);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("touchstart", touchStart);
      el.removeEventListener("touchmove", touchMove);
      el.removeEventListener("pointerdown", pointer);
      el.removeEventListener("keydown", key);
    };
  }, [active, hasOlder, sync]);
  return { feed, stream, dock, page, jump, unseen, toEnd, release, rememberAnchor };
}
