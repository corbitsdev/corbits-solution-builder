/**
 * Pushes a file tree into a hub asset's git repo from the browser.
 *
 * isomorphic-git builds the commit and the pack; the receive-pack wire
 * exchange is spoken directly because the hub answers `report-status` as raw
 * pkt-lines, which isomorphic-git's own `push` cannot read (mirrors
 * `corbitsdev/workbench`'s `apps/web/src/git-push.ts`, generalized here to a
 * nested tree since the lifecycle asset's tree is a real workspace, not a
 * flat two-file package).
 */
import LightningFS from "@isomorphic-git/lightning-fs";
import { Buffer } from "buffer";
import git, { type PromiseFsClient } from "isomorphic-git";

// isomorphic-git reads the Node `Buffer` global; browsers do not ship one.
globalThis.Buffer ??= Buffer;

export class GitPushError extends Error {}

const COMMIT_AUTHOR = { name: "Solution Builder", email: "solutions-builder@corbits.dev" };
const MAIN_REF = "refs/heads/main";
const ZERO_OID = "0".repeat(40);

function pktLine(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const header = (payload.length + 4).toString(16).padStart(4, "0");
  return new Uint8Array([...new TextEncoder().encode(header), ...payload]);
}

function readPktLines(body: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = parseInt(decoder.decode(body.subarray(offset, offset + 4)), 16);
    offset += 4;
    if (Number.isNaN(length)) throw new GitPushError("malformed pkt-line header from the hub");
    if (length === 0) continue;
    lines.push(decoder.decode(body.subarray(offset, offset + length - 4)));
    offset += length - 4;
  }
  return lines;
}

async function advertisedMainSha(url: string, token: string, fetchImpl: FetchLike): Promise<string> {
  const response = await fetchImpl(`${url}/info/refs?service=git-receive-pack`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new GitPushError(`ref advertisement failed: HTTP ${String(response.status)} ${body}`);
  }
  const lines = readPktLines(new Uint8Array(await response.arrayBuffer()));
  for (const line of lines) {
    const [sha, rest] = line.split(" ", 2);
    const ref = rest?.split("\0")[0]?.trim();
    if (sha !== undefined && ref === MAIN_REF) return sha;
  }
  return ZERO_OID;
}

/** Creates every directory `filepath` needs under `dir`, one segment at a
 *  time -- lightning-fs's `mkdir` is not recursive, and this must work for
 *  a plain `node:fs`-shaped backend too. */
async function ensureParentDirs(fs: GitFsBackend["fs"], dir: string, filepath: string): Promise<void> {
  const segments = filepath.split("/").slice(0, -1);
  let current = dir;
  for (const segment of segments) {
    current = `${current}/${segment}`;
    try {
      await fs.promises.mkdir(current);
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || (cause as { code?: string }).code !== "EEXIST") throw cause;
    }
  }
}

/** The isomorphic-git-shaped filesystem client `pushSourceTree` commits
 *  into. Defaults to an in-browser lightning-fs; a Node caller (e.g.
 *  `scripts/pack-registry-asset.ts`, which drives the same installer path
 *  outside a browser) passes real `node:fs` instead -- isomorphic-git only
 *  needs the promise API either one already exposes, and this package
 *  itself never imports `node:fs`. */
export type GitFsBackend = { fs: PromiseFsClient; dir: string };

/** A minimal `fetch`-shaped function, deliberately narrower than the global
 *  `typeof fetch` (whose Bun/DOM overloads carry extra members like
 *  `preconnect` a plain in-process adapter -- `hub().app.fetch` in
 *  `scripts/pack-registry-asset.ts` -- does not have). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function browserFsBackend(): GitFsBackend {
  return { fs: new LightningFS(`solutions-builder-push-${crypto.randomUUID()}`, { wipe: true }), dir: "/repo" };
}

/** Commits `tree` (repo-relative paths, may be nested) on top of the asset's
 *  current `main` and pushes it. Returns the new commit sha. */
export async function pushSourceTree(args: {
  url: string;
  token: string;
  tree: Readonly<Record<string, string>>;
  message: string;
  fsBackend?: GitFsBackend;
  /** The `fetch` the smart-HTTP exchange rides. Defaults to the global one
   *  (a browser tab or a real remote hub); an embedded Node caller
   *  (`scripts/pack-registry-asset.ts`) passes the mounted hub's own
   *  in-process `app.fetch`, since there is no listening socket to dial. */
  fetchImpl?: FetchLike;
}): Promise<string> {
  const { fs, dir } = args.fsBackend ?? browserFsBackend();
  const fetchImpl = args.fetchImpl ?? fetch;
  // `dir` may already exist (a Node caller's own temp directory); only the
  // browser backend's fresh in-memory filesystem needs it created here.
  try {
    await fs.promises.mkdir(dir);
  } catch (cause) {
    if (!(cause instanceof Error) || !("code" in cause) || (cause as { code?: string }).code !== "EEXIST") throw cause;
  }
  await git.init({ fs, dir, defaultBranch: "main" });
  for (const [filepath, contents] of Object.entries(args.tree)) {
    if (filepath.startsWith("/") || filepath.split("/").includes("..")) {
      throw new GitPushError(`refusing to push ${JSON.stringify(filepath)}: entries must stay inside the tree`);
    }
    await ensureParentDirs(fs, dir, filepath);
    await fs.promises.writeFile(`${dir}/${filepath}`, contents, "utf8");
    await git.add({ fs, dir, filepath });
  }
  const oldSha = await advertisedMainSha(args.url, args.token, fetchImpl);
  const sha = await git.commit({
    fs,
    dir,
    message: args.message,
    author: COMMIT_AUTHOR,
    parent: oldSha === ZERO_OID ? [] : [oldSha],
  });

  // Every object the new commit introduces: walk the whole tree rather than
  // just its top level, since the lifecycle's tree is nested several
  // directories deep.
  const oids = new Set<string>([sha]);
  const stack = [(await git.readCommit({ fs, dir, oid: sha })).commit.tree];
  while (stack.length > 0) {
    const treeOid = stack.pop()!;
    oids.add(treeOid);
    const { tree } = await git.readTree({ fs, dir, oid: treeOid });
    for (const entry of tree) {
      oids.add(entry.oid);
      if (entry.type === "tree") stack.push(entry.oid);
    }
  }
  const { packfile } = await git.packObjects({ fs, dir, oids: [...oids] });
  if (packfile === undefined) throw new GitPushError("packObjects returned no packfile");

  const command = pktLine(`${oldSha} ${sha} ${MAIN_REF}\0report-status\n`);
  const body = new Uint8Array(command.length + 4 + packfile.length);
  body.set(command, 0);
  body.set(new TextEncoder().encode("0000"), command.length);
  body.set(packfile, command.length + 4);
  const response = await fetchImpl(`${args.url}/git-receive-pack`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.token}`,
      "content-type": "application/x-git-receive-pack-request",
    },
    body,
  });
  if (!response.ok) {
    throw new GitPushError(`git push failed: HTTP ${String(response.status)}`);
  }
  const report = readPktLines(new Uint8Array(await response.arrayBuffer()));
  const refusal = report.find(
    (line) => line.startsWith("ng ") || (line.startsWith("unpack ") && line.trim() !== "unpack ok"),
  );
  if (refusal !== undefined) {
    throw new GitPushError(`git push was refused: ${refusal.trim()}`);
  }
  if (!report.some((line) => line.trim() === `ok ${MAIN_REF}`)) {
    throw new GitPushError(`git push reported no result for ${MAIN_REF}`);
  }
  return sha;
}
