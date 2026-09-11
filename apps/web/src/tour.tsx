/**
 * The first run, walked through once per stage.
 *
 * Reading a draft and pointing at a passage inside it are not discoverable —
 * nothing on the screen says that selecting text does anything. A person who
 * does not find that feature does not experience the product, so the first
 * time someone opens a drafted stage the tour shows them, anchored to the real
 * screen rather than a mocked one. Every stage looks different enough — some
 * have no composer at all — that one tour cannot describe all of them, so
 * each stage remembers its own first run and shows only what is on its own
 * screen.
 *
 * Seen-ness lives in this browser's localStorage: the host only persists
 * start-at-login, so a window on another machine sees the tour again.
 */
import { useEffect, useState } from "react";
import { Joyride, STATUS, type EventData, type Status, type Step } from "react-joyride";
import { STAGE_GOAL } from "./pages/workspace/gate.jsx";

/** Where a given stage's seen-ness lives. */
export function tourPreferenceKey(stage: number): string {
  return `tour.stage.${stage}.completed`;
}

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
  // Read on `body`, where the app lightens the brand orange, not on the root.
  const value = getComputedStyle(document.body).getPropertyValue(name).trim();
  return value || fallback;
}

/** The width under which the stylesheet stacks the document over the conversation. */
const STACKED_BELOW = 1080;

const documentPlacement = () => (window.innerWidth > STACKED_BELOW ? "left" : "center");

/** The three steps every stage with a composer, a document and a submit control shares. */
function draftingSteps(goal: string): Step[] {
  return [
    {
      target: '[data-tour="composer"]',
      title: "What this stage decides",
      content: goal,
    },
    {
      target: '[data-tour="document"]',
      // See the note on STACKED_BELOW above: beside the conversation above
      // that width, centred once the panes stack and there is no "beside".
      placement: documentPlacement(),
      title: "Rewritten from your answers",
      content:
        "It is rewritten with every answer you give. Select any passage in it and that passage attaches to your next message, so the specialist has exactly what you meant.",
    },
    {
      target: '[data-tour="submit"]',
      title: "Where to submit",
      content:
        "When it is right, submit it here. That records your approval against this exact version and opens the next stage.",
    },
  ];
}

/** Per-stage step maps. A stage with no entry shows nothing. */
const STAGE_STEPS: Record<number, () => Step[]> = {
  1: () => [
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
      placement: documentPlacement(),
      title: "The draft, beside the conversation",
      content:
        "It is rewritten with every answer you give. Select any passage in it and that passage attaches to your next message, so the specialist has exactly what you meant.",
    },
    {
      target: '[data-tour="submit"]',
      title: "When it is right, submit it",
      content:
        "That records your approval against this exact version and opens the next stage. It turns green once the evaluator judges the brief complete — but approving it is still your call, whenever you're ready.",
    },
  ],
  2: () => draftingSteps(STAGE_GOAL[2]!),
  3: () => draftingSteps(STAGE_GOAL[3]!),
  4: () => [
    {
      target: '[data-tour="design-feedback"]',
      title: "What this stage decides",
      content: STAGE_GOAL[4]!,
    },
    {
      target: '[data-tour="design-submit"]',
      title: "Where to submit",
      content:
        "Switch to feedback mode, click anything you want changed, then submit your feedback here to open the next design version.",
    },
  ],
  5: () => [
    {
      target: '[data-tour="audience-packages"]',
      title: "What this stage decides",
      content: STAGE_GOAL[5]!,
    },
    {
      target: '[data-tour="audience-decisions"]',
      title: "Where to submit",
      content:
        "Each audience records its own decision here. The stage moves on once the configured quorum has proceeded.",
    },
  ],
  6: () => draftingSteps(STAGE_GOAL[6]!),
  7: () => draftingSteps(STAGE_GOAL[7]!),
  8: () => [
    {
      target: '[data-tour="next-step"]',
      placement: "left",
      title: "What this stage decides",
      content: STAGE_GOAL[8]!,
    },
    {
      target: '[data-tour="build-panel"]',
      title: "Where to submit",
      content:
        "Start the build attempt here. Permissions and material changes still wait on you; this is where the evidence lands.",
    },
  ],
  9: () => [
    {
      target: '[data-tour="next-step"]',
      placement: "left",
      title: "What this stage decides",
      content: STAGE_GOAL[9]!,
    },
  ],
};

export function StageTour({ enabled, stage }: { enabled: boolean; stage: number }) {
  const [run, setRun] = useState(false);
  const key = tourPreferenceKey(stage);

  useEffect(() => {
    if (!enabled) return;
    try {
      if (localStorage.getItem(key) !== "true") setRun(true);
    } catch {
      // A tour that cannot check whether it already ran should stay quiet
      // rather than risk repeating itself on every open.
    }
  }, [enabled, key]);

  const finish = (data: EventData) => {
    const done: Status[] = [STATUS.FINISHED, STATUS.SKIPPED];
    if (!done.includes(data.status)) return;
    setRun(false);
    // Skipping counts as seen. Being shown it twice after saying no is worse
    // than never showing it.
    try {
      localStorage.setItem(key, "true");
    } catch {
      // Best effort; nothing to fall back to.
    }
  };

  const steps = STAGE_STEPS[stage];
  if (!enabled || !steps) return null;

  return (
    <Joyride
      run={run}
      steps={steps()}
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
