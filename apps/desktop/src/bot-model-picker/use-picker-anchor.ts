import { useRef } from "react";

export const pickerSize = { width: 840, height: 460, providers: 156, margin: 16, gap: 8 };

/** Keep the select surface within the viewport, even when neither side of the field has room. */
export function usePickerAnchor() {
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const anchor = useRef({
    get contextElement() {
      return trigger.current ?? undefined;
    },
    getBoundingClientRect() {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return new DOMRect();
      const viewport = window.visualViewport;
      const viewLeft = viewport?.offsetLeft ?? 0;
      const viewTop = viewport?.offsetTop ?? 0;
      const viewWidth = viewport?.width ?? window.innerWidth;
      const viewHeight = viewport?.height ?? window.innerHeight;
      const { margin, gap, providers } = pickerSize;
      const width =
        content.current?.offsetWidth || Math.min(pickerSize.width, viewWidth - margin * 2);
      const height =
        content.current?.offsetHeight || Math.min(pickerSize.height, viewHeight - margin * 2);
      const minTop = viewTop + margin;
      const maxTop = viewTop + viewHeight - margin - height;
      const below = rect.bottom + gap;
      const above = rect.top - gap - height;
      const top =
        below <= maxTop
          ? below
          : above >= minTop
            ? above
            : Math.max(minTop, Math.min(rect.top - 64, maxTop));
      const left = Math.max(
        viewLeft + margin,
        Math.min(rect.left - providers, viewLeft + viewWidth - margin - width),
      );
      return new DOMRect(left, top, 0, 0);
    },
  });
  return { trigger, content, anchor };
}
