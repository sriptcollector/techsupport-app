// The microphone. It records while the person talks, cuts at the end of each thing they say
// (1.2 s of quiet), and turns the audio into words on the server. Nothing is recorded while the mic
// is off, and the operating system's own mic light shows when it's on.
import { api } from "./api";

export type Heard = { text: string; at: number };
type Opts = { onLevel?: (l: number) => void; onSpeaking?: (on: boolean) => void; onWords: (h: Heard) => void; silenceMs?: number };

export class Mic {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private raf = 0;
  private speaking = false;
  private lastVoice = 0;
  private segStart = 0;
  private voiced = 0;
  on = false;
  constructor(private o: Opts) {}

  static supported() {
    return !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  }

  async start() {
    if (this.on) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      return false;
    }
    this.on = true;
    this.ctx = new AudioContext();
    const src = this.ctx.createMediaStreamSource(this.stream);
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let floor = 0.01;
    this.newSegment();
    const tick = () => {
      if (!this.on) return;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);
      floor = Math.min(0.05, floor * 0.995 + rms * 0.005); // slow-moving background level
      const level = Math.min(1, rms / 0.12);
      this.o.onLevel?.(level);
      const now = performance.now();
      const loud = rms > Math.max(0.018, floor * 2.5);
      if (loud) {
        this.lastVoice = now;
        this.voiced += 16;
        if (!this.speaking && this.voiced > 180) {
          this.speaking = true;
          this.o.onSpeaking?.(true);
        }
      }
      const silence = this.o.silenceMs ?? 1200;
      if (this.speaking && now - this.lastVoice > silence) {
        this.speaking = false;
        this.o.onSpeaking?.(false);
        this.cut(true);
      } else if (!this.speaking && now - this.segStart > 8000) {
        this.cut(false); // nothing said: drop the audio, keep listening
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
    return true;
  }

  private newSegment() {
    if (!this.stream) return;
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
    this.segStart = performance.now();
    this.voiced = 0;
  }

  private cut(send: boolean) {
    const rec = this.rec;
    if (!rec) return;
    const started = this.segStart;
    const chunks = this.chunks;
    rec.onstop = async () => {
      if (!send || !chunks.length) return;
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      const secs = Math.round((performance.now() - started) / 1000);
      try {
        const r = await api<{ text: string }>("/api/transcribe", blob, { headers: { "content-type": blob.type, "x-audio-seconds": String(secs) } });
        if (r.text) this.o.onWords({ text: r.text, at: Date.now() });
      } catch {}
    };
    rec.stop();
    if (this.on) this.newSegment();
  }

  /** Stops right away. `flush` sends what was being said (typing keeps the words). */
  stop(flush = false) {
    if (!this.on) return;
    this.on = false;
    cancelAnimationFrame(this.raf);
    if (flush && this.speaking) this.cut(true);
    else if (this.rec && this.rec.state !== "inactive") {
      this.rec.onstop = null;
      this.rec.stop();
    }
    this.speaking = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close();
    this.stream = null;
    this.ctx = null;
    this.o.onLevel?.(0);
  }
}

const DONE = /\b(that'?s all|that is all|that'?s it|i'?m done|im done|done|that'?s everything|okay go|ok go|go ahead|that'?s the problem|fix it)[.!]?$/i;
export const saidThatsAll = (t: string) => DONE.test(t.trim().toLowerCase().replace(/\b(um+|uh+|okay so)\b/g, "").replace(/\s+/g, " ").trim());
export const saidStop = (t: string) => /\b(stop|wait|hold on|no no|cancel)\b/i.test(t);
export const saidYes = (t: string) => /^(yes|yes do it|yes please|go ahead|okay do it|ok do it|do it)[.!]?$/i.test(t.trim());
