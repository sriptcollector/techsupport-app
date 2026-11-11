// The Mac permission walkthrough (scope S6, rebuilt after Orion's real-Mac test).
// Apple doesn't let an app flip its own switches, so for each one we: add Tech Support to the list
// (so nobody has to press "+"), open the exact System Settings page, stand beside it with a picture of
// exactly what to click, and watch for the moment it's on. Screen recording only takes effect after
// a relaunch, so we relaunch ourselves and pick up exactly where we were.
// Only what the first help needs is asked here (click and type, see the screen). The microphone is
// asked the first time they talk, by the Mac's own one-click box.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { apLog, autopilot, capture, track } from "./api";

type Stage = "intro" | "control" | "control_restart" | "screen" | "restart" | "done";
const KEY = "ts_perm_stage";
const win = getCurrentWindow();

/** A drawing of the System Settings page with the exact switch to click. */
function Picture({ pane, highlight }: { pane: "Accessibility" | "Screen & System Audio Recording"; highlight: "switch" | "reopen" | "allow" | "plus" }) {
  return (
    <svg viewBox="0 0 480 270" width="100%" role="img" aria-label={highlight === "reopen" ? `A box saying Quit & Reopen, with the Quit & Reopen button circled` : `System Settings, ${pane}, with the switch next to Tech Support circled`} style={{ display: "block", borderRadius: 12, border: "1px solid var(--hair-strong)", background: "var(--surface)" }}>
      <rect x="0" y="0" width="480" height="270" fill="var(--surface)" />
      <rect x="0" y="0" width="140" height="270" fill="var(--bg)" />
      <circle cx="16" cy="16" r="5" fill="#ff5f57" /><circle cx="32" cy="16" r="5" fill="#febc2e" /><circle cx="48" cy="16" r="5" fill="#28c840" />
      {["Wi-Fi", "Bluetooth", "Network", "General", "Accessibility", "Privacy & Security", "Displays"].map((t, i) => (
        <g key={t}>
          {t === "Privacy & Security" && <rect x="8" y={40 + i * 26} width="124" height="22" rx="6" fill="var(--user)" />}
          <text x="18" y={55 + i * 26} fontSize="11" fill={t === "Privacy & Security" ? "#fff" : "var(--ink-2)"} fontFamily="var(--font)">{t}</text>
        </g>
      ))}
      <text x="160" y="34" fontSize="14" fontWeight="600" fill="var(--ink)" fontFamily="var(--font)">{pane}</text>
      <text x="160" y="52" fontSize="10" fill="var(--ink-2)" fontFamily="var(--font)">Allow the apps below to {pane === "Accessibility" ? "control your computer." : "record your screen."}</text>
      {["Tech Support", "Zoom", "Google Chrome"].map((t, i) => (
        <g key={t}>
          <rect x="160" y={66 + i * 40} width="300" height="36" rx="8" fill="var(--bg)" stroke={i === 0 ? "var(--user)" : "var(--hair)"} strokeWidth={i === 0 ? 2 : 1} />
          {i === 0 ? (
            <g transform={`translate(170 ${72 + i * 40}) scale(0.62)`}><circle cx="21" cy="20.5" r="16" fill="#0B0B0B" /><path d="M6.5 19.5a14.5 14.5 0 0 1 29 0" fill="none" stroke="#fff" strokeWidth="2.2" /><rect x="2.5" y="16.5" width="6.5" height="9.5" rx="2.6" fill="#fff" /><ellipse cx="16.5" cy="21" rx="2.6" ry="4.4" fill="#fff" /><ellipse cx="26" cy="21" rx="2.6" ry="4.4" fill="#fff" /></g>
          ) : (
            <rect x="172" y={74 + i * 40} width="20" height="20" rx="5" fill="var(--hair-strong)" />
          )}
          <text x="202" y={89 + i * 40} fontSize="12" fill="var(--ink)" fontFamily="var(--font)" fontWeight={i === 0 ? 600 : 400}>{t}</text>
          <rect x="414" y={75 + i * 40} width="34" height="18" rx="9" fill={i === 0 ? "var(--hair-strong)" : "var(--user)"} />
          <circle cx={i === 0 ? 424 : 438} cy={84 + i * 40} r="7" fill="#fff" />
        </g>
      ))}
      {highlight === "switch" && (
        <g>
          <circle cx="431" cy="84" r="19" fill="none" stroke="var(--careful)" strokeWidth="3" />
          <path d="M392 160 L424 104" stroke="var(--careful)" strokeWidth="3" strokeLinecap="round" />
          <path d="M424 104 l-10 4 M424 104 l-1 11" stroke="var(--careful)" strokeWidth="3" strokeLinecap="round" />
          <text x="300" y="178" fontSize="13" fontWeight="600" fill="var(--careful)" fontFamily="var(--font)">Click this switch</text>
        </g>
      )}
      {highlight === "plus" && (
        <g>
          <rect x="160" y="190" width="300" height="26" rx="6" fill="var(--bg)" stroke="var(--hair)" />
          <text x="172" y="208" fontSize="15" fontWeight="600" fill="var(--ink)" fontFamily="var(--font)">+</text>
          <text x="190" y="208" fontSize="15" fill="var(--ink-2)" fontFamily="var(--font)">&#8722;</text>
          <circle cx="176" cy="203" r="14" fill="none" stroke="var(--careful)" strokeWidth="3" />
          <text x="200" y="250" fontSize="13" fontWeight="600" fill="var(--careful)" fontFamily="var(--font)">Click + here</text>
        </g>
      )}
      {highlight === "allow" && (
        <g>
          <rect x="140" y="40" width="200" height="200" rx="14" fill="var(--surface)" stroke="var(--hair-strong)" />
          <rect x="222" y="54" width="36" height="36" rx="8" fill="var(--user)" />
          <text x="240" y="112" fontSize="10.5" fontWeight="600" fill="var(--ink)" textAnchor="middle" fontFamily="var(--font)">"Tech Support" is requesting to</text>
          <text x="240" y="126" fontSize="10.5" fontWeight="600" fill="var(--ink)" textAnchor="middle" fontFamily="var(--font)">access your screen and audio.</text>
          <rect x="156" y="170" width="168" height="24" rx="6" fill="var(--user)" />
          <text x="240" y="186" fontSize="12" fill="#fff" textAnchor="middle" fontFamily="var(--font)">Allow</text>
          <rect x="156" y="200" width="168" height="24" rx="6" fill="var(--bg)" stroke="var(--hair)" />
          <text x="240" y="216" fontSize="11" fill="var(--ink)" textAnchor="middle" fontFamily="var(--font)">Open System Settings</text>
          <rect x="150" y="164" width="180" height="36" rx="9" fill="none" stroke="var(--careful)" strokeWidth="3" />
        </g>
      )}
      {highlight === "reopen" && (
        <g>
          <rect x="150" y="70" width="210" height="130" rx="12" fill="var(--surface)" stroke="var(--hair-strong)" />
          <text x="166" y="98" fontSize="12" fontWeight="600" fill="var(--ink)" fontFamily="var(--font)">"Tech Support" may not be able</text>
          <text x="166" y="114" fontSize="12" fontWeight="600" fill="var(--ink)" fontFamily="var(--font)">to record until it is quit.</text>
          <rect x="166" y="132" width="178" height="24" rx="6" fill="var(--user)" />
          <text x="213" y="148" fontSize="12" fill="#fff" fontFamily="var(--font)">Quit &amp; Reopen</text>
          <rect x="166" y="162" width="178" height="24" rx="6" fill="var(--bg)" stroke="var(--hair)" />
          <text x="240" y="178" fontSize="12" fill="var(--ink)" fontFamily="var(--font)">Later</text>
          <rect x="160" y="126" width="190" height="36" rx="9" fill="none" stroke="var(--careful)" strokeWidth="3" />
        </g>
      )}
    </svg>
  );
}

export function Perms({ progress, onDone, onBack, Back }: { progress: React.ReactNode; onDone: () => void; onBack: () => void; Back: (p: { onClick: () => void }) => React.ReactElement }) {
  const [stage, setStage] = useState<Stage>(() => (localStorage.getItem(KEY) as Stage) || "intro");
  const [p, setP] = useState({ screen: false, control: false });
  const [waited, setWaited] = useState(0);
  const moved = useRef(false);
  const go = (s: Stage) => {
    localStorage.setItem(KEY, s);
    setStage(s);
    setWaited(0);
    track("permission_step", { stage: s });
    apLog(`perm stage ${s}`);
  };

  // Live check, twice a second.
  useEffect(() => {
    const iv = setInterval(async () => {
      const s = await invoke<{ screen: boolean; control: boolean }>("perms_status");
      setP(s);
      setWaited((w) => w + 0.5);
    }, 500);
    return () => clearInterval(iv);
  }, []);

  // Stand beside System Settings (it opens on the left/middle), not on top of it.
  useEffect(() => {
    if (stage === "intro") return;
    const t = setTimeout(async () => {
      const w = 470, h = Math.min(700, screen.availHeight - 60);
      await win.setSize(new LogicalSize(w, h)).catch(() => {});
      win.setPosition(new LogicalPosition(Math.max(0, screen.availWidth - w - 16), 36)).catch(() => {});
    }, 450);
    moved.current = true;
    return () => clearTimeout(t);
  }, [stage]);

  // Move on by itself the moment a switch is on.
  useEffect(() => {
    if ((stage === "control" || stage === "control_restart") && p.control) go(p.screen ? "done" : "screen");
    if ((stage === "screen" || stage === "restart") && p.screen) go("done");
    if ((stage === "intro" || stage === "control" || stage === "control_restart") && p.control && p.screen) go("done");
  }, [p, stage]);

  useEffect(() => {
    if (stage === "control") invoke("perms_open", { which: "control" });
    if (stage === "control_restart" && !p.control) invoke("perms_open", { which: "control" });
    if (stage === "screen") {
      // Newer Macs only put an app in the Screen Recording list after it has tried to capture once,
      // so try first (it's refused until the switch is on), then open the page.
      capture(undefined, 64).catch(() => {}).finally(() => invoke("perms_open", { which: "screen" }));
    }
    if (stage === "done") {
      // Newer Macs ask once more ("bypass the private window picker"): it comes here, guided, not
      // mid-help. We only finish setup once a real screenshot works.
      let stop = false;
      const tryIt = async () => {
        if (stop) return;
        const ok = await capture(undefined, 64).then((c) => c.w > 0).catch(() => false);
        if (ok) {
          localStorage.setItem("ts_capture_ok", "1");
          localStorage.removeItem(KEY);
          apLog("perm stage done");
          setTimeout(onDone, 1200);
        } else setTimeout(tryIt, 1500);
      };
      tryIt();
      return () => {
        stop = true;
      };
    }
  }, [stage]);

  // CI only: after the guide is up, the scripted person "flips the switch" (the workflow does it for real).
  useEffect(() => {
    autopilot().then((ap) => ap && stage === "intro" && setTimeout(() => go(p.control ? "screen" : "control"), 3000));
  }, []);

  // CI only: after the workflow has flipped the switch, the scripted person presses "I clicked the switch".
  useEffect(() => {
    let t = 0;
    autopilot().then((ap) => {
      if (ap && (stage === "screen" || stage === "control")) t = window.setTimeout(() => relaunch(stage === "control" ? "control_restart" : "restart"), 20000);
    });
    return () => clearTimeout(t);
  }, [stage]);

  // Screen recording needs a relaunch. If the switch is on but the Mac hasn't let us see yet, we relaunch.
  // Some Macs only count a switch after the app reopens ("restart" in Apple's own box): we reopen ourselves.
  async function relaunch(next: Stage = "restart") {
    if (next === "control_restart" && p.control) return go(p.screen ? "done" : "screen");
    localStorage.setItem(KEY, next);
    apLog("perm relaunch");
    await invoke("relaunch");
  }

  const body =
    stage === "intro" ? (
      <>
        <h1>Two switches, and I'll show you each one</h1>
        <p>So I can see your screen and click for you. Your Mac asks you to turn these on yourself. I'll open the right page and point at the exact switch.</p>
        <div className="grow" />
        <button className="btn primary full" autoFocus onClick={() => go(p.control ? "screen" : "control")}>Show me the first switch</button>
      </>
    ) : stage === "control" ? (
      <>
        <span className="mono">Switch 1 of 2 · Click and type for you</span>
        <h2 style={{ margin: "8px 0 12px" }}>Click the switch next to Tech Support</h2>
        <Picture pane="Accessibility" highlight="switch" />
        <p style={{ margin: "12px 0 0" }}>It's on the System Settings page I just opened. Your Mac may ask for your password or fingerprint. That's the Mac checking it's you.</p>
        <div className="grow" />
        <p className="small" role="status">Waiting for the switch… I'll move on by myself. If your Mac asks to restart Tech Support, press the button below.</p>
        <button className="btn primary full" onClick={() => relaunch("control_restart")}>I clicked the switch</button>
        <button className="link" style={{ fontSize: 14 }} onClick={() => invoke("perms_open", { which: "control" })}>Open the page again</button>
      </>
    ) : stage === "control_restart" ? (
      <>
        <span className="mono">Switch 1 of 2 · Click and type for you</span>
        <h2 style={{ margin: "8px 0 12px" }}>It isn't on yet</h2>
        <Picture pane="Accessibility" highlight="switch" />
        <p style={{ margin: "12px 0 0" }}>The switch next to Tech Support needs to be blue. I opened the page again. Click the switch, then press the button below.</p>
        <div className="grow" />
        <button className="btn primary full" onClick={() => relaunch("control_restart")}>I clicked the switch</button>
      </>
    ) : stage === "screen" ? (
      <>
        <span className="mono">Switch 2 of 2 · See your screen</span>
        <h2 style={{ margin: "8px 0 12px" }}>Click the switch next to Tech Support</h2>
        <Picture pane="Screen & System Audio Recording" highlight="switch" />
        <p style={{ margin: "12px 0 0" }}>Then your Mac will say "Quit &amp; Reopen". Click it. I'll come right back to this spot.</p>
        <details style={{ marginTop: 10 }}>
          <summary className="small" style={{ cursor: "pointer" }}>Don't see Tech Support in the list?</summary>
          <Picture pane="Screen & System Audio Recording" highlight="plus" />
          <p className="small" style={{ margin: "8px 0 0" }}>Click <b>+</b> under the list, pick <b>Applications</b>, then <b>Tech Support</b>, then <b>Open</b>. Then click its switch.</p>
        </details>
        <div className="grow" />
        <button className="btn primary full" onClick={() => relaunch()}>I clicked the switch</button>
        <button className="link" style={{ fontSize: 14 }} onClick={() => invoke("perms_open", { which: "screen" })}>Open the page again</button>
      </>
    ) : stage === "restart" ? (
      <>
        <span className="mono">Switch 2 of 2 · See your screen</span>
        <h2 style={{ margin: "8px 0 12px" }}>{p.screen ? "All set" : "It isn't on yet"}</h2>
        <Picture pane="Screen & System Audio Recording" highlight="switch" />
        <p style={{ margin: "12px 0 0" }}>The switch next to Tech Support needs to be blue. Click it, then press the button below.</p>
        <div className="grow" />
        <button className="btn primary full" onClick={() => relaunch()}>I clicked the switch</button>
        <button className="link" style={{ fontSize: 14 }} onClick={() => invoke("perms_open", { which: "screen" })}>Open the page again</button>
      </>
    ) : (
      <>
        <span className="mono">Last step</span>
        <h2 style={{ margin: "8px 0 12px" }}>If your Mac asks once more, click Allow</h2>
        <Picture pane="Screen & System Audio Recording" highlight="allow" />
        <p style={{ margin: "12px 0 0" }}>That box is the Mac double-checking. Click the blue Allow button. I'll carry on by myself.</p>
      </>
    );

  return (
    <div className="panel">
      <div className="drag" data-tauri-drag-region />
      {progress}
      <div className="body center" style={{ textAlign: "left", alignItems: "stretch" }}>
        <Back onClick={() => (stage === "screen" || stage === "restart" ? go("control") : stage === "control" || stage === "control_restart" ? go("intro") : onBack())} />
        {body}
      </div>
    </div>
  );
}
