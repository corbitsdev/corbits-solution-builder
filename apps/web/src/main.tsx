import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@corbits/react-ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app.jsx";
import { queryClient } from "./queries/client.ts";
// The Corbits component library first — it carries the Tailwind reset and the
// shared theme — then our own sheet, which overrides it for surfaces this app
// owns. Order is the whole contract between the two.
import "@corbits/react-ui/styles.css";
import "./styles.css";
import { openSharedEventSource } from "./shared-event-source.ts";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";
import { inShell } from "./shell.ts";

// Development only, and compiled out of a production bundle: `bun run dev`
// rebuilds the interface on every edit, and this is how the window hears about
// it. Without it the loop was "edit, alt-tab, reload by hand".
if (import.meta.env.DEV) {
  // Through the shared source so a hidden tab holds no connection for it (#91).
  const source = openSharedEventSource("/api/dev/reload", false);
  source.addEventListener("rebuilt", () => location.reload());
}

// The desktop shell saves a download link's file to the Downloads folder and
// says when it has; a browser shows its own download (#659).
if (inShell()) {
  void listen<{ name: string; success: boolean }>("download-finished", ({ payload }) => {
    if (payload.success) toast.success(`Saved ${payload.name} to Downloads.`);
    else toast.error(`${payload.name} could not be saved.`);
  });
}

const root = document.getElementById("root");
if (!root) throw new Error("The app root element is missing from index.html.");
createRoot(root).render(
  <StrictMode>
    {/* Light unless the person chooses otherwise. Following the operating
        system meant most people met the product in dark, and the reading
        surfaces — a brief, a plan, a manifest — are designed light first. */}
    <ThemeProvider storageKey="solutions-builder-theme" defaultMode="light">
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
