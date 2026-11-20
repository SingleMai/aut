import { useId } from "react";
import {
  type CharacterDefinition,
  type CharacterPose,
  conversationActions,
  conversationStates,
} from "../../character.js";

function EyeCorner({ expression, small }: { expression: string; small: boolean }) {
  const id = useId();
  const suffix = small ? "-small" : "";
  const hook = expression === "question";
  const check = expression === "received";
  const tracksInk = hook || check;
  const bead = small ? 3.45 : 2.75;
  const dot = small ? 4.05 : 3.45;
  return (
    <g className="aut-eye-pose">
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="-10" y="0" width="120" height="110">
          <rect x="-10" width="120" height="110" fill="white" />
          <g transform="translate(53 63) rotate(-18)">
            <g className="aut-eye-aperture">
              <g transform="rotate(18) translate(-53 -63)">
                <use href={`#aut-eye${suffix}`} fill="black" />
                <g clipPath={`url(#aut-eye-clip${suffix})`}>
                  <use className="aut-eye-pupil" href={`#aut-pupil${suffix}`} fill="white" />
                </g>
              </g>
            </g>
          </g>
        </mask>
        {tracksInk && (
          <mask id={`${id}-ink`} maskUnits="userSpaceOnUse" x="-18" y="-43" width="50" height="56">
            <use
              className="aut-eye-trace"
              href={hook ? `#aut-hook-trace${suffix}` : "#aut-check-trace"}
              fill="none"
              stroke="white"
              strokeWidth="12"
              strokeLinecap="round"
            />
          </mask>
        )}
      </defs>
      <use href={`#aut-head${suffix}`} mask={`url(#${id})`} />
      <g transform={small ? "translate(78.3 17.7)" : "translate(77.8 20.7)"}>
        <g className="aut-eye-ink">
          {expression === "thinking" && (
            <g className="aut-eye-dots">
              {[
                [-8.3, -5.1],
                [0.8, -8.2],
                [10.1, -11.1],
              ].map(([x, y]) => (
                <g key={x} transform={`translate(${x} ${y}) rotate(-31)`}>
                  <ellipse rx={bead} ry={bead * 0.87} />
                </g>
              ))}
            </g>
          )}
          {hook && (
            <>
              <g transform="rotate(-31)">
                <ellipse className="aut-eye-dot" rx={dot * 1.03} ry={dot * 0.78} />
                <ellipse className="aut-eye-gather" rx={bead} ry={bead * 0.87} />
              </g>
              <circle className="aut-eye-nib" r={bead} />
            </>
          )}
          {check && (
            <g className="aut-eye-lift">
              <use href={`#aut-hook${suffix}`} />
              <ellipse className="aut-eye-transfer" rx={dot * 1.03} ry={dot * 0.78} />
            </g>
          )}
          {tracksInk && (
            <g className={check ? "aut-eye-check" : "aut-eye-hook"}>
              <use href={hook ? `#aut-hook${suffix}` : "#aut-check"} mask={`url(#${id}-ink)`} />
            </g>
          )}
          {expression === "report" && (
            <g transform="translate(.85 -9.7) rotate(8) scale(.6)">
              <g className="aut-eye-star">
                <use href="#aut-star" />
                {!small && <use href="#aut-star-glint" />}
              </g>
            </g>
          )}
        </g>
      </g>
    </g>
  );
}

function Wink({ state, action, animate, size }: CharacterPose) {
  const small = size === "small";
  const expression = action === "received" || action === "report" ? action : state;
  const blink = action === "blink";
  return (
    <svg
      className={small ? "aut-wink-small" : "aut-wink"}
      viewBox="-12 -28 120 136"
      fill="currentColor"
      aria-hidden="true"
      data-expression={expression}
      data-animate={(animate && !blink) || undefined}
      data-blink={blink ? (animate ? "moving" : "still") : undefined}
    >
      {expression === "idle" && !blink ? (
        <use href={small ? "#aut-wink-small" : "#aut-wink"} />
      ) : (
        <EyeCorner expression={expression} small={small} />
      )}
    </svg>
  );
}

export const wink: CharacterDefinition = {
  id: "wink",
  label: "单眼 a",
  Render: Wink,
  states: conversationStates,
  actions: { ...conversationActions, blink: { label: "眨眼", durationMs: 650 } },
};
