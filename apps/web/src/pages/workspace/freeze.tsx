/**
 * Stage 7's target picker.
 *
 * Freezing the packet used to be its own workflow signal (`build.freeze`)
 * parked on a lifecycle run. Under the mail-chat contract (CL-8612) there is
 * no run to park it on: choosing a target is just another fact about the
 * approved draft, carried in the stage 7 artifact's own `sb.target` metadata
 * and read straight off it by the stage 8 agent's opening mail. No signal,
 * no freeze step — approving stage 7 with a target chosen is the freeze.
 */
import { useState } from "react";
import { Button, StateLabel } from "../../components.jsx";
import { SELECTABLE_TARGETS } from "@solutions-builder/app/targets";

/** One line naming the chosen target, prefixed onto stage 8's opening mail so the build specialist knows what it is building without re-deriving it from the plan. */
export function targetOpeningLine(target: string): string {
  const option = SELECTABLE_TARGETS.find((entry) => entry.target === target);
  return `Target: ${option?.label ?? target}.`;
}

/**
 * Asks the question until it has an answer, then states the answer. A card
 * that keeps asking "How will this be used?" under a badge saying the target
 * is chosen reads as if the choice did not register; one statement of the
 * fact, with a way to change it, is the whole surface.
 */
export function TargetPicker({
  chosen,
  onChange,
}: {
  chosen: string | null;
  onChange: (target: string) => void;
}) {
  const [changing, setChanging] = useState(false);
  const chosenOption = chosen ? SELECTABLE_TARGETS.find((option) => option.target === chosen) : undefined;
  if (chosenOption && !changing) {
    return (
      <div className="stage-lead target-picker target-chosen">
        <p className="text-sm">
          <span className="font-medium">Target:</span> {chosenOption.label}{" "}
          {chosenOption.verified ? (
            <StateLabel tone="okay">verified today</StateLabel>
          ) : (
            <StateLabel tone="disabled">not verified yet</StateLabel>
          )}
        </p>
        <Button variant="link" onClick={() => setChanging(true)}>
          Change
        </Button>
      </div>
    );
  }
  return (
    <div className="stage-lead target-picker" role="group" aria-labelledby="build-target-question">
      <p id="build-target-question" className="text-sm font-medium">
        How will this be used?
      </p>
      <p className="inline-note">
        Choose how the finished build will be used. Only a command-line check is actually run
        today — the others are honest about not being verified yet.
      </p>
      <div className="grid gap-2">
        {SELECTABLE_TARGETS.map((option) => (
          <label key={option.target} className="flex items-start gap-2">
            <input
              type="radio"
              name="build-target"
              checked={chosen === option.target}
              onChange={() => {
                onChange(option.target);
                setChanging(false);
              }}
            />
            <span>
              <span className="text-sm">{option.label}</span>{" "}
              {option.verified ? (
                <StateLabel tone="okay">verified today</StateLabel>
              ) : (
                <StateLabel tone="disabled">not verified yet</StateLabel>
              )}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
