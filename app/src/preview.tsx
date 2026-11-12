// Dev-only preview of the panel in a normal browser (not in the app build): fakes the native side
// and the server so every screen can be opened and screenshotted. ?comfort=quick|gentle|none
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const q = new URLSearchParams(location.search);
const comfort = q.get("comfort") === "none" ? "" : q.get("comfort") ?? "gentle";
history.replaceState(null, "", `?view=panel&${q.toString()}`);
if (comfort === "gentle") document.documentElement.style.cssText = "--w:440px;--h:640px";
mockWindows("panel");
let ev = 0;
mockIPC((cmd) => {
  if (cmd === "env_info") return { os: "windows", version: "0.2.0", server: "https://preview.invalid", test_session: "preview", show_in_capture: false, autopilot: null };
  if (cmd === "perms_status") return { screen: true, control: true };
  if (cmd === "plugin:event|listen") return ++ev;
  if (cmd === "capture") return { data: "", w: 1, h: 1, sw: 1, sh: 1, scale: 1 };
  return null;
});
const me = {
  email: "orionjones99+tech-test5@gmail.com", name: "Pat", plan: "trialing", trialEnds: Date.now() + 6 * 864e5, hadTrial: true, payer: null, canUse: true, why: null,
  usage: { sessions: 0, limit: 40 }, test: true,
  settings: { speech: "normal", voice: false, textSize: 17, moveSpeed: "normal", talkLess: false, comfort },
};
const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { "content-type": "application/json" } });
const real = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("https://preview.invalid")) return real(input, init);
  const path = new URL(url).pathname;
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (path === "/api/me") return json(me);
  if (path === "/api/settings") return (Object.assign(me.settings, body), json(me));
  if (path === "/api/ack") {
    const words = me.settings.comfort === "quick" ? ["Checking ", "your ", "display ", "settings."] : ["I can ", "make everything ", "on your screen ", "bigger."];
    const enc = new TextEncoder();
    return new Response(new ReadableStream({ async start(c) { for (const w of words) { await new Promise((r) => setTimeout(r, 120)); c.enqueue(enc.encode(`data: ${JSON.stringify({ t: w })}\n\n`)); } c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }));
  }
  if (path === "/api/agent") {
    await new Promise((r) => setTimeout(r, 900));
    return json({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "plan", input: { understood: "I will make the text a bit bigger. You can change it back any time.", task: "Bigger text", steps: ["Open Settings", "Turn Text size up to 125%"] } }] });
  }
  return new Response(null, { status: 204 });
};
await import("./main");
