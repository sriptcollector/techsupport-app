// The character: C, a small face with a headset (Orion picked it, 2026-11-10). Eyes and brows carry the emotion
// (scope §4.2). Variants B and C exist only for Orion to pick from.
export type Expr = "idle" | "listening" | "thinking" | "focused" | "pressing" | "happy" | "hmm" | "careful" | "waiting" | "stopped" | "sorry";

export function Bot({ expr = "idle", size = 36, look = [0, 0], variant = "c" }: { expr?: Expr; size?: number; look?: [number, number]; variant?: "a" | "b" | "c" }) {
  const [lx, ly] = look;
  const eyeY = expr === "thinking" ? 15 : expr === "sorry" ? 21 : 18;
  const eyeDX = expr === "thinking" ? 2 : lx * 2;
  const eyeDY = ly * 1.5;
  const squint = expr === "pressing" ? 0.5 : 1;
  const happy = expr === "happy";
  const eye = (cx: number, small = false) =>
    happy ? (
      <path d={`M${cx - 3.2} ${eyeY + 1} q3.2 -5 6.4 0`} stroke="#fff" strokeWidth="2.4" fill="none" strokeLinecap="round" />
    ) : (
      <ellipse cx={cx + eyeDX} cy={eyeY + eyeDY} rx={small ? 2.2 : 2.8} ry={(small ? 3.4 : 4.6) * squint} fill="#fff" />
    );
  const brows =
    expr === "careful" ? (
      <g stroke="#fff" strokeWidth="1.8" strokeLinecap="round"><path d="M10 12 l5 -1.8" /><path d="M26 12 l-5 -1.8" /></g>
    ) : expr === "hmm" ? (
      <path d="M21 10 l5 -1.4" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
    ) : expr === "waiting" || expr === "stopped" || expr === "thinking" ? (
      <g stroke="#fff" strokeWidth="1.8" strokeLinecap="round"><path d="M10.5 10 h5" /><path d="M20.5 10 h5" /></g>
    ) : expr === "sorry" ? (
      <g stroke="#fff" strokeWidth="1.8" strokeLinecap="round"><path d="M10 13 l5 -1.6" /><path d="M26 13 l-5 -1.6" /></g>
    ) : null;
  const body =
    variant === "b" ? (
      <path d="M6 3 L32 18 L19 20.5 L13 33 Z" fill="#0B0B0B" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
    ) : variant === "c" ? (
      <g><circle cx="18" cy="19" r="15" fill="#0B0B0B" stroke="#fff" strokeWidth="2" /><path d="M5 18 a13 13 0 0 1 26 0" stroke="#fff" strokeWidth="2" fill="none" /><rect x="2" y="16" width="5" height="8" rx="2" fill="#fff" /><path d="M7 24 q2 6 8 6" stroke="#fff" strokeWidth="1.6" fill="none" /></g>
    ) : (
      <path d="M18 2 C29 2 34 7 34 18 C34 29 29 34 18 34 C7 34 2 29 2 18 C2 7 7 2 18 2 Z" fill="#0B0B0B" stroke="#fff" strokeWidth="2" />
    );
  return (
    <svg width={size} height={size} viewBox="0 0 36 36" aria-hidden="true" style={{ transform: expr === "pressing" ? "scaleY(0.9)" : undefined, transition: "transform 80ms" }}>
      {body}
      {variant === "b" ? (
        <g transform="translate(4.5 3) scale(0.62)">{eye(13)}{eye(23)}</g>
      ) : (
        <>
          {eye(13, expr === "hmm")}
          {eye(23)}
          {brows}
        </>
      )}
      {expr === "stopped" && <g stroke="#fff" strokeWidth="2" strokeLinecap="round"><path d="M7 27 v-4" /><path d="M29 27 v-4" /></g>}
    </svg>
  );
}

/** Live mic level as 5 bars in the person's color. */
export function Bars({ level }: { level: number }) {
  const hs = [0.5, 0.8, 1, 0.8, 0.5].map((k) => 4 + Math.round(14 * Math.min(1, level * 1.6) * k));
  return (
    <span className="bars" aria-hidden="true">
      {hs.map((h, i) => (
        <i key={i} style={{ transform: `scaleY(${h / 18})` }} />
      ))}
    </span>
  );
}
