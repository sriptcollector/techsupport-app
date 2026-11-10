import { createRoot } from "react-dom/client";
import "./styles.css";
import { Overlay } from "./overlay";
import { Panel } from "./panel";
import { Report } from "./report";

const view = new URLSearchParams(location.search).get("view");
createRoot(document.getElementById("root")!).render(view === "overlay" ? <Overlay /> : view === "report" ? <Report /> : <Panel />);
