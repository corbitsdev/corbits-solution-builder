import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "../../components.jsx";

/** Approving is a two-step: the button, then a confirm in place. */
export function ApproveControl({
  label,
  evaluatorPending = false,
  busy = false,
  disabled = false,
  variant = "primary",
  lead,
  doing,
  onApprove,
}: {
  label: "Approve" | "Send for approval";
  /** A reviewer exists and has not approved this draft. */
  evaluatorPending?: boolean;
  busy?: boolean;
  disabled?: boolean;
  variant?: "primary" | "ghost";
  /** Said beside the button, until it asks to confirm. */
  lead?: string;
  doing?: string;
  onApprove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <>
        {lead ? <span>{lead}</span> : null}
        <Button variant={variant} loading={busy} disabled={disabled} {...(doing ? { doing } : {})} onClick={() => setConfirming(true)}>
          <Check aria-hidden="true" />
          {label}
        </Button>
      </>
    );
  }
  return (
    <span className="approve-confirm" role="group" aria-label="Confirm">
      <span>
        {evaluatorPending ? "Continue anyway?" : label === "Approve" ? "Approve this and move on?" : "Send this for approval?"}
      </span>
      <Button
        variant="ghost"
        loading={busy}
        onClick={() => {
          setConfirming(false);
          onApprove();
        }}
      >
        Yes
      </Button>
      <Button variant="ghost" onClick={() => setConfirming(false)}>
        No
      </Button>
    </span>
  );
}
