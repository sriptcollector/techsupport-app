// Talking to the server and to the native side. One place for the session token.
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

listen<boolean>("veil", (e) => (document.documentElement.style.visibility = e.payload ? "hidden" : ""));

declare const __SERVER__: string;
export type Env = { os: "mac" | "windows"; version: string; server: string | null; test_session: string | null; show_in_capture: boolean; autopilot: string | null };
export type Me = {
  email: string;
  name: string | null;
  plan: "none" | "trialing" | "active" | "past_due" | "canceled";
  trialEnds: number | null;
  hadTrial: boolean;
  payer: string | null;
  canUse: boolean;
  why: "no_plan" | "trial_used" | "month_used" | null;
  usage: { sessions: number; limit: number };
  settings: { speech: "slow" | "normal" | "fast"; voice: boolean; textSize: number; moveSpeed: "slow" | "normal"; talkLess: boolean };
  test: boolean;
};

let env: Env | null = null;
let token: string | null = null;
export async function getEnv() {
  if (!env) env = await invoke<Env>("env_info");
  return env;
}
export async function server() {
  return (await getEnv()).server ?? __SERVER__;
}
export async function loadToken() {
  const e = await getEnv();
  token = e.test_session ?? (await invoke<string | null>("session_get"));
  return token;
}
export async function setToken(t: string | null) {
  token = t;
  await invoke("session_set", { token: t });
}

export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}
export async function api<T = any>(path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const base = await server();
  const headers: Record<string, string> = { ...(init.headers as any) };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined && !(body instanceof Blob)) headers["content-type"] = "application/json";
  let r: Response;
  try {
    r = await fetch(base + path, { method: body !== undefined ? "POST" : "GET", ...init, headers, body: body instanceof Blob ? body : body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, "offline");
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, d.error ?? "error");
  return d as T;
}

// ---------- analytics (Conversion rulebook event schema) ----------
const anon = localStorage.getItem("ts_anon") ?? crypto.randomUUID();
localStorage.setItem("ts_anon", anon);
const sessionId = crypto.randomUUID();
let userId: string | null = null;
export const setUser = (email: string | null) => (userId = email);
export async function track(event: string, props: Record<string, unknown> = {}) {
  try {
    const e = await getEnv();
    const base = await server();
    const payload = {
      event,
      event_id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      anon_id: anon,
      user_id: userId,
      session_id: sessionId,
      page: new URLSearchParams(location.search).get("view") ?? "panel",
      source: "app",
      device: e.os,
      locale: navigator.language,
      experiment_ids: [],
      app_version: e.version,
      consent: "essential",
      perf_bucket: null,
      ...props,
    };
    fetch(`${base}/api/events`, { method: "POST", body: JSON.stringify(payload), keepalive: true }).catch(() => {});
  } catch {}
}

// ---------- native ----------
export type Shot = { data: string; w: number; h: number; sw: number; sh: number; scale: number };
// Our own windows are hidden from the AI's screenshots by the OS (content protection). In the
// consumer test that protection is off so the VM screenshots show the helper, so we hide our
// windows for the moment of the AI's screenshot instead: the AI sees what a real user's AI would.
export async function capture(region?: [number, number, number, number], max = 1280) {
  const veil = (await getEnv()).show_in_capture;
  if (veil) {
    await emit("veil", true);
    await new Promise((r) => setTimeout(r, 180));
  }
  try {
    return await invoke<Shot>("capture", { region: region ?? null, max });
  } finally {
    if (veil) emit("veil", false);
  }
}
export const act = (action: Record<string, unknown>) => invoke<void>("act", { action });
export const cursor = () => invoke<[number, number] | null>("cursor");
export type Win = { title: string; app: string; x: number; y: number; w: number; h: number };
export const windowsList = () => invoke<Win[]>("windows_list");
export const overlayMode = (visible: boolean, interactive = false) => invoke("overlay_mode", { visible, interactive });
export const placePanel = (width: number, height: number) => invoke("place_panel", { width, height });

// ---------- speech out: off unless "Talk out loud" is on in Settings (Orion, 2026-11-11) ----------
let voice: SpeechSynthesisVoice | null = null;
function pickVoice() {
  const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  voice = vs.find((v) => /Samantha|Aria|Jenny|Ava|Zira|Google US/i.test(v.name)) ?? vs[0] ?? null;
}
if ("speechSynthesis" in window) {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}
export function speak(text: string, s?: Me["settings"]): Promise<void> {
  if (!s?.voice || !("speechSynthesis" in window)) return Promise.resolve();
  return new Promise((resolve) => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.rate = s.speech === "slow" ? 0.85 : s.speech === "fast" ? 1.15 : 1;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    setTimeout(resolve, 1200 + text.length * 90);
    speechSynthesis.speak(u);
  });
}
export const hush = () => "speechSynthesis" in window && speechSynthesis.cancel();

// ---------- CI consumer test: a scripted person presses the recommended buttons ----------
export async function autopilot() {
  return (await getEnv()).autopilot;
}
export const apLog = (line: string) => invoke("autopilot_log", { line: `${new Date().toISOString()} ${line}` }).catch(() => {});
