/**
 * The first run, walked through once.
 *
 * Reading a draft and pointing at a passage inside it are not discoverable —
 * nothing on the screen says that selecting text does anything. A person who
 * does not find that feature does not experience the product, so the first
 * time someone opens a drafted stage the tour shows them, anchored to the real
 * screen rather than a mocked one.
 *
 * Seen-ness lives in host preferences, not localStorage: it is a fact about
 * the person, and it should not repeat because they opened a new window.
 */
import { useEffect, useState } from "react";
import { Joyride, STATUS, type EventData, type Status, type Step } from "react-joyride";
import { api } from "./client.js";

export const TOUR_PREFERENCE = "tour.stage.completed";

/**
 * A theme token's current value.
 *
 * Joyride takes colours as strings rather than CSS, so the palette has to be
 * read rather than referenced. Hardcoding hex here was the token fork again,
 * moved somewhere the stylesheet's gate could not see it — and it rendered a
 * white card over a dark app.
 */
function token(name: string, fallback: string): string {
  if (typeof globalThis.getComputedStyle !== "function") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const STEPS: Step[] = [
  {
    target: '[data-tour="next-step"]',
    placement: "left",
    title: "Stuck? Start here",
    content:
      "This names the one thing to do next, at every stage, and it follows you around the app. You should never have to work out what happens now.",
  },
  {
    target: '[data-tour="composer"]',
    title: "Answer in your own words",
    content:
      "The specialist asks one question at a time. Answer it and the draft is rewritten with what you said, then the next question comes.",
  },
  {
    target: '[data-tour="document"]',
    title: "The draft, beside the conversation",
    content:
      "It is rewritten with every answer you give. Select any passage in it and that passage attaches to your next message, so the specialist has exactly what you meant.",
  },
  {
    target: '[data-tour="submit"]',
    title: "When it is right, submit it",
    content:
      "That records your approval against this exact version and opens the next stage. Only you can do it.",
  },
];

export function StageTour({ enabled }: { enabled: boolean }) {
  const [run, setRun] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api
      .preferences()
      .then((result) => {
        if (!cancelled && result.preferences[TOUR_PREFERENCE] !== true) setRun(true);
      })
      .catch(() => {
        // A tour that cannot check whether it already ran should stay quiet
        // rather than risk repeating itself on every open.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const finish = (data: EventData) => {
    const done: Status[] = [STATUS.FINISHED, STATUS.SKIPPED];
    if (!done.includes(data.status)) return;
    setRun(false);
    // Skipping counts as seen. Being shown it twice after saying no is worse
    // than never showing it.
    void api.setPreference(TOUR_PREFERENCE, true).catch(() => {});
  };

  if (!enabled) return null;

  return (
    <Joyride
      run={run}
      steps={STEPS}
      continuous
      onEvent={finish}
      locale={{ back: "Back", close: "Close", last: "Got it", next: "Next", skip: "Skip" }}
      options={{
        buttons: ["back", "primary", "skip"],
        overlayClickAction: false,
        showProgress: true,
        scrollOffset: 120,
        primaryColor: token("--primary", "#e98428"),
        textColor: token("--popover-foreground", "#2b2627"),
        backgroundColor: token("--popover", "#ffffff"),
        arrowColor: token("--popover", "#ffffff"),
        overlayColor: "rgb(0 0 0 / 55%)",
        spotlightRadius: 8,
        zIndex: 1000,
      }}
      styles={{
          tooltip: {
            borderRadius: "var(--radius-lg)",
            border: `1px solid ${token("--border", "#dfe3e6")}`,
            padding: 20,
          },
          tooltipTitle: { fontSize: "1rem", fontWeight: 500, margin: 0 },
          tooltipContent: { padding: "8px 0 0", fontSize: "0.875rem", lineHeight: 1.6 },
          buttonPrimary: { borderRadius: "var(--radius-md)", padding: "10px 16px", fontSize: "0.875rem" },
          buttonBack: { borderRadius: "var(--radius-md)", fontSize: "0.875rem" },
          buttonSkip: { fontSize: "0.875rem" },
              }}
    />
  );
}
