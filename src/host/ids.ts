/** Prefixed identifiers, so a stray id in a log or a payload names its own table. */
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function token(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export const newId = {
  project: () => `prj_${token()}`,
  branch: () => `brn_${token()}`,
  run: () => `run_${token()}`,
  node: () => `nod_${token()}`,
  approval: () => `apr_${token()}`,
  flag: () => `flg_${token()}`,
  packet: () => `pkt_${token()}`,
  question: () => `qst_${token()}`,
  event: () => `evt_${token()}`,
  manifest: () => `man_${token()}`,
  wait: () => `wai_${token()}`,
  provider: () => `prv_${token()}`,
  audit: () => `aud_${token()}`,
  outbox: () => `obx_${token()}`,
  correlation: () => `cor_${token()}`,
  command: () => `cmd_${token()}`,
  message: () => `msg_${token()}`,
  agentRun: () => `arr_${token()}`,
  inferenceTurn: () => `itn_${token()}`,
  turnPart: () => `tpt_${token()}`,
};

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
