/**
 * Shared surfaces. Small on purpose: the design contract is mostly CSS, and a
 * component here exists only where behaviour or an accessibility obligation
 * travels with the markup.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Compass, Loader2, X } from "lucide-react";
import {
  Badge,
  Button as UiButton,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  StatusDot,
  type StatusDotTone,
} from "@corbits/react-ui";
import corbitsMark from "./assets/corbits-mark.svg";

type Tone =
  | "success"
  | "okay"
  | "warning"
  | "error"
  | "selected"
  | "info"
  | "loading"
  | "disabled";

const STATE_TONES: Record<string, { badge: "neutral" | "success" | "warning" | "danger"; dot: StatusDotTone }> = {
  success: { badge: "success", dot: "success" },
  okay: { badge: "success", dot: "success" },
  warning: { badge: "warning", dot: "warning" },
  error: { badge: "danger", dot: "danger" },
  selected: { badge: "neutral", dot: "emphasis" },
  info: { badge: "neutral", dot: "neutral" },
  loading: { badge: "neutral", dot: "emphasis" },
  disabled: { badge: "neutral", dot: "neutral" },
};

/**
 * A state, in the system's own vocabulary: a badge that names it and a dot
 * that marks it. Colour is paired with words, always — a reader who cannot see
 * the hue still reads the state.
 */
export function StateLabel({
  tone = "info",
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  const mapped = STATE_TONES[tone] ?? STATE_TONES.info!;
  return (
    <Badge tone={mapped.badge}>
      <StatusDot
        label=""
        tone={mapped.dot}
        size="xs"
        live={tone === "loading"}
      />
      {children}
    </Badge>
  );
}

/**
 * The library's button, with the two affordances this app adds.
 *
 * `loading` and `block` are ours; everything about how a button looks, presses
 * and disables is the design system's. The hand-rolled version had a 58px
 * primary — 45% taller than the system's largest size — which is why every
 * call to action read as a marketing blob rather than product chrome.
 */
export function Button({
  variant = "outline",
  loading = false,
  disabled = false,
  block = false,
  onClick,
  children,
  type = "button",
  ...rest
}: {
  variant?: "primary" | "secondary" | "outline" | "ghost" | "link" | "destructive";
  loading?: boolean;
  disabled?: boolean;
  /** Fills its container — for the single action that owns a screen. */
  block?: boolean;
  onClick?: () => void;
  children: ReactNode;
  type?: "button" | "submit";
  /** Anchors the first-run tour. */
  "data-tour"?: string;
}) {
  const inert = disabled || loading;
  return (
    <UiButton
      type={type}
      variant={variant}
      className={block ? "w-full" : undefined}
      disabled={inert}
      aria-busy={loading}
      onClick={inert ? undefined : onClick}
      {...rest}
    >
      {loading ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
      {children}
    </UiButton>
  );
}

/**
 * A titled section, on the system's Card.
 *
 * The hand-rolled version inverted the system's figure-ground — a white panel
 * on a white page — and set its own padding, which is why no two panels in the
 * app agreed on an inset.
 */
export function Screen({
  title,
  description,
  status,
  priority = false,
  tight = false,
  children,
}: {
  title: string;
  description?: ReactNode;
  status?: ReactNode;
  priority?: boolean;
  tight?: boolean;
  children: ReactNode;
}) {
  const headingId = `screen-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <Card
      aria-labelledby={headingId}
      className={priority ? "border-primary" : undefined}
    >
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div>
          <CardTitle id={headingId}>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {status ? <div className="shrink-0">{status}</div> : null}
      </CardHeader>
      <div className={tight ? "" : "grid gap-4"}>{children}</div>
    </Card>
  );
}

export function Banner({
  tone = "warning",
  title,
  action,
  children,
}: {
  tone?: "warning" | "error" | "okay";
  title: string;
  /**
   * The way out. A failure with an obvious next move should offer it here
   * rather than describe it and leave the person to find the screen.
   */
  action?: { label: string; onClick: () => void };
  title2?: never;
  children?: ReactNode;
}) {
  return (
    <div
      className={`banner${tone === "error" ? " is-error" : tone === "okay" ? " is-okay" : ""}`}
      role="status"
    >
      <p className="banner-title">{title}</p>
      {children ? <p>{children}</p> : null}
      {action ? (
        <div className="banner-action">
          <Button onClick={action.onClick}>{action.label}</Button>
        </div>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  helper,
  error,
  children,
}: {
  label: string;
  helper?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      {/* Labels are persistent, never a placeholder that vanishes on focus. */}
      <label className="text-sm font-medium">{label}</label>
      {children}
      {helper ? <p className="text-xs text-muted-foreground">{helper}</p> : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const STAGE_NAMES = [
  "Problem discovery",
  "Solution shape",
  "Solution proposal",
  "GUI design",
  "Concept approval",
  "Build plan",
  "Cost approval",
  "Build and test",
  "Deliver",
];

export function stageName(stage: number | null): string {
  return stage === null ? "Not started" : (STAGE_NAMES[stage - 1] ?? `Stage ${stage}`);
}

export function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}

export function Mark({ size = 26 }: { size?: number }) {
  return (
    <img
      src={corbitsMark}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      style={{ display: "block", flex: "none" }}
    />
  );
}

/**
 * The guide: a control in the header bar rather than a band across the top.
 *
 * The next move has to be available everywhere, which is not the same as it
 * occupying a full width of the window at all times. One sentence does not
 * earn a whole band, and the band pushed the actual work down the screen.
 *
 * Floating it over the canvas was worse: whether it landed on the composer or
 * the tabs depends on the rail's width and the conversation's measure, not on
 * the viewport, so every breakpoint chosen to dodge them was wrong somewhere.
 * In the bar it is laid out with everything else. Closed it still names the
 * next action, because a control that only says "help" is one nobody opens.
 */
export function GuideDock({
  step,
  onGo,
  onExplain,
  guidance,
  explaining,
  at,
  stage,
}: {
  step: import("@solutions-builder/app/next-step").NextStep;
  onGo: (where: import("@solutions-builder/app/next-step").NextStep["where"]) => void;
  onExplain: () => void;
  guidance: import("./client.js").Guidance | null;
  explaining: boolean;
  at?: import("@solutions-builder/app/next-step").NextStep["where"];
  /** Which of the nine this project is on, for the ring. */
  stage?: number;
}) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const fab = useRef<HTMLButtonElement>(null);

  // `role="dialog"` is a promise about the keyboard: Escape closes it, focus
  // moves into it on open and back to the control it came from on close, and
  // clicking away dismisses it. Without those it is a div wearing a role.
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        fab.current?.focus();
      }
    };
    const onPointer = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panel.current?.contains(target) || fab.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  return (
    <div className="guide-dock" data-tour="next-step">
      {open ? (
        <div
          ref={panel}
          className="guide-panel"
          role="dialog"
          aria-modal="false"
          aria-label="What happens next"
          tabIndex={-1}
        >
          <div className="guide-panel-head">
            <p className="guide-title">
              {step.ending || at === step.where ? step.title : `Next: ${step.title}`}
            </p>
            <button
              type="button"
              className="guide-close"
              aria-label="Close"
              onClick={() => {
                setOpen(false);
                fab.current?.focus();
              }}
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <p className="guide-detail">{step.detail}</p>

          {guidance ? (
            <div className="guide-guidance">
              <p>{guidance.summary}</p>
              {guidance.missing.length > 0 ? (
                <>
                  <h4>Still missing</h4>
                  <ul>
                    {guidance.missing.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </>
              ) : null}
              <p className="inline-note">
                {guidance.origin === "agent"
                  ? `Read from ${guidance.sourceVersionIds.length} version${guidance.sourceVersionIds.length === 1 ? "" : "s"}. The guide recommends a route; it never takes one.`
                  : "No specialist was reachable, so this is the deterministic checklist."}
              </p>
            </div>
          ) : null}

          <div className="guide-actions">
            {step.ending || step.where === at ? null : (
              <Button variant="primary" onClick={() => onGo(step.where)}>
                {step.where === "decisions"
                  ? "Go to the decision queue"
                  : step.where === "artifacts"
                    ? "Open artifacts"
                    : step.where === "settings"
                      ? "Open settings"
                      : "Take me there"}
              </Button>
            )}
            {guidance ? null : (
              <Button loading={explaining} onClick={onExplain}>
                Where does this stand?
              </Button>
            )}
          </div>
        </div>
      ) : null}

      <button
        ref={fab}
        type="button"
        className={`guide-fab${open ? " is-open" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span key={step.title} className="guide-live">
          {stage ? <StageRing stage={stage} /> : <Compass aria-hidden="true" />}
        </span>
        {/* Closed, it is the ring and nothing else — a small mark of how far
            through the nine stages this is, sitting out of the way. The words
            are in the card it opens, so the corner of the window is not
            carrying a sentence at all times. */}
        <span className="sr-only">
          {step.ending || at === step.where ? step.title : `Next: ${step.title}`}
        </span>
      </button>
    </div>
  );
}

/**
 * How far along the nine stages this project is.
 *
 * A ring rather than a number: progress through a fixed sequence is a shape,
 * and the shape is readable before the label is. The stage still reads out for
 * anyone who cannot see it.
 */
export function StageRing({ stage, total = 9 }: { stage: number; total?: number }) {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const done = Math.max(0, Math.min(stage, total)) / total;
  return (
    <svg
      className="stage-ring"
      viewBox="0 0 20 20"
      role="img"
      aria-label={`Stage ${stage} of ${total}`}
    >
      <circle cx="10" cy="10" r={radius} className="stage-ring-track" />
      <circle
        cx="10"
        cy="10"
        r={radius}
        className="stage-ring-fill"
        strokeDasharray={`${circumference * done} ${circumference}`}
        transform="rotate(-90 10 10)"
      />
    </svg>
  );
}

/**
 * What a document is called, in the words a person would use.
 *
 * Stored titles are the producing agent's ("Brainstormer — stage 1"), which
 * names the machine that made it rather than the thing itself. A reader wants
 * to know they are looking at a problem brief.
 */
const DOCUMENT_NAMES: Record<string, string> = {
  problem_brief: "Problem brief",
  solution_constraints: "Constraints",
  chosen_approach: "Chosen approach",
  design_artifact: "Design",
  design_feedback: "Design feedback",
  audience_package: "Audience package",
  build_plan: "Build plan",
  engineering_review: "Engineering review",
  cost_approval: "Cost",
  build_packet: "Build packet",
  build_evidence: "Build evidence",
  delivery_manifest: "Delivery manifest",
  delivery_verification: "Delivery verification",
};

/**
 * A number that rolls to its next value like an odometer wheel: the old digit
 * slides up and out as the new one rises in. A count that changes by simply
 * being a different number is easy to miss.
 */
export function RollingNumber({ value }: { value: number }) {
  const previous = useRef(value);
  const [from, setFrom] = useState<number | null>(null);
  useEffect(() => {
    if (previous.current === value) return;
    setFrom(previous.current);
    previous.current = value;
  }, [value]);
  return (
    <span className="roll" aria-label={String(value)}>
      {from !== null && from !== value ? (
        <span key={`out-${from}`} className="roll-out" aria-hidden="true" onAnimationEnd={() => setFrom(null)}>
          {from}
        </span>
      ) : null}
      <span key={`in-${value}`} className={from !== null && from !== value ? "roll-in" : undefined} aria-hidden="true">
        {value}
      </span>
    </span>
  );
}

export function documentName(kind: string): string {
  return DOCUMENT_NAMES[kind] ?? kind.replace(/_/g, " ");
}
