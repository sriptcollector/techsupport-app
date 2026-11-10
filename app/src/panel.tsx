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
import { apLog, api, ApiError, autopilot, capture, getEnv, hush, loadToken, overlayMode, placePanel, server, setToken, setUser, speak, track, type Me } from "./api";
import { Bars, Bot } from "./bot";
import { Mic, saidStop, saidThatsAll } from "./voice";

type View = "loading" | "welcome" | "signin" | "trial" | "perms" | "home" | "chat" | "pill" | "bug" | "settings";
type Line = { who: "bot" | "me"; text: string; pin?: number | null };
type Card =
  | { kind: "plan"; understood: string; steps: string[]; fix: boolean }
  | { kind: "ask"; question: string; options: string[] }
  | { kind: "done"; outcome: string; worked: boolean; steps: string[] }
  | { kind: "stopped" }
  | { kind: "problem"; title: string; body?: string; action?: { label: string; run: () => void } }
  | null;

const win = getCurrentWindow();
const SIZES: Partial<Record<View, [number, number]>> = { home: [380, 352], chat: [380, 540], bug: [380, 460], pill: [380, 64], settings: [380, 520] };
const SHOW_ME = `Switch to "Show me, I'll click": point with mouse_move and use needs_you; don't click.`;
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
    const size = SIZES[v];
    if (size) {
      await placePanel(size[0], size[1]);
    } else {
      await win.setSize(new LogicalSize(560, 640));
      await win.center();
    }
    await win.show();
    if (v !== "pill") await win.setFocus();
    // Big system text (or the person's own setting) can make the content larger than the window: grow to fit.
    requestAnimationFrame(async () => {
      const d = document.documentElement;
      const sx = d.scrollWidth / innerWidth, sy = d.scrollHeight / innerHeight;
      if (size && (sx > 1.01 || sy > 1.01)) await placePanel(Math.ceil(size[0] * Math.max(1, sx)), Math.ceil(size[1] * Math.max(1, sy)));
    });
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
    if (env.os === "mac") {
      const p = await invoke<{ screen: boolean; control: boolean }>("perms_status");
      if (!p.screen || !p.control) return show("perms");
    }
    if (firstRun.current || openAfter) {
      firstRun.current = false;
      return show("home");
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
      listen<{ app: string }>("ov:picked", (e) => say("bot", `Got it: ${e.payload.app}. Show me and tell me what's wrong.`)),
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
  function startHow(prefill?: string) {
    track("cta_click", { cta: "how" });
    if (!meRef.current?.canUse) return blocked();
    setLines([{ who: "bot", text: "What are you trying to do?" }]);
    setCard(null);
    setDraft("");
    session.current = null;
    show("chat");
    speak("What are you trying to do?", meRef.current?.settings);
    if (prefill) return heard(prefill);
    ensureMic(heard);
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
    if (!s) return begin("how", `They said: "${t}"`);
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
    plan: (understood: string, steps: string[]) =>
      new Promise<Pick | string>((resolve) => {
        say("bot", understood);
        setCard({ kind: "plan", understood, steps, fix: session.current?.mode === "fix" });
        speak(understood, meRef.current?.settings);
        waiter.current = (t: string) => {
          setCard(null);
          const l = t.toLowerCase();
          resolve(/show me|i'?ll click/.test(l) ? "show" : /steps|tell me/.test(l) ? "steps" : /^(yes|ok|okay|sure|do it|fix it|go)|for me/.test(l) ? "do" : t);
        };
        pickRef.current = (p: Pick) => {
          waiter.current = null;
          setCard(null);
          resolve(p);
        };
      }),
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
        show("pill");
      } else {
        unregister("Escape").catch(() => {});
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
      const [kind, ...rest] = ap.split(":");
      const words = rest.join(":");
      if (view === "welcome") once("welcome", 3500, () => (localStorage.setItem("ts_seen", "1"), setView("signin")));
      if (view === "home") once("start", 4000, () => (kind === "bug" ? startBug() : startHow(words)));
      if (view === "bug") once("bugwords", 7000, () => {
        emitTo("overlay", "ov:words", { text: words, at: Date.now() });
        setTimeout(() => emitTo("overlay", "ov:words", { text: "That's all.", at: Date.now() }), 2500);
        setTimeout(() => emitTo("overlay", "ov:finish-bug", {}), 4000);
      });
      if (card?.kind === "plan") once(`plan${lines.length}`, 3000, () => pickRef.current("do"));
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
  if (view === "signin") return <SignIn progress={progressBar(1)} onDone={() => (track("sign_up"), route(true))} />;
  if (view === "trial") return <Trial progress={progressBar(2)} me={me} onDone={() => route(true)} />;
  if (view === "perms") return <Perms progress={progressBar(3)} onDone={() => show("home")} />;
  if (view === "settings") return <Settings me={me!} onBack={() => show("home")} onChange={setMe} onSignOut={async () => (await setToken(null), setMe(null), show("signin"))} />;

  if (view === "home")
    return (
      <div className="panel">
        <div className="body" style={{ paddingTop: 18, gap: 10 }}>
          <div className="row" style={{ gap: 12, marginBottom: 6 }}>
            <Bot expr="idle" size={32} />
            <h2>What do you need?</h2>
          </div>
          <button className="big primary" autoFocus onClick={() => startHow()}>
            <ChatIcon />
            I don't know how to do something
          </button>
          <button className="big" onClick={startBug}>
            <WrenchIcon />
            Something is broken
          </button>
          <hr style={{ border: 0, borderTop: "1px solid var(--hair)", margin: "6px 0", width: "100%" }} />
          <button className="big" onClick={() => (win.hide(), emitTo("report", "report-open", {}))}>
            <span>
              Report a bug
              <span className="sub">Tell us what's wrong with Tech Support</span>
            </span>
          </button>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="small">{me?.plan === "trialing" && me.trialEnds ? `Free until ${new Date(me.trialEnds).toLocaleDateString(undefined, { month: "long", day: "numeric" })}` : ""}</span>
            <button className="link" style={{ fontSize: 14 }} onClick={() => show("settings")}>Settings</button>
          </div>
        </div>
      </div>
    );

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

  // chat and bug views
  const plan = card?.kind === "plan" ? card : null;
  return (
    <div className="panel">
      <div className="drag row" data-tauri-drag-region style={{ justifyContent: "flex-end", padding: "4px 8px 0" }}>
        <button className="link" style={{ fontSize: 14, padding: 4 }} onClick={() => (micOff(), hush(), session.current?.end(), overlayMode(false), emitTo("overlay", "ov:mode", { mode: "off" }), show("home"))}>Close</button>
      </div>
      <div className="body" style={{ paddingTop: 0 }}>
        <div className="chat" aria-live="polite">
          {lines.map((l, i) => (
            <div key={i} className={`msg ${l.who === "bot" ? "helper" : "me"}`}>
              {l.pin ? <span className="pin">{l.pin}</span> : null}
              {l.text}
            </div>
          ))}
          {view === "chat" && lines.length === 1 && !session.current && (
            <div className="chips" aria-label="Try one of these">
              {SUGGEST.map((s, i) => (
                <button key={s} className={`chip${i === 0 ? " rec" : ""}`} onClick={() => (micOff(), heard(s))}>
                  {s}
                  {i === 0 && <span className="tag">Recommended</span>}
                </button>
              ))}
            </div>
          )}
          {thinking && !card && <div className="msg helper small">Looking at your screen…</div>}
          {plan && (
            <div className="plan">
              <ol>{plan.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
              <div className="chips" style={{ marginTop: 12 }}>
                <button className="chip rec" autoFocus onClick={() => pickRef.current("do")}>{plan.fix ? "Fix it for me" : "Do it for me"}<span className="tag">Recommended</span></button>
                <button className="chip" onClick={() => pickRef.current("show")}>{plan.fix ? "Show me how" : "Show me, I'll click"}</button>
                <button className="chip" onClick={() => pickRef.current("steps")}>{plan.fix ? "Tell me what's wrong" : "Just tell me the steps"}</button>
              </div>
              <p className="small" style={{ margin: "10px 0 0" }}>Nothing happens until you choose. Press Stop or move your mouse and I stop at once. I never touch passwords or bank pages.</p>
              {plan.steps.length <= 10 && <p className="small" style={{ margin: "6px 0 0" }}>{plan.steps.length * 13 < 50 ? `About ${Math.ceil((plan.steps.length * 13) / 10) * 10} seconds.` : plan.steps.length * 13 < 90 ? "About a minute." : `About ${Math.round((plan.steps.length * 13) / 60)} minutes.`}</p>}
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
              {!card.worked ? (
                <div className="chips" style={{ marginTop: 12 }}>
                  <button className="chip rec" autoFocus onClick={() => (setCard(null), session.current?.more("Try again a different way. Take a screenshot first."))}>Try again<span className="tag">Recommended</span></button>
                  <button className="chip" onClick={() => (setCard(null), session.current?.more(SHOW_ME))}>Show me, I'll click</button>
                  <button className="chip" onClick={() => (setCard(null), overlayMode(false), show("home"))}>I'm done</button>
                </div>
              ) : (
              <div className="chips" style={{ marginTop: 12 }}>
                <button className="chip rec" autoFocus onClick={() => (track("fix_confirmed", { yes: true }), say("bot", "Glad I could help."), speak("Glad I could help.", me?.settings), setCard(null), setTimeout(() => win.hide(), 2000))}>Yes, all good<span className="tag">Recommended</span></button>
                <button className="chip" onClick={() => (setCard(null), track("fix_confirmed", { yes: false }), say("bot", "What's still wrong?"), ensureMic(heard))}>No, still wrong</button>
                <button className="chip" onClick={() => (setCard(null), say("me", "Undo that"), session.current?.more("Please undo everything you changed in this session, in reverse order, saying each step. Then call done."))}>Undo that</button>
              </div>
              )}
            </div>
          )}
          {card?.kind === "stopped" && (
            <div className="plan">
              <h2>Stopped. Nothing else will happen.</h2>
              <div className="chips" style={{ marginTop: 12 }}>
                <button className="chip rec" autoFocus onClick={() => (setCard(null), overlayMode(false), session.current?.more("Keep going from where things are now. Take a screenshot first."))}>Keep going<span className="tag">Recommended</span></button>
                <button className="chip" onClick={() => (setCard(null), session.current?.more("Please undo what you changed, in reverse order. Then call done."))}>Undo what you did</button>
                <button className="chip" onClick={() => (setCard(null), overlayMode(false), session.current?.end(), show("home"))}>I'm done</button>
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
        <div className="listening" aria-live="polite">
          {micOn ? <><Bars level={level} />{hearing ? "Listening…" : view === "bug" ? 'Say "that\'s all" when you\'re done' : "Listening…"}</> : <span>{view === "bug" ? "" : "The mic is off."}</span>}
        </div>
        <form className="composer" onSubmit={(e) => (e.preventDefault(), send())}>
          <input value={draft} onChange={(e) => onType(e.target.value)} placeholder="Or type here" aria-label="Type what you need" />
          <button type="button" className={`mic${micOn ? " on" : ""}`} aria-pressed={micOn} aria-label={micOn ? "Turn the mic off" : "Turn the mic on"} onClick={() => (micOn ? micOff() : ensureMic(view === "bug" ? (t) => emitTo("overlay", "ov:words", { text: t, at: Date.now() }) : heard))}>
            <MicIcon />
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------- S3 sign in ----------
function SignIn({ progress, onDone }: { progress: React.ReactNode; onDone: () => void }) {
  const [step, setStep] = useState<"choose" | "email" | "code" | "waiting">("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
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
        <Bot expr={step === "waiting" ? "waiting" : "idle"} size={56} />
        {step === "waiting" ? (
          <>
            <h1>Finish signing in in your browser</h1>
            <p>Then come back here.</p>
            <button className="link" onClick={google}>Open the browser again</button>
          </>
        ) : step === "choose" ? (
          <>
            <h1>Sign in to keep your help in one place</h1>
            <div className="grow" />
            <button className="btn full" autoFocus onClick={google}>
              <GoogleG /> Continue with Google
            </button>
            <button className="link" onClick={() => setStep("email")}>Use my email instead</button>
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
            <button type="button" className="link" onClick={() => setStep("choose")}>Back</button>
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
function Trial({ progress, me, onDone }: { progress: React.ReactNode; me: Me | null; onDone: () => void }) {
  const [plan, setPlan] = useState<"yearly" | "monthly">("yearly");
  const [state, setState] = useState<"idle" | "opening" | "waiting" | "soon" | "error">("idle");
  const used = me?.hadTrial;
  useEffect(() => {
    if (state !== "waiting") return;
    const iv = setInterval(async () => {
      const m = await api<Me>("/api/me").catch(() => null);
      if (m?.canUse) {
        clearInterval(iv);
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
      const r = await api<{ url?: string; soon?: boolean }>("/api/checkout", { plan, from: "app" });
      if (r.soon) return setState("soon");
      const url = r.url!.startsWith("/") ? (await server()) + r.url : r.url!;
      await openUrl(url);
      setState("waiting");
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
        <h1>{used ? "Keep your help going" : "Free for 7 days"}</h1>
        <div className="stack" style={{ width: "100%", margin: "8px 0 16px" }} role="radiogroup" aria-label="Plan">
          <button role="radio" aria-checked={plan === "yearly"} className={`chip${plan === "yearly" ? " rec" : ""}`} onClick={() => setPlan("yearly")}>
            <span>Yearly · $16/month<span className="small" style={{ display: "block" }}>Billed $192 a year</span></span>
            <span className="tag">Save $48</span>
          </button>
          <button role="radio" aria-checked={plan === "monthly"} className={`chip${plan === "monthly" ? " rec" : ""}`} onClick={() => setPlan("monthly")}>
            <span>Monthly · $20/month</span>
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
        ) : state === "soon" ? (
          <p>The free week opens very soon. We'll email you the moment it does.</p>
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

// ---------- S6 the one permission step (Mac) ----------
function Perms({ progress, onDone }: { progress: React.ReactNode; onDone: () => void }) {
  const [p, setP] = useState({ mic: false, screen: false, control: false });
  const [going, setGoing] = useState(false);
  useEffect(() => {
    const iv = setInterval(async () => {
      const s = await invoke<{ screen: boolean; control: boolean }>("perms_status");
      setP((x) => ({ ...x, ...s }));
    }, 500);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    if (!(p.mic && p.screen && p.control)) return;
    // Newer Macs ask once more ("bypass the private window picker"): ask it here, not mid-help.
    capture(undefined, 320).catch(() => {}).finally(() => setTimeout(onDone, 900));
  }, [p]);
  async function turnOn() {
    setGoing(true);
    if (!p.mic) {
      const ok = await navigator.mediaDevices?.getUserMedia({ audio: true }).then((s) => (s.getTracks().forEach((t) => t.stop()), true)).catch(() => false);
      setP((x) => ({ ...x, mic: !!ok }));
    }
    const s = await invoke<{ screen: boolean; control: boolean }>("perms_status");
    if (!s.control) await invoke("perms_open", { which: "control" });
    else if (!s.screen) await invoke("perms_open", { which: "screen" });
  }
  useEffect(() => {
    // After Accessibility is on, go straight to the screen switch.
    if (going && p.control && !p.screen) invoke("perms_open", { which: "screen" });
  }, [p.control]);
  const row = (on: boolean, name: string, os: string) => (
    <div className="row" style={{ padding: "12px 0", borderBottom: "1px solid var(--hair)", width: "100%", textAlign: "left" }}>
      <span style={{ flex: 1 }}>
        {name}
        <span className="small" style={{ display: "block" }}>{os}</span>
      </span>
      <span className="small" style={{ color: on ? "var(--ok)" : "var(--ink-2)", fontWeight: 500 }}>{on ? "✓ On" : "Not on yet"}</span>
    </div>
  );
  const all = p.mic && p.screen && p.control;
  return (
    <div className="panel">
      <div className="drag" data-tauri-drag-region />
      {progress}
      <div className="body center">
        <h1>{all ? "All set. That was the hard part." : "Let Tech Support see, hear and help"}</h1>
        <div style={{ width: "100%", margin: "8px 0 16px" }}>
          {row(p.mic, "Hear you", "Microphone")}
          {row(p.screen, "See your screen", "Screen & System Audio Recording")}
          {row(p.control, "Click and type for you", "Accessibility")}
        </div>
        <div className="grow" />
        {going && !all ? <p>In the window that opened, flip the switch next to Tech Support.</p> : all ? <p>If your Mac asks once more, press Allow.</p> : null}
        <button className="btn primary full" autoFocus disabled={all} onClick={turnOn}>{going ? "Try again" : "Turn on"}</button>
        <p className="small" style={{ margin: "10px 0 0" }}>You'll press Allow once and flip 2 switches. I'll point to them.</p>
        <button className="link" style={{ fontSize: 14 }} onClick={onDone}>Skip for now</button>
      </div>
    </div>
  );
}

// ---------- S28 settings (minimal) ----------
function Settings({ me, onBack, onChange, onSignOut }: { me: Me; onBack: () => void; onChange: (m: Me) => void; onSignOut: () => void }) {
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
        {seg("Talk out loud", "voice", [[true, "On"], [false, "Off"]])}
        {seg("How fast I talk", "speech", [["slow", "Slower"], ["normal", "Normal"], ["fast", "Faster"]])}
        {seg("Word size", "textSize", [[15, "Small"], [17, "Normal"], [20, "Big"]])}
        {seg("How fast I move", "moveSpeed", [["slow", "Slower"], ["normal", "Normal"]])}
        <div className="grow" />
        <span className="small">{me.email}</span>
        <div className="row">
          <button className="btn" style={{ flex: 1 }} onClick={async () => openUrl(`${await server()}/account`)}>My plan</button>
          <button className="btn" style={{ flex: 1 }} onClick={onSignOut}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

// ---------- icons (our own line icons) ----------
const ChatIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z" strokeLinejoin="round" /><path d="M9.5 9.2a2.5 2.5 0 1 1 3.3 2.4c-.5.2-.8.6-.8 1.1v.3" strokeLinecap="round" /><circle cx="12" cy="14.6" r=".6" fill="currentColor" /></svg>
);
const WrenchIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M14.5 4.5a4 4 0 0 0-4.9 5.2L4 15.3 6.7 18l5.6-5.6a4 4 0 0 0 5.2-4.9l-2.4 2.4-2.3-.5-.5-2.3z" strokeLinejoin="round" /></svg>
);
const MicIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" /></svg>
);
const GoogleG = () => (
  <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" /><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" /></svg>
);
