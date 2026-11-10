// The see-through layer over the whole screen. It shows the character flying to where it acts,
// its speech bubbles, the risky-action card, and bug mode (select the window, point, paint).
// It never takes clicks except in bug mode and while a Yes card is up.
import { emitTo, listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { Bot, type Expr } from "./bot";
import { autopilot, windowsList, type Win } from "./api";
import { saidThatsAll } from "./voice";

type Mode = "off" | "walk" | "pick" | "mark";
type Pin = { n: number; x: number; y: number; at: number };
type Stroke = { pts: [number, number][]; at: number };
type Tag = { x: number; y: number; text: string };

const BOT = 36;
export function Overlay() {
  const [mode, setMode] = useState<Mode>("off");
  const [expr, setExpr] = useState<Expr>("idle");
  const [pos, setPos] = useState<[number, number]>([innerWidth / 2, innerHeight / 2]);
  const [say, setSay] = useState<{ text: string; spoken: number } | null>(null);
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);
  const [point, setPoint] = useState<[number, number] | null>(null);
  const [card, setCard] = useState<{ x: number; y: number; title: string; detail: string; undoable: boolean } | null>(null);
  const [wins, setWins] = useState<Win[]>([]);
  const [hover, setHover] = useState<Win | null>(null);
  const [region, setRegion] = useState<Win | null>(null);
  const [tool, setTool] = useState<"point" | "paint">("point");
  const [pins, setPins] = useState<Pin[]>([]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [textSize, setTextSize] = useState(17);
  const botRef = useRef<HTMLDivElement>(null);
  const posRef = useRef(pos);
  const marks = useRef<{ pins: Pin[]; strokes: Stroke[] }>({ pins: [], strokes: [] });
  marks.current = { pins, strokes };
  const drawing = useRef<Stroke | null>(null);
  const regionRef = useRef<Win | null>(null);
  regionRef.current = region;
  const canvas = useRef<HTMLCanvasElement>(null);

  // ---------- messages from the panel ----------
  useEffect(() => {
    const un: Promise<() => void>[] = [
      listen<{ mode: Mode }>("ov:mode", async (e) => {
        setMode(e.payload.mode);
        setSay(null);
        setPoint(null);
        setCard(null);
        if (e.payload.mode === "pick") {
          setRegion(null);
          setPins([]);
          setStrokes([]);
          setTags([]);
          setTool("point");
          setWins(await windowsList().catch(() => []));
          setPosNow([innerWidth / 2 - BOT / 2, innerHeight / 2 - 90]);
          setExpr("listening");
          // CI only: the scripted person clicks the window in the middle of the screen, then points at it.
          if (await autopilot()) setTimeout(() => document.dispatchEvent(new CustomEvent("ap-pick")), 3000);
        }
      }),
      listen<{ x: number; y: number; ms: number }>("ov:fly", (e) => fly(e.payload.x, e.payload.y, e.payload.ms)),
      listen<{ expr: Expr }>("ov:expr", (e) => setExpr(e.payload.expr)),
      listen<{ text: string | null; spoken?: number }>("ov:say", (e) => setSay(e.payload.text ? { text: e.payload.text, spoken: e.payload.spoken ?? 999 } : null)),
      listen<{ x: number; y: number }>("ov:press", (e) => {
        const id = Math.random();
        setRipples((r) => [...r, { id, ...e.payload }]);
        setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), 320);
      }),
      listen<{ x: number; y: number } | null>("ov:point", (e) => setPoint(e.payload ? [e.payload.x, e.payload.y] : null)),
      listen<{ x: number; y: number; title: string; detail: string; undoable: boolean } | null>("ov:confirm", async (e) => {
        setCard(e.payload);
        if (e.payload && (await autopilot())) setTimeout(() => answer(true), 3000);
      }),
      listen<{ text: string; at: number }>("ov:words", (e) => attachWords(e.payload.text, e.payload.at)),
      listen<{ textSize: number }>("ov:settings", (e) => setTextSize(e.payload.textSize)),
      listen("ov:finish-bug", () => finishBug()),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, []);

  function setPosNow(p: [number, number]) {
    posRef.current = p;
    setPos(p);
    if (botRef.current) botRef.current.style.transform = `translate(${p[0]}px, ${p[1]}px)`;
  }

  // Flight on a gentle arc (scope §4.6); the bot's top-left sits 4 px down-right of the target.
  function fly(tx: number, ty: number, ms: number) {
    const el = botRef.current;
    const [sx, sy] = posRef.current;
    const ex = tx + 4,
      ey = ty + 4;
    const dx = ex - sx,
      dy = ey - sy;
    const dist = Math.hypot(dx, dy);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    posRef.current = [ex, ey];
    setPos([ex, ey]);
    if (!el || dist < 2) return;
    if (reduced) {
      el.animate([{ opacity: 1 }, { opacity: 0 }, { opacity: 1 }], { duration: 150 });
      el.style.transform = `translate(${ex}px, ${ey}px)`;
      return;
    }
    const nx = -dy / dist,
      ny = dx / dist;
    const frames: Keyframe[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const bend = Math.sin(Math.PI * t) * dist * 0.12;
      frames.push({ transform: `translate(${sx + dx * t + nx * bend}px, ${sy + dy * t + ny * bend}px) rotate(${Math.sin(Math.PI * t) * (dx > 0 ? 8 : -8)}deg)` });
    }
    el.animate(frames, { duration: ms, easing: "cubic-bezier(.45,0,.55,1)", fill: "forwards" }).onfinish = () => {
      el.style.transform = `translate(${ex}px, ${ey}px)`;
    };
  }

  // ---------- bug mode ----------
  function winAt(x: number, y: number) {
    return wins.find((w) => x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) ?? null;
  }
  const whole = (): Win => ({ title: "", app: "The whole screen", x: 0, y: 0, w: innerWidth, h: innerHeight });

  function attachWords(text: string, at: number) {
    const { pins, strokes } = marks.current;
    const last = [...pins.map((p) => ({ at: p.at, x: p.x, y: p.y, pin: p.n })), ...strokes.map((s) => ({ at: s.at, x: s.pts[s.pts.length - 1][0], y: s.pts[s.pts.length - 1][1], pin: null as number | null }))].sort((a, b) => b.at - a.at)[0];
    // Words said right after a mark sit next to that mark.
    const near = last && at - last.at < 10_000 ? last : null; // `at` is when the words came back, a few seconds after they were said
    // "That's all" ends bug mode; it isn't a note about the problem.
    if (near && !saidThatsAll(text)) setTags((t) => [...t, { x: near.x, y: near.y + 50 * t.filter((o) => Math.hypot(o.x - near.x, o.y - near.y) < 60 || o.x === near.x).length, text }]);
    emitTo("panel", "ov:tagged", { text, pin: near?.pin ?? null });
  }

  function onDown(e: React.PointerEvent) {
    if (mode === "pick") return;
    if (mode !== "mark" || (e.target as HTMLElement).closest(".toolbar")) return;
    const p: [number, number] = [e.clientX, e.clientY];
    if (!region) setRegion(winAt(...p) ?? whole());
    if (tool === "point") {
      setPins((ps) => [...ps, { n: ps.length + 1, x: p[0], y: p[1], at: Date.now() }]);
    } else {
      drawing.current = { pts: [p], at: Date.now() };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    }
  }
  function onMove(e: React.PointerEvent) {
    if (mode === "pick") return setHover(winAt(e.clientX, e.clientY));
    if (drawing.current) {
      drawing.current.pts.push([e.clientX, e.clientY]);
      redraw([...strokes, drawing.current]);
    }
  }
  function onUp() {
    if (drawing.current) {
      const s = drawing.current;
      drawing.current = null;
      if (s.pts.length > 1) setStrokes((ss) => [...ss, { ...s, at: Date.now() }]);
    }
  }
  function onClickPick(e: React.MouseEvent) {
    if (mode !== "pick") return;
    const w = winAt(e.clientX, e.clientY) ?? whole();
    setRegion(w);
    setMode("mark");
    setExpr("listening");
    emitTo("panel", "ov:picked", { app: w.app || w.title });
  }
  function redraw(all: Stroke[]) {
    const c = canvas.current;
    if (!c) return;
    c.width = innerWidth * devicePixelRatio;
    c.height = innerHeight * devicePixelRatio;
    const g = c.getContext("2d")!;
    g.scale(devicePixelRatio, devicePixelRatio);
    g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--user").trim() || "#2563eb";
    g.globalAlpha = 0.75;
    g.lineWidth = 6;
    g.lineCap = g.lineJoin = "round";
    for (const s of all) {
      g.beginPath();
      s.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
    }
  }
  useEffect(() => redraw(strokes), [strokes]);

  useEffect(() => {
    const f = () => {
      const c: [number, number] = [innerWidth / 2, innerHeight / 2];
      const w = winAt(...c) ?? whole();
      setRegion(w);
      setMode("mark");
      emitTo("panel", "ov:picked", { app: w.app || w.title });
      setPins([{ n: 1, x: w.x + w.w / 2, y: w.y + w.h / 2, at: Date.now() }]);
    };
    document.addEventListener("ap-pick", f);
    return () => document.removeEventListener("ap-pick", f);
  }, [wins]);

  function finishBug() {
    const r = regionRef.current ?? whole();
    emitTo("panel", "ov:bugdone", { region: [r.x, r.y, r.w, r.h], app: r.app || r.title, pins: marks.current.pins, strokes: marks.current.strokes.map((s) => s.pts) });
    setMode("off");
  }

  const answer = (yes: boolean) => {
    setCard(null);
    emitTo("panel", "ov:answer", { yes });
  };

  // Bubble: above-right of the bot, flipped to whichever side has room.
  const bx = pos[0] + BOT + 8 > innerWidth - 300 ? pos[0] - 296 : pos[0] + BOT + 8;
  const by = pos[1] - 64 < 8 ? pos[1] + BOT + 8 : pos[1] - 64;
  const box = mode === "pick" ? hover : mode === "mark" ? region : null;
  const words = say?.text.split(" ") ?? [];

  if (mode === "off") return <div className="overlay" />;
  return (
    <div className={`overlay${mode === "pick" || mode === "mark" || card ? " interactive" : ""}`} style={{ ["--bubble" as any]: `${textSize}px`, cursor: mode === "mark" && tool === "paint" ? "crosshair" : undefined }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onClick={onClickPick}>
      {(mode === "pick" || mode === "mark") && !box && <div className="dim" />}
      {box && (
        <div className="winbox" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
          <span className="tag">{box.app || box.title}</span>
        </div>
      )}
      <canvas ref={canvas} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />
      {pins.map((p) => (
        <span key={p.n} className="pinmark" style={{ left: p.x, top: p.y }}>{p.n}</span>
      ))}
      {tags.slice(-6).map((t, i) => (
        <div key={i} className="bubble user" style={{ left: Math.min(t.x + 18, innerWidth - 300), top: t.y + 12 }}>{t.text}</div>
      ))}
      {mode === "pick" && (
        <div className="callout" style={{ top: innerHeight / 2 - 40 }} role="status">
          <h2>Select the bug</h2>
          <p className="small" style={{ margin: "6px 0 0" }}>Click the window that's acting up. Or click anywhere on the screen.</p>
        </div>
      )}
      {mode === "mark" && (
        <div className="toolbar" role="toolbar" aria-label="Show us the problem">
          <button className={`btn${tool === "point" ? " on" : ""}`} onClick={() => setTool("point")} aria-pressed={tool === "point"}>Point</button>
          <button className={`btn${tool === "paint" ? " on" : ""}`} onClick={() => setTool("paint")} aria-pressed={tool === "paint"}>Paint</button>
          <button className="btn" onClick={() => setStrokes((s) => s.slice(0, -1))} disabled={!strokes.length}>Undo</button>
          <button className="btn" onClick={() => (setStrokes([]), setPins([]), setTags([]))}>Clear</button>
          <span className="hint">Say "that's all" when you're done</span>
          <button className="btn primary" onClick={finishBug}>Done</button>
        </div>
      )}
      {point && <span className="pulse" style={{ left: point[0], top: point[1] }} />}
      {card && <span className="target" style={{ left: card.x, top: card.y }} />}
      {ripples.map((r) => (
        <span key={r.id} className="ripple" style={{ left: r.x, top: r.y }} />
      ))}
      {mode !== "mark" && (
        <div ref={botRef} className="bot" style={{ transform: `translate(${pos[0]}px, ${pos[1]}px)` }}>
          <Bot expr={expr} />
        </div>
      )}
      {say && mode === "walk" && !card && (
        <div className="bubble" style={{ left: bx, top: by }} aria-live="polite">
          {words.map((w, i) => (
            <span key={i} className={`word${i < say.spoken ? " said" : ""}`}>{w} </span>
          ))}
        </div>
      )}
      {card && (
        <div className="card" style={{ left: Math.min(card.x + 30, innerWidth - 360), top: Math.min(Math.max(card.y - 40, 16), innerHeight - 260) }} role="alertdialog" aria-label={card.title}>
          <h2>{card.title}</h2>
          {card.detail && <div className="detail">{card.detail}</div>}
          <p className="small" style={{ margin: "0 0 14px" }}>{card.undoable ? "You can get it back." : "This can't be undone."}</p>
          <button className="btn primary full" autoFocus onClick={() => answer(true)}>Yes, do it</button>
          <button className="link" style={{ width: "100%", marginTop: 6 }} onClick={() => answer(false)}>No, don't</button>
        </div>
      )}
    </div>
  );
}
