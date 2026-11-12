// The panel under the menu bar icon (Mac) or above the tray icon (Windows): first-run steps,
// the two big buttons, the chat (voice first, typing takes over), the plan card, the Step pill
// while the character works, and the "Did that fix it?" card.
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { Session, type Pick } from "./agent";
import { ack, apLog, api, ApiError, autopilot, capture, getEnv, hush, loadToken, overlayMode, placePanel, server, setToken, setUser, speak, track, type Me } from "./api";
import { Bars, Bot } from "./bot";
import { Mic, saidStop, saidThatsAll } from "./voice";
import { Perms } from "./perms";

// Chat first (Orion, 2026-11-11): "home" is the chat with nothing asked yet; "chat" is a running conversation.
type View = "loading" | "welcome" | "signin" | "trial" | "comfort" | "perms" | "home" | "chat" | "pill" | "bug" | "settings";
type Line = { who: "bot" | "me"; text: string; pin?: number | null };
type Card =
  | { kind: "plan"; understood: string; steps: string[]; fix: boolean; wait: boolean }
  | { kind: "ask"; question: string; options: string[] }
  | { kind: "done"; outcome: string; worked: boolean; steps: string[] }
  | { kind: "stopped" }
  | { kind: "problem"; title: string; body?: string; action?: { label: string; run: () => void } }
  | null;

const win = getCurrentWindow();
const SIZES: Partial<Record<View, [number, number]>> = { home: [400, 560], chat: [400, 560], bug: [380, 460], pill: [380, 64], settings: [380, 560] };
// Gentle mode: bigger words need a bigger window.
const GENTLE_SIZE: [number, number] = [440, 640];
const gentleOf = (m: Me | null) => (m?.settings.comfort ?? "") !== "quick";
const SHOW_ME = `Switch to "Show me, I'll click": point with mouse_move and use needs_you; don't click.`;
function textScale() {
  const el = document.createElement("span");
  el.textContent = "M";
  el.style.cssText = "position:absolute;visibility:hidden;font:100px/1 var(--font);";
  document.body.appendChild(el);
  const k = el.getBoundingClientRect().height / 100;
  el.remove();
  return k < 1.15 ? 1 : Math.min(1.5, k); // only real "bigger text" settings, never font quirks
}
const SUGGEST = ["Make my text bigger", "Check my Wi-Fi", "Show me how to take a screenshot"];

export function Panel() {
  const [view, setView] = useState<View>("loading");
  const [me, setMe] = useState<Me | null>(null);
  const [os, setOs] = useState<"mac" | "windows">("windows");
  const [lines, setLines] = useState<Line[]>([]);
  const [card, setCard] = useState<Card>(null);
  const [level, setLevel] = useState(0);
  const [micOn, setMicOn] = useState(false);
  const [hearing, setHearing] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [draft, setDraft] = useState("");
  const [progress, setProgress] = useState({ n: 0, total: 0, task: "" });
  const [needs, setNeeds] = useState<string | null>(null);
  const meRef = useRef<Me | null>(null);
  meRef.current = me;
  const viewRef = useRef(view);
  viewRef.current = view;
  const session = useRef<Session | null>(null);
  const waiter = useRef<((s: string) => void) | null>(null);
  const bugWords = useRef<{ text: string; pin: number | null }[]>([]);
  const mic = useRef<Mic | null>(null);
  const firstRun = useRef(false);

  const say = (who: Line["who"], text: string, pin?: number | null) => setLines((l) => [...l, { who, text, pin }]);

  // ---------- window size and placement ----------
  async function show(v: View) {
    setView(v);
    viewRef.current = v; // at once, so start-up code never mistakes a chosen view for "loading"
    document.body.dataset.busy = v === "pill" || v === "bug" || v === "chat" ? "1" : "0";
    const base = (v === "home" || v === "chat") && gentleOf(meRef.current) ? GENTLE_SIZE : SIZES[v] ?? [560, 640];
    await (SIZES[v] ? placePanel(base[0], base[1]) : win.setSize(new LogicalSize(base[0], base[1])));
    // Big system text (Windows "Text size", Mac larger text) makes everything bigger than our fixed
    // window: either the fonts grow or the whole page zooms. Measure it and grow the window to match,
    // never past the screen.
    const k = Math.min(1.6, Math.max(textScale(), base[0] / innerWidth));
    if (k > 1.05) {
      const z = Math.max(1, base[0] / innerWidth); // screen sizes below are in zoomed CSS pixels
      const maxW = screen.availWidth * z * 0.95, maxH = screen.availHeight * z * 0.92;
      const w = Math.min(Math.ceil(base[0] * k), maxW), h = Math.min(Math.ceil(base[1] * k), maxH);
      await (SIZES[v] ? placePanel(w, h) : win.setSize(new LogicalSize(w, h)));
    }
    if (!SIZES[v]) await win.center();
    if (v !== "pill") await invoke("walk_focus", { walking: false });
    await win.show();
    if (v !== "pill") await win.setFocus();
  }
  // Keep the pill off the spot the helper is about to press.
  const pillLow = useRef(false);
  async function avoid(x: number, y: number) {
    if (viewRef.current !== "pill") return;
    const k = await win.scaleFactor();
    const pos = (await win.outerPosition()).toLogical(k);
    const sz = (await win.outerSize()).toLogical(k);
    if (x > pos.x - 40 && x < pos.x + sz.width + 40 && y > pos.y - 40 && y < pos.y + sz.height + 40) {
      pillLow.current = !pillLow.current;
      const { availWidth, availHeight } = window.screen;
      await win.setPosition(new LogicalPosition(pillLow.current ? 16 : availWidth - sz.width - 16, pillLow.current ? availHeight - sz.height - 16 : 40));
    }
  }

  // ---------- start-up: who is this, have they started the trial, are permissions on ----------
  async function route(openAfter = true) {
    const env = await getEnv();
    setOs(env.os);
    const t = await loadToken();
    if (!t) {
      firstRun.current = true;
      return show(localStorage.getItem("ts_seen") ? "signin" : "welcome");
    }
    let m: Me;
    try {
      m = await api<Me>("/api/me");
    } catch (e) {
      if ((e as ApiError).status === 401) {
        await setToken(null);
        return show("signin");
      }
      setCard({ kind: "problem", title: "You're offline. I can still help you get back online.", body: "Check that Wi-Fi is on, then try again." });
      return show("chat");
    }
    setMe(m);
    setUser(m.email);
    emitTo("overlay", "ov:settings", { textSize: m.settings.textSize });
    if (!m.canUse && m.why === "no_plan") return show("trial");
    // One setup question: how comfortable are you with tech? (sets Quick or Gentle; changeable any time)
    if (!m.settings.comfort) return show("comfort");
    if (env.os === "mac") {
      const p = await invoke<{ screen: boolean; control: boolean }>("perms_status");
      if (!p.screen || !p.control || !localStorage.getItem("ts_capture_ok")) return show("perms");
    }
    if (firstRun.current || openAfter) {
      firstRun.current = false;
      return goHome();
    }
  }

  useEffect(() => {
    route(false).then(() => {
      if (viewRef.current === "loading") setView("home");
    });
    const un = [
      listen<boolean>("panel-toggle", async (e) => {
        if (!e.payload || (await win.isVisible())) {
          if (viewRef.current === "home" || viewRef.current === "settings") return win.hide();
          if (!e.payload) return;
        }
        if (viewRef.current === "loading" || viewRef.current === "home" || viewRef.current === "settings") route(true);
        else show(viewRef.current);
      }),
      listen<{ text: string; pin: number | null }>("ov:tagged", (e) => {
        bugWords.current.push(e.payload);
        say("me", e.payload.text, e.payload.pin);
      }),
      listen<{ app: string; x: number; w: number }>("ov:picked", (e) => {
        say("bot", `Got it: ${e.payload.app}. Show me and tell me what's wrong.`);
        // Keep the chat off the window they picked.
        invoke("panel_away", { x: e.payload.x, w: e.payload.w });
      }),
      listen<{ region: [number, number, number, number]; app: string; pins: any[]; strokes: [number, number][][] }>("ov:bugdone", (e) => startFix(e.payload)),
    ];
    getEnv().then((env) => register(env.os === "mac" ? "Control+Alt+T" : "Control+Alt+T", (e) => e.state === "Pressed" && emitTo("panel", "panel-toggle", true)).catch(() => {}));
    const blur = win.onFocusChanged(({ payload }) => {
      if (!payload && viewRef.current === "home") win.hide();
    });
    return () => {
      un.forEach((p) => p.then((f) => f()));
      blur.then((f) => f());
    };
  }, []);

  // ---------- the mic ----------
  function ensureMic(onWords: (t: string) => void) {
    mic.current?.stop();
    mic.current = new Mic({
      onLevel: setLevel,
      onSpeaking: setHearing,
      onWords: (h) => onWords(h.text),
      silenceMs: 1200,
    });
    mic.current.start().then((ok) => setMicOn(ok));
  }
  function micOff(flush = false) {
    mic.current?.stop(flush);
    setMicOn(false);
    setHearing(false);
  }

  // ---------- "I don't know how to do something" ----------
  const learning = useRef(false);
  // The chat with nothing asked yet (the greeting is drawn when there are no lines).
  function goHome() {
    micOff();
    session.current?.end();
    session.current = null;
    learning.current = false;
    waiter.current = null;
    setLines([]);
    setCard(null);
    setDraft("");
    return show("home");
  }
  function startHow(prefill?: string, learn = false) {
    track("cta_click", { cta: learn ? "learn" : "how" });
    if (!meRef.current?.canUse) return blocked();
    learning.current = learn;
    setLines(learn ? [{ who: "bot", text: "What do you want to learn?" }] : []);
    setCard(null);
    setDraft("");
    session.current = null;
    show(learn ? "chat" : "home");
    if (prefill) return heard(prefill);
  }
  // Quick or Gentle, switchable any time from the chat header.
  async function setComfort(c: "quick" | "gentle") {
    const m = meRef.current;
    if (!m || m.settings.comfort === c) return;
    setMe({ ...m, settings: { ...m.settings, comfort: c } });
    track("comfort_set", { comfort: c, where: "chat" });
    const r = await api<Me>("/api/settings", { comfort: c }).catch(() => null);
    if (r) setMe(r);
    if (viewRef.current === "home" || viewRef.current === "chat") show(viewRef.current);
  }
  // The first reply streams in about a second while the helper looks at the screen.
  function quickReply(t: string) {
    const m = meRef.current;
    let at = -1;
    ack(t, m?.settings.comfort || "gentle", os, (all) =>
      setLines((l) => {
        if (at < 0) {
          at = l.length;
          return [...l, { who: "bot", text: all }];
        }
        const c = l.slice();
        c[at] = { ...c[at], text: all };
        return c;
      }),
    ).catch(() => {});
  }
  function heard(text: string) {
    const t = text.trim();
    if (!t) return;
    const s = session.current;
    if (s && viewRef.current === "pill") {
      if (saidStop(t)) s.stop("voice");
      return;
    }
    say("me", t);
    if (waiter.current) {
      const w = waiter.current;
      waiter.current = null;
      return w(t);
    }
    if (!s) {
      if (!meRef.current?.canUse) return blocked();
      if (viewRef.current === "home") show("chat");
      quickReply(t);
    }
    if (!s) return begin("how", learning.current ? `They want to learn how: "${t}". Teach them: for each step point at the spot (mouse_move) and let them click it themselves (needs_you), with one short line on why.` : `They said: "${t}"`);
    setThinking(true);
    s.more(t).finally(() => setThinking(false));
  }
  async function begin(mode: "how" | "fix", text: string, extra: any[] = []) {
    const s = new Session(mode, ui);
    session.current = s;
    setThinking(true);
    try {
      await s.start(text, extra);
    } catch {
      setCard({ kind: "problem", title: "I can't see your screen yet.", body: os === "mac" ? "Turn on screen sharing for Tech Support, then try again." : "Try again in a moment." });
    } finally {
      setThinking(false);
    }
  }

  // The agent asks the panel to show things through this.
  const ui = {
    settings: () => meRef.current!.settings,
    plan: async (understood: string, steps: string[]) => {
      // Quick: the plan shows and it starts right away. Gentle: nothing changes until they say Yes.
      const wait = gentleOf(meRef.current);
      say("bot", understood);
      setCard({ kind: "plan", understood, steps, fix: session.current?.mode === "fix", wait });
      speak(wait ? `${understood} Shall I?` : understood, meRef.current?.settings);
      if (!wait) return "do" as Pick;
      show("chat");
      return new Promise<Pick | string>((resolve) => {
        pickRef.current = (p) => {
          pickRef.current = () => {};
          setCard(null);
          if (p === "steps") say("bot", "Okay. I didn't change anything.");
          resolve(p);
        };
        // Words typed or said while the card is up count as their answer.
        waiter.current = (t) => {
          pickRef.current = () => {};
          setCard(null);
          resolve(t);
        };
      }) as Promise<Pick>;
    },
    ask: (question: string, options: string[]) =>
      new Promise<string>((resolve) => {
        say("bot", question);
        setCard({ kind: "ask", question, options });
        show("chat");
        waiter.current = (t) => {
          setCard(null);
          resolve(t);
        };
      }),
    bot: (text: string) => say("bot", text),
    avoid: (x: number, y: number) => avoid(x, y),
    progress: (n: number, total: number, task: string) => setProgress({ n, total, task }),
    walking: async (on: boolean) => {
      if (on) {
        micOff();
        await overlayMode(true, false);
        // Stop words still work while it works: the mic keeps listening for "stop".
        ensureMic(heard);
        register("Escape", () => session.current?.stop("esc")).catch(() => {});
        await show("pill");
        invoke("walk_focus", { walking: true });
      } else {
        unregister("Escape").catch(() => {});
        invoke("walk_focus", { walking: false });
      }
    },
    needsYou: (text: string) => setNeeds(text),
    done: (outcome: string, worked: boolean, steps: string[]) => {
      micOff();
      setNeeds(null);
      say("bot", outcome);
      setCard({ kind: "done", outcome, worked, steps });
      speak(worked ? `Done. ${outcome}` : outcome, meRef.current?.settings);
      setTimeout(() => overlayMode(false), 2500);
      show("chat");
    },
    problem: (kind: string) => {
      micOff();
      if (kind === "stopped") {
        setCard({ kind: "stopped" });
        return show("chat");
      }
      overlayMode(false);
      const P: Record<string, Card> = {
        offline: { kind: "problem", title: "Lost the internet for a moment.", body: "Check your Wi-Fi, then try again." },
        busy: { kind: "problem", title: "I'm having trouble thinking right now. Try again in a minute." },
        cap: { kind: "problem", title: "This one's taking too long. Let's try a different way.", action: { label: "Show me, I'll click", run: () => session.current?.more('Switch to "Show me, I\'ll click": point and use needs_you, don\'t click.') } },
        month_used: { kind: "problem", title: `You've used this month's help. It refills on the 1st.` },
        trial_used: { kind: "problem", title: "You've used your free week's help.", body: "Your plan starts when the trial ends." },
        no_plan: { kind: "problem", title: "Start your free week to get help.", action: { label: "Start my free week", run: () => show("trial") } },
      };
      setCard(P[kind] ?? P.busy);
      show("chat");
    },
  };
  const pickRef = useRef<(p: Pick) => void>(() => {});

  function blocked() {
    const m = meRef.current;
    if (!m) return route(true);
    if (m.why === "no_plan") return show("trial");
    ui.problem(m.why ?? "busy");
  }

  // ---------- "Something is broken" ----------
  async function startBug() {
    track("cta_click", { cta: "broken" });
    if (!meRef.current?.canUse) return blocked();
    setLines([{ who: "bot", text: "Select the bug. Click the window that's acting up." }]);
    setCard(null);
    bugWords.current = [];
    session.current = null;
    await show("bug");
    await overlayMode(true, true);
    emitTo("overlay", "ov:mode", { mode: "pick" });
    speak("Select the bug", meRef.current?.settings);
    let quiet = 0;
    ensureMic((t) => {
      emitTo("overlay", "ov:words", { text: t, at: Date.now() });
      quiet = Date.now();
      if (saidThatsAll(t)) emitTo("overlay", "ov:finish-bug", {});
    });
    // Nudge after 20 s of quiet, finish after 60 s.
    quiet = Date.now();
    const iv = setInterval(() => {
      if (viewRef.current !== "bug") return clearInterval(iv);
      const q = Date.now() - quiet;
      if (q > 60_000) {
        clearInterval(iv);
        emitTo("overlay", "ov:finish-bug", {});
      } else if (q > 20_000 && q < 21_000) say("bot", 'Anything else? Say "that\'s all" when you\'re done.');
    }, 1000);
  }
  async function startFix(b: { region: [number, number, number, number]; app: string; pins: { n: number; x: number; y: number }[]; strokes: [number, number][][] }) {
    micOff();
    await overlayMode(false);
    say("bot", "Okay, let me look.");
    speak("Okay, let me look.", meRef.current?.settings);
    show("chat");
    const [rx, ry, rw, rh] = b.region;
    const shot = await capture(b.region, 1280);
    // Draw their pins and paint onto the picture of the window they picked.
    const img = new Image();
    img.src = `data:image/jpeg;base64,${shot.data}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = shot.w;
    c.height = shot.h;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const k = shot.w / rw;
    g.strokeStyle = "#2563eb";
    g.lineWidth = 6 * k;
    g.lineCap = g.lineJoin = "round";
    g.globalAlpha = 0.8;
    for (const s of b.strokes) {
      g.beginPath();
      s.forEach(([x, y], i) => (i ? g.lineTo((x - rx) * k, (y - ry) * k) : g.moveTo((x - rx) * k, (y - ry) * k)));
      g.stroke();
    }
    g.globalAlpha = 1;
    for (const p of b.pins) {
      const x = (p.x - rx) * k,
        y = (p.y - ry) * k;
      g.fillStyle = "#2563eb";
      g.beginPath();
      g.arc(x, y, 14, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#fff";
      g.font = "bold 16px sans-serif";
      g.textAlign = "center";
      g.fillText(String(p.n), x, y + 6);
    }
    const annotated = c.toDataURL("image/jpeg", 0.75).split(",")[1];
    const said = bugWords.current.map((w) => (w.pin ? `[pin ${w.pin}] ${w.text}` : w.text)).join("\n") || "(they didn't say anything)";
    await begin("fix", `Something is broken in: ${b.app || "their screen"}.\nWhat they said:\n${said}\n\nFirst picture: the window they pointed at, with their pins and paint (for understanding only). Second picture: the whole screen; use it for every click.`, [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: annotated } }]);
  }

  // ---------- typing beats talking ----------
  function onType(v: string) {
    if (micOn) micOff(true);
    setDraft(v);
  }
  function send() {
    const t = draft.trim();
    if (!t) return;
    setDraft("");
    heard(t);
  }

  // ---------- CI consumer test: press the recommended thing, like a person would ----------
  const apDone = useRef<Set<string>>(new Set());
  useEffect(() => {
    autopilot().then((ap) => {
      if (!ap) return;
      const once = (key: string, ms: number, f: () => void) => {
        if (apDone.current.has(key)) return;
        apDone.current.add(key);
        setTimeout(f, ms);
      };
      apLog(`view ${view} ${card?.kind ?? ""}`);
      const [head, ...rest] = ap.split(":");
      const kind = head.split("@")[0];
      const words = rest.join(":");
      if (view === "welcome") once("welcome", 3500, () => (localStorage.setItem("ts_seen", "1"), setView("signin")));
      if (view === "home") once("start", 4000, () => (kind === "bug" ? startBug() : kind === "voice" ? startHow() : startHow(words)));
      if (view === "bug") once("bugwords", 7000, () => {
        emitTo("overlay", "ov:words", { text: words, at: Date.now() });
        setTimeout(() => emitTo("overlay", "ov:words", { text: "That's all.", at: Date.now() }), 2500);
        setTimeout(() => emitTo("overlay", "ov:finish-bug", {}), 4000);
      });
      if (card?.kind === "plan" && kind === "showme") once("showme", 500, () => session.current?.showMe());
      if (card?.kind === "plan" && card.wait) once("yes", 2500, () => pickRef.current(kind === "showme" ? "show" : "do"));
      if (card?.kind === "ask") once(`ask${lines.length}`, 3000, () => heard(card.options[0]));
      if (card?.kind === "done") {
        apLog(`DONE worked=${card.worked} outcome=${card.outcome}`);
        once("done", 4000, () => document.querySelector<HTMLButtonElement>(".chip.rec")?.click());
      }
      if (card?.kind === "problem") apLog(`PROBLEM ${card.title}`);
      if (card?.kind === "stopped") apLog("STOPPED");
    });
  }, [view, card]);

  // ---------- views ----------
  const progressBar = (step: number) => (
    <div className="steps" aria-label={`Step ${step} of 4`}>
      {[1, 2, 3, 4].map((i) => <i key={i} className={i <= step ? "on" : ""} />)}
    </div>
  );

  if (view === "loading") return <div className="panel" />;
  if (view === "welcome")
    return (
      <div className="panel">
        <div className="drag" data-tauri-drag-region />
        {progressBar(0)}
        <div className="body center">
          <Bot expr="idle" size={72} />
          <h1>Hi. I'm Tech Support</h1>
          <p>I can do things on your computer for you, and show you how as I go.</p>
          <div className="grow" />
          <button className="btn primary full" autoFocus onClick={() => (localStorage.setItem("ts_seen", "1"), track("cta_click", { cta: "get_started" }), setView("signin"))}>Get started</button>
          <p className="small" style={{ margin: "10px 0 0" }}>Takes about 2 minutes.</p>
        </div>
      </div>
    );
  if (view === "signin")
    return <SignIn progress={progressBar(1)} who={me?.email ?? null} onBack={() => setView("welcome")} onSignOut={async () => (await setToken(null), setMe(null))} onDone={() => (track("sign_up"), route(true))} />;
  if (view === "trial") return <Trial progress={progressBar(2)} me={me} onBack={() => setView("signin")} onDone={() => route(true)} />;
  if (view === "comfort")
    return (
      <Comfort
        progress={progressBar(3)}
        onBack={() => setView("signin")}
        onPick={async (c) => {
          track("comfort_set", { comfort: c, where: "setup" });
          const r = await api<Me>("/api/settings", { comfort: c }).catch(() => null);
          if (r) setMe(r);
          route(true);
        }}
      />
    );
  if (view === "perms") return <Perms progress={progressBar(4)} Back={Back} onBack={() => setView("comfort")} onDone={() => goHome()} />;
  if (view === "settings") return <Settings me={me!} onBack={() => goHome()} onChange={setMe} onComfort={setComfort} onSignOut={async () => (await setToken(null), setMe(null), show("signin"))} />;

  if (view === "pill")
    return (
      <div className="pill" role="status">
        <Bot expr={needs ? "waiting" : "focused"} size={28} />
        <div className="what">
          <span className="mono">{progress.total ? `Step ${progress.n} of ${progress.total}` : "Working"}</span>
          <span>{needs ?? progress.task}</span>
        </div>
        <button className="btn stop" onClick={() => session.current?.stop("button")} aria-label="Stop">
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect width="12" height="12" rx="2" fill="currentColor" /></svg>
          Stop
        </button>
      </div>
    );

  // the chat (home = nothing asked yet) and the bug view
  const plan = card?.kind === "plan" ? card : null;
  const gentle = gentleOf(me);
  const fresh = view === "home" && lines.length === 0 && !session.current;
  const secs = (n: number) => (n * 13 < 50 ? `About ${Math.ceil((n * 13) / 10) * 10} seconds.` : n * 13 < 90 ? "About a minute." : `About ${Math.round((n * 13) / 60)} minutes.`);
  return (
    <div className={`panel ${gentle ? "gentle" : "quick"}`}>
      <header className="chat-head" data-tauri-drag-region>
        <div className="row" data-tauri-drag-region style={{ gap: 10 }}>
          <Bot expr="idle" size={28} />
          <strong data-tauri-drag-region>Tech Support</strong>
        </div>
        <div className="row" style={{ gap: 4 }}>
          {view !== "bug" && (
            <div className="seg" role="radiogroup" aria-label="How I talk">
              <button role="radio" aria-checked={!gentle} onClick={() => setComfort("quick")}>Quick</button>
              <button role="radio" aria-checked={gentle} onClick={() => setComfort("gentle")}>Gentle</button>
            </div>
          )}
          {view !== "home" && (
            <button className="icon-btn" aria-label="New question" title="New question" onClick={() => (hush(), overlayMode(false), emitTo("overlay", "ov:mode", { mode: "off" }), goHome())}><PlusIcon /></button>
          )}
          <button className="icon-btn" aria-label="Settings" title="Settings" onClick={() => (micOff(), show("settings"))}><GearIcon /></button>
        </div>
      </header>
      <div className="body" style={{ paddingTop: 12 }}>
        <div className="chat" aria-live="polite">
          {fresh && (
            <>
              <p className="greet">{gentle ? "Hi. What do you need help with today?" : "What's wrong?"}</p>
              <div className="chips" aria-label="Try one of these">
                {SUGGEST.map((s, i) => (
                  <button key={s} className={`chip${i === 0 ? " rec" : ""}`} onClick={() => (micOff(), heard(s))}>
                    {s}
                    {i === 0 && <span className="tag">Recommended</span>}
                  </button>
                ))}
                <button className="chip" onClick={startBug}>Something is broken: I'll show you</button>
                <button className="chip" onClick={() => startHow(undefined, true)}>Teach me something</button>
              </div>
            </>
          )}
          {lines.map((l, i) => (
            <div key={i} className={`msg ${l.who === "bot" ? "helper" : "me"}`}>
              {l.pin ? <span className="pin">{l.pin}</span> : null}
              {l.text}
            </div>
          ))}
          {thinking && !card && <div className="msg helper small">Looking at your screen…</div>}
          {plan && plan.wait && (
            <div className="plan">
              {plan.steps.length > 0 && <span className="mono">{plan.steps.length === 1 ? "1 step" : `${plan.steps.length} steps`} · {secs(plan.steps.length)}</span>}
              <ol>{plan.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              <p style={{ margin: "10px 0 0" }}>Shall I do it?</p>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn primary" autoFocus onClick={() => pickRef.current("do")}>Yes, do it</button>
                <button className="btn" onClick={() => pickRef.current("steps")}>Not now</button>
              </div>
              <button className="link" style={{ fontSize: 15, padding: "10px 0 0" }} onClick={() => pickRef.current("show")}>Show me, I'll click it myself</button>
              <p className="small" style={{ margin: "10px 0 0" }}>Press Stop or move your mouse and I stop at once. I never touch passwords or bank pages.</p>
            </div>
          )}
          {plan && !plan.wait && (
            <div className="plan log">
              <ol>{plan.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              <button className="link" style={{ fontSize: 14, padding: "8px 0 0" }} onClick={() => session.current?.showMe()}>Let me do it myself</button>
            </div>
          )}
          {card?.kind === "ask" && (
            <div className="chips">
              {card.options.map((o, i) => (
                <button key={o} className={`chip${i === 0 ? " rec" : ""}`} autoFocus={i === 0} onClick={() => heard(o)}>{o}{i === 0 && <span className="tag">Recommended</span>}</button>
              ))}
            </div>
          )}
          {card?.kind === "done" && (
            <div className="plan">
              {card.steps.length > 0 && (
                <>
                  <span className="mono">Next time, you can</span>
                  <ol>{card.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
                </>
              )}
              {card.worked && !session.current?.journal.some((j) => j.did) ? (
                <div className="chips" style={{ marginTop: 12 }}>
                  <button className="chip rec" autoFocus onClick={() => (track("fix_confirmed", { yes: true, kind: "answer" }), setCard(null), overlayMode(false), setTimeout(() => win.hide(), 800))}>Thanks</button>
                  <button className="chip" onClick={() => (setCard(null), say("bot", "What else would you like to know?"), ensureMic(heard))}>Ask something else</button>
                </div>
              ) : !card.worked ? (
                <div className="chips" style={{ marginTop: 12 }}>
                  <button className="chip rec" autoFocus onClick={() => (setCard(null), session.current?.more("Try again a different way. Take a screenshot first."))}>Try again<span className="tag">Recommended</span></button>
                  <button className="chip" onClick={() => (setCard(null), session.current?.more(SHOW_ME))}>Show me, I'll click</button>
                  <button className="chip" onClick={() => (setCard(null), overlayMode(false), goHome())}>I'm done</button>
                </div>
              ) : (
              <div className="chips" style={{ marginTop: 12 }}>
                <button className="chip rec" autoFocus onClick={() => (track("fix_confirmed", { yes: true }), say("bot", "Glad I could help."), speak("Glad I could help.", me?.settings), setCard(null), setTimeout(() => win.hide(), 2000))}>Yes, all good<span className="tag">Recommended</span></button>
                <button className="chip" onClick={() => (setCard(null), track("fix_confirmed", { yes: false }), say("bot", "What's still wrong?"), ensureMic(heard))}>No, still wrong</button>
                <button className="chip" onClick={() => (setCard(null), say("me", "Undo that"), session.current?.more(session.current.undoPrompt()))}>Undo that</button>
              </div>
              )}
            </div>
          )}
          {card?.kind === "stopped" && (
            <div className="plan">
              <h2>Stopped. Nothing else will happen.</h2>
              <div className="chips" style={{ marginTop: 12 }}>
                <button className="chip rec" autoFocus onClick={() => (setCard(null), overlayMode(false), session.current?.more("Keep going from where things are now. Take a screenshot first."))}>Keep going<span className="tag">Recommended</span></button>
                <button className="chip" onClick={() => (setCard(null), session.current?.more(session.current.undoPrompt()))}>Undo what you did</button>
                <button className="chip" onClick={() => (setCard(null), overlayMode(false), session.current?.end(), goHome())}>I'm done</button>
              </div>
            </div>
          )}
          {card?.kind === "problem" && (
            <div className="plan">
              <h2>{card.title}</h2>
              {card.body && <p className="small" style={{ margin: "6px 0 0" }}>{card.body}</p>}
              <div className="chips" style={{ marginTop: 12 }}>
                {card.action && <button className="chip rec" onClick={() => (setCard(null), card.action!.run())}>{card.action.label}</button>}
                <button className="chip" onClick={() => (setCard(null), route(true))}>Try again</button>
              </div>
            </div>
          )}
        </div>
        {micOn && (
          <div className="listening" aria-live="polite">
            <Bars level={level} />
            {hearing || view !== "bug" ? "Listening…" : 'Say "that\'s all" when you\'re done'}
          </div>
        )}
        <form className="composer" onSubmit={(e) => (e.preventDefault(), send())}>
          <input value={draft} autoFocus={view === "home"} onChange={(e) => onType(e.target.value)} placeholder="Type or talk…" aria-label="Say what you need" />
          <button type="button" className={`mic${micOn ? " on" : ""}`} aria-pressed={micOn} aria-label={micOn ? "Turn the mic off" : "Talk instead of typing"} onClick={() => (micOn ? micOff() : ensureMic(view === "bug" ? (t) => emitTo("overlay", "ov:words", { text: t, at: Date.now() }) : heard))}>
            <MicIcon />
          </button>
          <button type="submit" className="send" aria-label="Send" disabled={!draft.trim()}>
            <SendIcon />
          </button>
        </form>
      </div>
    </div>
  );
}

// Every setup step has a visible Back that keeps what was entered (Orion, 2026-11-10).
const Back = ({ onClick }: { onClick: () => void }) => (
  <button type="button" className="link back" onClick={onClick} aria-label="Back">
    ← Back
  </button>
);

// ---------- S3 sign in ----------
function SignIn({ progress, onDone, onBack, who, onSignOut }: { progress: React.ReactNode; onDone: () => void; onBack: () => void; who: string | null; onSignOut: () => void }) {
  const [step, setStep] = useState<"choose" | "email" | "code" | "waiting">("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleOn, setGoogleOn] = useState(true);
  useEffect(() => {
    api<{ google: boolean }>("/api/config").then((c) => setGoogleOn(c.google)).catch(() => {});
  }, []);
  async function google() {
    setStep("waiting");
    try {
      const t = await invoke<string>("google_signin", { server: await server() });
      await setToken(t);
      onDone();
    } catch {
      setErr("That didn't work. Let's try again.");
      setStep("choose");
    }
  }
  async function sendCode() {
    setBusy(true);
    setErr("");
    try {
      await api("/auth/email/start", { email });
      setStep("code");
    } catch (e) {
      setErr((e as ApiError).code === "offline" ? "You're offline. Check your Wi-Fi and try again." : "That email doesn't look right. Check it and try again.");
    }
    setBusy(false);
  }
  async function verify(c = code) {
    setBusy(true);
    setErr("");
    try {
      const r = await api<{ token: string }>("/auth/email/verify", { email, code: c });
      await setToken(r.token);
      onDone();
    } catch {
      setErr("That code didn't work. Check it, or send a new one.");
    }
    setBusy(false);
  }
  return (
    <div className="panel">
      <div className="drag" data-tauri-drag-region />
      {progress}
      <div className="body center">
        <Back onClick={() => (step === "code" ? setStep("email") : step === "email" || step === "waiting" ? setStep("choose") : onBack())} />
        <Bot expr={step === "waiting" ? "waiting" : "idle"} size={56} />
        {who && step === "choose" ? (
          <>
            <h1>You're signed in</h1>
            <p>{who}</p>
            <div className="grow" />
            <button className="btn primary full" autoFocus onClick={onDone}>Continue</button>
            <button className="link" onClick={onSignOut}>Use a different account</button>
          </>
        ) : step === "waiting" ? (
          <>
            <h1>Finish signing in in your browser</h1>
            <p>Then come back here.</p>
            <button className="link" onClick={google}>Open the browser again</button>
          </>
        ) : step === "choose" ? (
          <>
            <h1>Sign in to keep your help in one place</h1>
            <div className="grow" />
            {googleOn ? (
              <>
                <button className="btn full" autoFocus onClick={google}>
                  <GoogleG /> Continue with Google
                </button>
                <button className="link" onClick={() => setStep("email")}>Use my email instead</button>
              </>
            ) : (
              <button className="btn primary full" autoFocus onClick={() => setStep("email")}>Email me a sign-in code</button>
            )}
            <p className="small" style={{ margin: "8px 0 0" }}>We only see your name and email. Never your passwords or mail.</p>
          </>
        ) : step === "email" ? (
          <form className="stack" style={{ width: "100%", textAlign: "left" }} onSubmit={(e) => (e.preventDefault(), sendCode())}>
            <h1 style={{ textAlign: "center" }}>What's your email?</h1>
            <label className="small" htmlFor="em">Your email</label>
            <input id="em" className="field" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            {err && <p className="err">{err}</p>}
            <div style={{ height: 8 }} />
            <button className="btn primary full" disabled={busy || !email.includes("@")}>{busy ? "Sending…" : "Send me a code"}</button>
          </form>
        ) : (
          <form className="stack" style={{ width: "100%", textAlign: "left" }} onSubmit={(e) => (e.preventDefault(), verify())}>
            <h1 style={{ textAlign: "center" }}>Check your email</h1>
            <p className="small" style={{ textAlign: "center", margin: "0 auto 8px" }}>We sent a 6-digit code to {email}.</p>
            <label className="small" htmlFor="cd">The code</label>
            <input id="cd" className="field code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus value={code} onChange={(e) => {
              const v = e.target.value.replace(/\D/g, "");
              setCode(v);
              if (v.length === 6) verify(v);
            }} />
            {err && <p className="err">{err}</p>}
            <div style={{ height: 8 }} />
            <button className="btn primary full" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Sign in"}</button>
            <div className="row" style={{ justifyContent: "center" }}>
              {/@gmail\.com$/i.test(email) && <button type="button" className="link" onClick={() => openUrl("https://mail.google.com")}>Open Gmail</button>}
              <button type="button" className="link" onClick={sendCode}>Send a new code</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ---------- S4 free week (card first) ----------
function Trial({ progress, me, onDone, onBack }: { progress: React.ReactNode; me: Me | null; onDone: () => void; onBack: () => void }) {
  const [plan, setPlan] = useState<"yearly" | "monthly">("monthly");
  const [state, setState] = useState<"idle" | "opening" | "waiting" | "error">("idle");
  const used = me?.hadTrial;
  useEffect(() => {
    if (state !== "waiting") return;
    const iv = setInterval(async () => {
      const m = await api<Me>("/api/me").catch(() => null);
      if (m?.canUse) {
        clearInterval(iv);
        getCurrentWindow().show();
        track("trial_started", { plan });
        onDone();
      }
    }, 3000);
    return () => clearInterval(iv);
  }, [state]);
  useEffect(() => {
    autopilot().then((ap) => ap && setTimeout(start, 4000));
  }, []);
  async function start() {
    setState("opening");
    track("begin_checkout", { plan });
    try {
      const r = await api<{ url: string }>("/api/checkout", { plan, from: "app" });
      const url = r.url!.startsWith("/") ? (await server()) + r.url : r.url!;
      await openUrl(url);
      setState("waiting");
      // Don't sit on top of the card page: step aside, come back by itself when the free week starts.
      setTimeout(() => getCurrentWindow().hide(), 600);
      // CI only: the scripted person presses the test checkout's one button (staging's fake Stripe).
      if ((await autopilot()) && url.includes("/staging/checkout/")) setTimeout(() => fetch(`${url}/complete`, { method: "POST", redirect: "manual" }).catch((e) => apLog(`checkout complete failed ${e}`)), 5000);
    } catch (e) {
      apLog(`checkout failed ${e}`);
      setState("error");
    }
  }
  return (
    <div className="panel">
      <div className="drag" data-tauri-drag-region />
      {progress}
      <div className="body center">
        <Back onClick={state === "waiting" ? () => setState("idle") : onBack} />
        <h1>{used ? "Keep your help going" : "Free for 7 days"}</h1>
        <div className="stack" style={{ width: "100%", margin: "8px 0 16px" }} role="radiogroup" aria-label="Plan">
          <button role="radio" aria-checked={plan === "monthly"} className={`chip${plan === "monthly" ? " rec" : ""}`} onClick={() => setPlan("monthly")}>
            <span>Monthly · $20/month</span>
          </button>
          <button role="radio" aria-checked={plan === "yearly"} className={`chip${plan === "yearly" ? " rec" : ""}`} onClick={() => setPlan("yearly")}>
            <span>Yearly · $16/month<span className="small" style={{ display: "block" }}>Billed $192 a year</span></span>
            <span className="tag">Save $48</span>
          </button>
        </div>
        <ul className="small" style={{ textAlign: "left", margin: "0 0 16px", paddingLeft: 20, lineHeight: "24px", color: "var(--ink)" }}>
          <li>Help any time, by voice or typing</li>
          <li>It does the clicking for you</li>
          <li>Cancel in one click, any time</li>
        </ul>
        <div className="grow" />
        {state === "waiting" ? (
          <p>A page opened in your web browser to add your card. Come back here when it's done; I'll move on by myself.</p>
        ) : (
          <button className="btn primary full" autoFocus disabled={state === "opening"} onClick={start}>{used ? "Start my plan" : "Start my free week"}</button>
        )}
        {state === "error" && <p className="err">Checkout didn't open. Try again in a minute.</p>}
        <p className="small" style={{ margin: "10px 0 0" }}>
          {used ? `You'll pay ${plan === "yearly" ? "$192 today, then every year" : "$20 today, then every month"}.` : `You won't be charged today. We'll remind you 2 days before your trial ends. Then ${plan === "yearly" ? "$192 a year" : "$20 a month"}. Charges appear as Toolbay AI, the company behind Tech Support.`}
        </p>
      </div>
    </div>
  );
}

// ---------- setup: one question (no age question; "I get by" starts Gentle) ----------
const COMFORT: { c: "quick" | "gentle"; title: string; sub: string; rec?: boolean }[] = [
  { c: "quick", title: "Very comfortable", sub: "Keep it short. Just fix it." },
  { c: "gentle", title: "I get by", sub: "Explain as you go. Ask before changes.", rec: true },
  { c: "gentle", title: "Not very", sub: "Go slow, big words, one step at a time." },
];
function Comfort({ progress, onBack, onPick }: { progress: React.ReactNode; onBack: () => void; onPick: (c: "quick" | "gentle") => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    autopilot().then((ap) => ap && setTimeout(() => onPick(ap.startsWith("quick") ? "quick" : "gentle"), 3000));
  }, []);
  return (
    <div className="panel">
      <div className="drag" data-tauri-drag-region />
      {progress}
      <div className="body" style={{ overflowY: "auto" }}>
        <Back onClick={onBack} />
        <Bot expr="idle" size={56} />
        <h1 style={{ textAlign: "left" }}>How comfortable are you with tech?</h1>
        <p className="small" style={{ margin: "0 0 14px", maxWidth: "none" }}>So I talk the right way. You can change this any time.</p>
        <div className="stack" role="radiogroup" aria-label="How comfortable are you with tech?">
          {COMFORT.map((o) => (
            <button key={o.title} role="radio" aria-checked={false} disabled={busy} autoFocus={!!o.rec} className={`choice${o.rec ? " rec" : ""}`} onClick={() => (setBusy(true), onPick(o.c))}>
              <span className="t">{o.title}{o.rec && <span className="tag">Recommended</span>}</span>
              <span className="s">{o.sub}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- S28 settings (minimal) ----------
function Settings({ me, onBack, onChange, onComfort, onSignOut }: { me: Me; onBack: () => void; onChange: (m: Me) => void; onComfort: (c: "quick" | "gentle") => void; onSignOut: () => void }) {
  const set = async (patch: Partial<Me["settings"]>) => {
    const m = await api<Me>("/api/settings", patch).catch(() => null);
    if (m) {
      onChange(m);
      emitTo("overlay", "ov:settings", { textSize: m.settings.textSize });
    }
  };
  const seg = (label: string, k: keyof Me["settings"], opts: [any, string][]) => (
    <div className="stack" style={{ gap: 6 }}>
      <span className="small">{label}</span>
      <div className="row" role="radiogroup" aria-label={label}>
        {opts.map(([v, l]) => (
          <button key={String(v)} role="radio" aria-checked={me.settings[k] === v} className={`btn${me.settings[k] === v ? " primary" : ""}`} style={{ flex: 1, padding: 0 }} onClick={() => set({ [k]: v })}>{l}</button>
        ))}
      </div>
    </div>
  );
  return (
    <div className="panel">
      <div className="body" style={{ paddingTop: 18, gap: 14 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Settings</h2>
          <button className="link" onClick={onBack}>Done</button>
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <span className="small">How I talk</span>
          <div className="row" role="radiogroup" aria-label="How I talk">
            {(["quick", "gentle"] as const).map((c) => {
              const on = (me.settings.comfort || "gentle") === c;
              return <button key={c} role="radio" aria-checked={on} className={`btn${on ? " primary" : ""}`} style={{ flex: 1, padding: 0 }} onClick={() => onComfort(c)}>{c === "quick" ? "Quick" : "Gentle"}</button>;
            })}
          </div>
        </div>
        {seg("Talk out loud", "voice", [[false, "Off"], [true, "On"]])}
        {seg("Word size", "textSize", [[15, "Small"], [17, "Normal"], [20, "Big"]])}
        {seg("How fast I move", "moveSpeed", [["slow", "Slower"], ["normal", "Normal"]])}
        <button className="link" style={{ alignSelf: "flex-start", padding: "4px 0" }} onClick={() => (getCurrentWindow().hide(), emitTo("report", "report-open", {}))}>Report a problem with Tech Support</button>
        <div className="grow" />
        <span className="small">
          {me.email}
          {me.plan === "trialing" && me.trialEnds ? ` · Free until ${new Date(me.trialEnds).toLocaleDateString(undefined, { month: "long", day: "numeric" })}` : ""}
        </span>
        <div className="row">
          <button className="btn" style={{ flex: 1 }} onClick={async () => openUrl(`${await server()}/account`)}>My plan</button>
          <button className="btn" style={{ flex: 1 }} onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

// ---------- icons (our own line icons) ----------
const GearIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2" strokeLinecap="round" /><circle cx="12" cy="12" r="7" /></svg>
);
const PlusIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>
);
const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
);
const MicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" /></svg>
);
const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" /><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" /></svg>
);
