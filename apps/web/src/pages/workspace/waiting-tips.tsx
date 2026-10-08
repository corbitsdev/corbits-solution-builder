import { useReducedMotion } from "../../zen-garden.tsx";
import { useElapsedMs } from "./elapsed.tsx";

export const WAITING_TIPS = [
  "When the specialist offers answers, tap one, or type your own.",
  "Documents open on the right as they are written, and update as you talk.",
  "Every version is kept. Pick an earlier one above the document to read it again.",
  "Select words in a document to point the specialist at exactly that part.",
  "When a document is right, approve it and the next stage begins.",
  "Missed something earlier? A stage can be sent back, and nothing is deleted.",
  "Attach files with the + button; they become material for the next draft.",
  "The microphone beside the message box turns speech into text.",
  "Each stage's model can be changed from the Inference menu above the chat.",
  "Earlier stages stay open to read from the steps along the top.",
] as const;

const TIP_MS = 7_000;

/** One tip at a time while the specialist gets ready, fading to the next;
 *  held on one under reduced motion. `inline` keeps it in the flow, for when
 *  the zen garden's strip holds the foot of the window. */
export function WaitingTips({ inline = false }: { inline?: boolean }) {
  const still = useReducedMotion();
  const elapsed = useElapsedMs();
  const index = still ? 0 : Math.floor(elapsed / TIP_MS) % WAITING_TIPS.length;
  return (
    <aside className="waiting-tips" data-inline={inline ? "" : undefined} aria-label="Tips">
      <p key={index} className="waiting-tip">
        {WAITING_TIPS[index]}
      </p>
    </aside>
  );
}
