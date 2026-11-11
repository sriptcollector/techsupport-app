import { createRoot } from "react-dom/client";
import "./styles.css";
import { Overlay } from "./overlay";
import { Panel } from "./panel";
import { Report } from "./report";
import { invoke } from "@tauri-apps/api/core";
import { track } from "./api";

// Errors are reported with where they happened, never with what's on screen or what was typed.
window.addEventListener("error", (e) => track("critical_error", { where: new URLSearchParams(location.search).get("view"), message: String(e.message).slice(0, 160) }));
window.addEventListener("unhandledrejection", (e) => track("critical_error", { where: new URLSearchParams(location.search).get("view"), message: String((e.reason as any)?.message ?? e.reason).slice(0, 160) }));
if (new URLSearchParams(location.search).get("view") === "panel")
  invoke<{ screen: boolean; control: boolean }>("perms_status").then((p) => track("perm_state", p)).catch(() => {});

const view = new URLSearchParams(location.search).get("view");
createRoot(document.getElementById("root")!).render(view === "overlay" ? <Overlay /> : view === "report" ? <Report /> : <Panel />);

// Updates arrive by themselves: checked at start and every 3 hours, installed while nobody is being
// helped, and the app reopens where it was. (Builds are signed for the updater; unsigned ones are refused.)
if (new URLSearchParams(location.search).get("view") === "panel") {
  const tryUpdate = async () => {
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const u = await check();
      if (!u) return;
      track("update_found", { to: u.version });
      await u.downloadAndInstall();
      // Never restart in the middle of a help session.
      const waitIdle = () => (document.body.dataset.busy === "1" ? setTimeout(waitIdle, 30_000) : invoke("relaunch"));
      waitIdle();
    } catch (e) {
      track("update_error", { message: String(e).slice(0, 120) });
    }
  };
  setTimeout(tryUpdate, 20_000);
  setInterval(tryUpdate, 3 * 3600_000);
}
