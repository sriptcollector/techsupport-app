// S30 "Report a bug": one window, mic on by itself, typing takes over, three quick picks, and an
// honest live status after Send (scope §10).
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useRef, useState } from "react";
import { api, getEnv, loadToken, track } from "./api";
import { Bars } from "./bot";
import { Mic } from "./voice";

const win = getCurrentWindow();
const PICKS = ["It moved too fast", "It clicked the wrong thing", "It talks too much"];
type Result = { kind: string; title: string; line?: string; undo?: { key: string; value: unknown } };

export function Report() {
  const [text, setText] = useState("");
  const [include, setInclude] = useState(true);
  const [level, setLevel] = useState(0);
  const [micOn, setMicOn] = useState(false);
  const [state, setState] = useState<"edit" | "sending" | "done">("edit");
  const [res, setRes] = useState<Result | null>(null);
  const mic = useRef<Mic | null>(null);

  function micStart() {
    mic.current?.stop();
    mic.current = new Mic({ onLevel: setLevel, onWords: (h) => setText((t) => (t ? `${t} ${h.text}` : h.text)) });
    mic.current.start().then(setMicOn);
  }
  function micStop(flush = false) {
    mic.current?.stop(flush);
    setMicOn(false);
  }
  useEffect(() => {
    const un = listen("report-open", async () => {
      await loadToken();
      setText("");
      setRes(null);
      setState("edit");
      await win.center();
      await win.show();
      await win.setFocus();
      track("cta_click", { cta: "report_bug" });
      micStart();
    });
    return () => void un.then((f) => f());
  }, []);
  const close = () => (micStop(), win.hide());

  async function send() {
    micStop(true);
    setState("sending");
    const env = await getEnv();
    try {
      const r = await api<Result>("/api/report", { text, os: env.os, version: env.version, include });
      setRes(r);
      track("report_sent", { kind: r.kind });
    } catch {
      setRes({ kind: "error", title: "We couldn't send that just now. Try again in a minute." });
    }
    setState("done");
  }
  async function undo() {
    if (!res?.undo) return;
    await api("/api/report/undo", res.undo).catch(() => {});
    setRes({ kind: "undone", title: "Done. It's back the way it was." });
  }

  return (
    <div className="report" onKeyDown={(e) => e.key === "Escape" && close()}>
      {state !== "done" ? (
        <>
          <h1>Tell us what's wrong and we'll change it in under 5 minutes</h1>
          <div className="row" style={{ flexWrap: "wrap" }}>
            {PICKS.map((p, i) => (
              <button key={p} className={`chip${i === 0 ? " rec" : ""}`} style={{ minHeight: 40 }} onClick={() => (micStop(), setText(p))}>{p}</button>
            ))}
          </div>
          <label className="small" htmlFor="what" style={{ marginBottom: -8 }}>What went wrong</label>
          <textarea id="what" className="field" value={text} placeholder='Say it or type it. Like: "The voice talks too fast"' onChange={(e) => (micOn && micStop(true), setText(e.target.value))} />
          <div className="listening">{micOn ? <><Bars level={level} />Listening…</> : <button className="link" style={{ padding: 0 }} onClick={micStart}>Turn the mic on</button>}</div>
          <label className="check">
            <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} />
            <span>Include what happened last time<span className="small" style={{ display: "block" }}>Helps us fix it faster.</span></span>
          </label>
          <div className="grow" />
          <button className="btn primary full" disabled={!text.trim() || state === "sending"} onClick={send}>{state === "sending" ? "Got it. Reading what you said…" : "Send"}</button>
          <button className="link" onClick={close}>Cancel</button>
        </>
      ) : (
        <>
          <h1>{res?.title}</h1>
          {res?.line && <p>{res.line}</p>}
          <div className="grow" />
          {res?.undo && <button className="btn full" onClick={undo}>Undo</button>}
          <button className="btn primary full" autoFocus onClick={close}>Close</button>
        </>
      )}
    </div>
  );
}
