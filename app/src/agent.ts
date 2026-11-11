// The help session loop. The server's AI decides the next step; this file shows it (the character
// flies there and says it), does it, looks again, and repeats. It stops the instant the person moves
// the mouse, presses Esc, says "stop", or presses Stop.
import { emitTo } from "@tauri-apps/api/event";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { invoke } from "@tauri-apps/api/core";
import { act, apLog, api, autopilot, ApiError, capture, cursor, getEnv, hush, speak, track, type Me, type Shot } from "./api";
import type { Expr } from "./bot";

export type Pick = "do" | "show" | "steps";
export type UI = {
  settings: () => Me["settings"];
  plan: (understood: string, steps: string[]) => Promise<Pick | string>; // a pick, or new words from the person
  ask: (question: string, options: string[]) => Promise<string>;
  bot: (text: string) => void; // a line in the chat panel
  avoid: (x: number, y: number) => Promise<void>; // move the Step pill off the spot about to be pressed
  progress: (n: number, total: number, task: string) => void;
  walking: (on: boolean) => void;
  needsYou: (text: string) => void;
  done: (outcome: string, worked: boolean, steps: string[]) => void;
  problem: (kind: "offline" | "busy" | "cap" | "month_used" | "trial_used" | "no_plan" | "stopped") => void;
};

const RISKY = /\b(delet|trash|empty the|erase all|erase (your|the)|factory reset|reset (your|the) (mac|pc|computer|phone|password)|pay\b|paying|payment|purchas|buy|checkout|send|post\b|posting|reply|share|password|passcode|install|uninstall|update now|software update|sign(ing)? out|log(ging)? out|accept|agree to|subscribe)/i;
const ov = (name: string, payload: unknown = {}) => emitTo("overlay", name, payload);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i += 97) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
};

export class Session {
  id = crypto.randomUUID();
  messages: any[] = [];
  aborted = false;
  task = "";
  total = 0;
  n = 0;
  shot: Shot | null = null;
  pick: Pick = "do";
  /** Undo journal: every change in order, so "Undo that" can reverse exactly what happened, even later. */
  journal: { at: number; step: number; said?: string; did?: string }[] = [];
  private note(entry: { said?: string; did?: string }) {
    this.journal.push({ at: Date.now(), step: this.n, ...entry });
    try {
      localStorage.setItem("ts_last_journal", JSON.stringify({ task: this.task, os: navigator.platform, entries: this.journal.slice(-80) }));
    } catch {}
  }
  journalText() {
    return this.journal.map((j, i) => `${i + 1}. ${j.said ? `Said: "${j.said}"` : `Did: ${j.did}`}`).join(String.fromCharCode(10));
  }
  undoPrompt() {
    return `Undo everything you changed in this help, in reverse order, saying each step. Here is exactly what happened:
${this.journalText()}
Only reverse real changes (settings, text, files). Then call done.`;
  }
  private expected: [number, number] | null = null;
  private watching = 0;
  private busy = false;
  /** True while a Yes card, a question or a "your turn" step is up: the person is meant to use the mouse. */
  private waitingOnPerson = false;
  private needConfirm = false;
  private confirmed = false;
  private failures = 0;
  private escalate = false;
  private stopWaiters: (() => void)[] = [];

  constructor(public mode: "how" | "fix", private ui: UI) {}

  stop(why = "stopped") {
    if (this.aborted) return;
    this.aborted = true;
    hush();
    act({ do: "up" }).catch(() => {});
    clearInterval(this.watching);
    ov("ov:expr", { expr: "stopped" });
    ov("ov:say", { text: null });
    ov("ov:confirm", null);
    ov("ov:point", null);
    this.stopWaiters.forEach((f) => f());
    track("help_stopped", { why, session: this.id, step: this.n });
    this.ui.problem("stopped");
  }

  /** Maps a point in the AI's picture to a point on the screen. */
  private toScreen(c: [number, number]): [number, number] {
    const s = this.shot!;
    return [(c[0] * s.sw) / s.w, (c[1] * s.sh) / s.h];
  }

  private watch() {
    // A real mouse move by the person (more than 6 points from where we left it) stops everything.
    clearInterval(this.watching);
    this.watching = window.setInterval(async () => {
      if (this.busy || !this.expected || this.aborted) return;
      const c = await cursor().catch(() => null);
      if (c && !this.waitingOnPerson && Math.hypot(c[0] - this.expected[0], c[1] - this.expected[1]) > 40) this.stop("mouse");
    }, 120);
  }

  private t0 = 0;
  private firstAction = false;
  private mark(what: string) {
    apLog(`timing ${what} ${Date.now() - this.t0}ms`);
    track("help_timing", { session: this.id, what, ms: Date.now() - this.t0 });
  }

  async start(firstText: string, extra: any[] = []) {
    this.t0 = Date.now();
    const env = await getEnv();
    // Something visible right away (well under a second): the helper appears and says it's on it.
    this.ui.walking(true);
    ov("ov:mode", { mode: "walk" });
    ov("ov:expr", { expr: "thinking" });
    cursor().then((c) => c && ov("ov:fly", { x: c[0], y: c[1], ms: 1 }));
    ov("ov:say", { text: "On it. Looking at your screen.", spoken: 99 });
    this.mark("first_visible");
    this.shot = await capture();
    ov("ov:screen", { sw: this.shot.sw, sh: this.shot.sh });
    this.messages.push({ role: "user", content: [{ type: "text", text: firstText }, ...extra, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: this.shot.data } }] });
    this.task = firstText.slice(0, 60);
    if (/show me (how|where)|let me (click|do it)|do it myself|want to learn how/i.test(firstText)) this.pick = "show";
    track("help_started", { mode: this.mode, os: env.os });
    await this.loop();
  }

  /** "Let me do it myself": from the next step on, the helper points and the person clicks. */
  private wantShow = false;
  showMe() {
    this.wantShow = true;
    this.pick = "show";
  }

  /** The person said or typed something more (an answer, or "No, still wrong"). */
  async more(text: string) {
    this.aborted = false;
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    await this.loop();
  }

  private async call() {
    const env = await getEnv();
    for (let tries = 0; tries < 3; tries++) {
      try {
        return await api<{ content: any[]; stop_reason: string }>("/api/agent", { session: this.id, mode: this.mode, messages: this.messages, escalate: this.escalate, os: env.os, screen: this.shot ? { w: this.shot.w, h: this.shot.h } : undefined });
      } catch (e) {
        const err = e as ApiError;
        if (err.status === 402) return this.ui.problem(err.code as any), null;
        if (err.status === 429 && err.code === "session_cap") return this.ui.problem("cap"), null;
        if (tries === 2) return this.ui.problem(err.status === 0 ? "offline" : "busy"), null;
        await sleep(1500 * (tries + 1));
      }
    }
    return null;
  }

  private async loop() {
    for (let turn = 0; turn < 120 && !this.aborted; turn++) {
      ov("ov:expr", { expr: "thinking" });
      const r = await this.call();
      if (!r || this.aborted) return;
      this.messages.push({ role: "assistant", content: r.content });
      const uses = r.content.filter((b) => b.type === "tool_use");
      for (const b of r.content) if (b.type === "text" && b.text.trim()) this.ui.bot(b.text.trim());
      if (!uses.length) {
        ov("ov:expr", { expr: "idle" });
        return; // the AI is waiting for the person to say something
      }
      const results: any[] = [];
      let finished = false;
      for (const u of uses) {
        const isComputer = u.toolset_name === "computer";
        const base = { type: "tool_result", tool_use_id: u.id, ...(isComputer ? { toolset_name: "computer" } : {}) };
        if (this.aborted) {
          results.push({ ...base, is_error: true, content: "Not executed: the person pressed Stop." });
          continue;
        }
        apLog(`tool ${u.name} ${JSON.stringify(u.input ?? {}).slice(0, 160)}`);
        const tStep = Date.now();
        try {
          const out = isComputer ? await this.computer(u.name, u.input ?? {}) : await this.tool(u.name, u.input ?? {});
          track("help_step", { session: this.id, tool: u.name, ok: true, ms: Date.now() - tStep });
          if (out === "__done__") {
            finished = true;
            results.push({ ...base, content: "OK" });
          } else results.push({ ...base, content: out });
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          this.failures++;
          if (this.failures >= 2) this.escalate = true; // two misses: a stronger model takes the next steps
          apLog(`tool error ${u.name}: ${msg.slice(0, 160)}`);
          track("help_step", { session: this.id, tool: u.name, ok: false, ms: Date.now() - tStep, error: msg.slice(0, 120) });
          results.push({ ...base, is_error: true, content: isComputer ? `Error: ${msg}` : msg });
          if (isComputer) {
            // Later actions in the same batch don't run once one fails.
            for (const rest of uses.slice(uses.indexOf(u) + 1)) results.push({ type: "tool_result", tool_use_id: rest.id, ...(rest.toolset_name === "computer" ? { toolset_name: "computer" } : {}), is_error: true, content: "Not executed: an earlier computer action in this turn failed." });
            break;
          }
        }
      }
      if (this.wantShow) {
        this.wantShow = false;
        results.push({ type: "text", text: "They'd like to do it themselves now. From here on don't click or type: point with mouse_move and use needs_you for each step." });
      }
      this.messages.push({ role: "user", content: results });
      if (finished || this.aborted) return;
    }
  }

  // ---------- the AI's own tools ----------
  private async tool(name: string, i: any): Promise<any> {
    const s = this.ui.settings();
    switch (name) {
      case "plan": {
        this.total = i.steps?.length ?? 0;
        this.task = i.task || i.understood || this.task;
        ov("ov:expr", { expr: "idle" });
        const pick = await this.ui.plan(i.understood, i.steps ?? []);
        if (pick === "do" || pick === "show" || pick === "steps") {
          if (this.pick !== "show") this.pick = pick;
          track("plan_picked", { pick });
          if (pick !== "steps") this.beginWalk();
          return pick === "do" ? "The plan is on their screen. Carry on with the first step now." : pick === "show" ? 'They picked "Show me, I\'ll click". Point with mouse_move and needs_you; don\'t click.' : 'They picked "Just tell me the steps". Call done with the steps; don\'t touch anything.';
        }
        return `They didn't pick yet. They said: "${pick}"`;
      }
      case "say": {
        if (RISKY.test(i.text) && !this.confirmed) this.needConfirm = true;
        this.n = Math.max(this.n, Math.min(this.total || 99, Number(i.step) || this.n || 1));
        this.ui.progress(this.n, Math.max(this.total, this.n), this.task);
        ov("ov:expr", { expr: (i.expression as Expr) ?? "focused" });
        ov("ov:say", { text: i.text, spoken: 999 });
        this.note({ said: i.text });
        // Spoken only if they turned "Talk out loud" on; either way the next action starts right away.
        if (s.voice) speak(i.text, s);
        await sleep(250);
        return "OK";
      }
      case "ask": {
        ov("ov:expr", { expr: "waiting" });
        this.waitingOnPerson = true;
        const a = await this.ui.ask(i.question, i.options ?? []);
        this.expected = await cursor().catch(() => this.expected);
        this.waitingOnPerson = false;
        return `They answered: "${a}"`;
      }
      case "confirm": {
        const [x, y] = this.expected ?? [innerWidth / 2, innerHeight / 2];
        ov("ov:expr", { expr: "careful" });
        hush();
        speak(i.title, s);
        this.waitingOnPerson = true;
        const yes = await new Promise<boolean>((resolve) => {
          import("@tauri-apps/api/event").then(({ once }) => once<{ yes: boolean }>("ov:answer", (e) => resolve(e.payload.yes)));
          this.stopWaiters.push(() => resolve(false));
          ov("ov:confirm", { x, y, title: i.title, detail: i.detail ?? "", undoable: !!i.undoable });
          this.ui.walking(false);
        });
        ov("ov:confirm", null);
        this.ui.walking(true);
        this.expected = await cursor().catch(() => this.expected);
        this.waitingOnPerson = false;
        this.needConfirm = false;
        this.confirmed = yes;
        track("risky_answer", { yes });
        return yes ? "They pressed Yes. Do it now." : "They said no. Don't do it. Skip it and finish what's left, or call done.";
      }
      case "needs_you": {
        ov("ov:expr", { expr: "waiting" });
        const [x, y] = this.expected ?? [innerWidth / 2, innerHeight / 2];
        ov("ov:point", { x, y });
        ov("ov:say", { text: i.text, spoken: 999 });
        speak(i.text, s);
        this.ui.needsYou(i.text);
        clearInterval(this.watching); // the person is meant to use the mouse now
        const before = hash((await capture(undefined, 320)).data);
        // CI only: the scripted person does what the helper points at.
        if (this.pick === "show" && (await autopilot()) && this.expected) {
          const [px, py] = this.expected;
          setTimeout(() => act({ do: "click", x: px, y: py }).catch(() => {}), 2500);
        }
        await new Promise<void>((resolve) => {
          const iv = setInterval(async () => {
            if (this.aborted) return clearInterval(iv), resolve();
            const now = hash((await capture(undefined, 320)).data);
            if (now !== before) {
              clearInterval(iv);
              setTimeout(resolve, 900); // let the screen settle
            }
          }, 700);
          this.stopWaiters.push(() => (clearInterval(iv), resolve()));
        });
        ov("ov:point", null);
        if (this.aborted) return "They stopped.";
        ov("ov:say", { text: this.pick === "show" ? "Good." : "Thanks. Back to me.", spoken: 999 });
        this.expected = await cursor().catch(() => null);
        this.watch();
        return "They did it. Take a screenshot to see what changed.";
      }
      case "quick": {
        this.noteAction("quick");
        this.note({ did: `quick ${i.action} ${i.arg ?? ""}` });
        ov("ov:expr", { expr: "focused" });
        const out = await invoke<string>("quick", { action: i.action, arg: i.arg || null });
        return `Done: ${String(out).slice(0, 1200)}`;
      }
      case "done": {
        this.end();
        ov("ov:expr", { expr: i.worked ? "happy" : "sorry" });
        ov("ov:say", { text: null });
        this.ui.done(i.outcome, !!i.worked, i.how_next_time ?? []);
        track(i.worked ? "activation_completed" : "help_unfinished", { mode: this.mode, pick: this.pick });
        return "__done__";
      }
    }
    throw new Error(`unknown tool ${name}`);
  }

  private beginWalk() {
    this.ui.walking(true);
    ov("ov:mode", { mode: "walk" });
    this.expected = null;
    cursor().then((c) => {
      this.expected = c;
      if (c) ov("ov:fly", { x: c[0], y: c[1], ms: 1 });
      this.watch();
    });
  }
  end() {
    clearInterval(this.watching);
    this.ui.walking(false);
  }

  // ---------- computer actions ----------
  private flightMs(to: [number, number]) {
    const from = this.expected ?? to;
    const ms = Math.min(700, Math.max(250, Math.hypot(to[0] - from[0], to[1] - from[1]) / 1.2));
    return this.ui.settings().moveSpeed === "slow" ? ms * 1.6 : ms;
  }
  private async moveTo(c: [number, number]) {
    const p = this.toScreen(c);
    const ms = this.flightMs(p);
    ov("ov:expr", { expr: "focused" });
    await this.ui.avoid(p[0], p[1]);
    ov("ov:fly", { x: p[0], y: p[1], ms });
    await sleep(ms);
    return p;
  }
  private async doing<T>(f: () => Promise<T>, p: [number, number] | null) {
    this.busy = true;
    try {
      return await f();
    } finally {
      if (p) this.expected = p;
      else this.expected = await cursor().catch(() => this.expected);
      setTimeout(() => (this.busy = false), 60);
    }
  }

  /** Our own windows must never receive the helper's typing. */
  private async releaseKeyboard() {
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    for (const w of await getAllWebviewWindows()) {
      if (await w.isFocused().catch(() => false)) {
        apLog(`released keyboard from ${w.label}`);
        track("help_step", { tool: "release_keyboard", from: w.label });
        await invoke("walk_focus", { walking: true });
        await sleep(200);
        break;
      }
    }
  }

  private noteAction(name: string) {
    if (!this.firstAction && !/screenshot|zoom|wait|cursor_position/.test(name)) {
      this.firstAction = true;
      this.mark(`first_action ${name}`);
    }
  }

  private async computer(name: string, i: any): Promise<any> {
    this.noteAction(name);
    if (!/screenshot|zoom|wait|cursor_position|mouse_move/.test(name)) this.note({ did: `${name} ${JSON.stringify(i)}` });
    if (this.pick !== "do" && /click|drag|type|key|scroll|mouse_down|mouse_up/.test(name)) throw new Error("In this mode don't click or type. Use mouse_move and needs_you.");
    if (this.needConfirm && /click|key|type/.test(name)) {
      this.needConfirm = false;
      throw new Error("That looks risky. Call confirm first and wait for Yes.");
    }
    if (/click|key|type/.test(name)) this.confirmed = false;
    switch (name) {
      case "screenshot": {
        this.shot = await capture();
        return [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: this.shot.data } }];
      }
      case "zoom": {
        const [x0, y0, x1, y1] = i.region as number[];
        const a = this.toScreen([x0, y0]);
        const b = this.toScreen([x1, y1]);
        const z = await capture([a[0], a[1], b[0] - a[0], b[1] - a[1]], 1024);
        return [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: z.data } }];
      }
      case "mouse_move": {
        const p = await this.moveTo(i.coordinate);
        await this.doing(() => act({ do: "move", x: p[0], y: p[1] }), p);
        return "OK";
      }
      case "left_click":
      case "right_click":
      case "middle_click":
      case "double_click":
      case "triple_click": {
        let p = this.expected ?? [0, 0];
        if (i.coordinate) p = await this.moveTo(i.coordinate);
        await sleep(150); // the eye catches up before the press
        ov("ov:expr", { expr: "pressing" });
        ov("ov:press", { x: p[0], y: p[1] });
        const count = name === "double_click" ? 2 : name === "triple_click" ? 3 : 1;
        await this.doing(() => act({ do: "click", x: p[0], y: p[1], button: name === "right_click" ? "right" : name === "middle_click" ? "middle" : "left", count, modifiers: i.text ?? null }), p);
        ov("ov:expr", { expr: "focused" });
        await sleep(350); // let the screen settle
        return "OK";
      }
      case "left_click_drag": {
        const a = this.toScreen(i.start_coordinate);
        await this.moveTo(i.start_coordinate);
        const b = this.toScreen(i.coordinate);
        ov("ov:fly", { x: b[0], y: b[1], ms: 500 });
        await this.doing(() => act({ do: "drag", from: a, to: b }), b);
        await sleep(400);
        return "OK";
      }
      case "left_mouse_down":
        await this.doing(() => act({ do: "down" }), null);
        return "OK";
      case "left_mouse_up":
        await this.doing(() => act({ do: "up" }), null);
        return "OK";
      case "scroll": {
        const p = i.coordinate ? await this.moveTo(i.coordinate) : null;
        await this.doing(() => act({ do: "scroll", x: p?.[0] ?? null, y: p?.[1] ?? null, direction: i.scroll_direction, amount: i.scroll_amount ?? 3 }), p);
        await sleep(400);
        return "OK";
      }
      case "type": {
        await this.releaseKeyboard();
        ov("ov:expr", { expr: "focused" });
        if (this.expected) ov("ov:fly", { x: this.expected[0], y: this.expected[1], ms: 200 });
        try {
          await this.doing(() => act({ do: "type", text: String(i.text ?? "") }), null);
        } catch (e) {
          throw new Error(/card|ssn|code/.test(String(e)) ? "I won't type that. The person types passwords, codes and card numbers themselves: use needs_you." : String(e));
        }
        await sleep(300);
        return "OK";
      }
      case "key": {
        await this.releaseKeyboard();
        // Our own Esc must not trip the "Esc stops everything" shortcut.
        const esc = /esc/i.test(String(i.text ?? ""));
        if (esc) await unregister("Escape").catch(() => {});
        await this.doing(() => act({ do: "key", combo: String(i.text ?? ""), repeat: i.repeat ?? 1 }), null);
        if (esc && !this.aborted) await register("Escape", () => this.stop("esc")).catch(() => {});
        await sleep(300);
        return "OK";
      }
      case "wait":
        await sleep(Math.min(10, Number(i.duration ?? 1)) * 1000);
        return "OK";
      case "cursor_position": {
        const c = await cursor();
        const s = this.shot!;
        return c ? `X=${Math.round((c[0] * s.w) / s.sw)}, Y=${Math.round((c[1] * s.h) / s.sh)}` : "unknown";
      }
      case "hold_key":
        throw new Error("hold_key isn't available here. Use key instead.");
    }
    throw new Error(`unknown action ${name}`);
  }
}
