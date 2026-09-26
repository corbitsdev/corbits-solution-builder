import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@corbits/react-ui";
import { App } from "./app.jsx";
// The Corbits component library first — it carries the Tailwind reset and the
// shared theme — then our own sheet, which overrides it for surfaces this app
// owns. Order is the whole contract between the two.
import "@corbits/react-ui/styles.css";
import "./styles.css";
import { openSharedEventSource } from "./shared-event-source.ts";

// Development only, and compiled out of a production bundle: `bun run dev`
// rebuilds the interface on every edit, and this is how the window hears about
// it. Without it the loop was "edit, alt-tab, reload by hand".
if (import.meta.env.DEV) {
  // Through the shared source so a hidden tab holds no connection for it (#91).
  const source = openSharedEventSource("/api/dev/reload", false);
  source.addEventListener("rebuilt", () => location.reload());
}

const root = document.getElementById("root");
if (!root) throw new Error("The app root element is missing from index.html.");
createRoot(root).render(
  <StrictMode>
    {/* Light unless the person chooses otherwise. Following the operating
        system meant most people met the product in dark, and the reading
        surfaces — a brief, a plan, a manifest — are designed light first. */}
    <ThemeProvider storageKey="solutions-builder-theme" defaultMode="light">
      <App />
    </ThemeProvider>
  </StrictMode>,
);
