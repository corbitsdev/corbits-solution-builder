import "./smoke-env.ts";

// Proof-only read port: never mounted in the product, never accepts SQL.
import { database } from "../apps/hub/src/db.ts";
import { hub } from "../apps/hub/src/hub-mount.ts";

await import("../apps/hub/src/server.ts");

const delivery: unknown[] = [];
hub().events.on("sidecar.allocated.connected", ({ allocationId, generation }) => {
  delivery.push({ type: "connected", allocationId, generation });
});
hub().events.on("sidecar.disconnect", ({ allocated }) => {
  if (allocated) delivery.push({ type: "disconnected", ...(allocated as Record<string, unknown>) });
});
hub().events.on("mail.inbound.acknowledged", ({ messageId, allocated }) => {
  if (allocated) delivery.push({ type: "inbox-acknowledged", messageId, ...(allocated as Record<string, unknown>) });
});
process.on("message", async (message) => {
  if (message !== "snapshot") return;
  const allocations = await database().raw.query(`SELECT id, anchor_run_id, status,
    generation, ensure_accepted_generation, provisioner_binding_fingerprint,
    connect_deadline, next_attempt_at, failure_code FROM sidecar_allocation`);
  const dispatches = await database().raw.query(`SELECT id, anchor_run_id, message_id,
    kind, status, acknowledged_generation, attempt_count, next_attempt_at,
    failure_code, acknowledged_at, settled_at FROM workflow_run_dispatch`);
  process.send?.({
    allocations: allocations.rows,
    dispatches: dispatches.rows,
    bindingFingerprint: hub().sidecarBindingFingerprint,
    connected: hub().sidecars.connected(),
    delivery: [...delivery],
  });
});
