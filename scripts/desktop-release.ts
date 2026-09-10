/**
 * Builds the desktop app and records what shipped. Signing and notarisation
 * happen only when Apple's own env contract is fully present
 * (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` —
 * the variables `tauri build` itself reads for macOS); tauri-cli reads them
 * directly, this script never forwards secrets on the command line. Either
 * way, `release/RELEASE.md` and `release/SHA256SUMS` record what was actually
 * verified — never claim signed/notarised without a zero exit from the
 * verification commands.
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

const root = join(import.meta.dir, "..");
const desktopDir = join(root, "apps", "desktop");
const releaseDir = join(root, "release");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const targetIndex = args.indexOf("--target");
const target = targetIndex !== -1 ? args[targetIndex + 1] : undefined;

const REQUIRED_ENV = ["APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID"] as const;
const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
const wantsSigning = missing.length === 0;

type SigningStatus = "signed-and-notarised" | "signed-not-notarised" | "unsigned";

async function run(command: string[], cwd: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { status, stdout, stderr };
}

function bundleDirs(): { app: string; dmg: string } {
  const bundleRoot = target
    ? join(desktopDir, "target", target, "release", "bundle")
    : join(desktopDir, "target", "release", "bundle");
  return { app: join(bundleRoot, "macos"), dmg: join(bundleRoot, "dmg") };
}

async function findArtifact(dir: string, extension: string): Promise<string | undefined> {
  const entries = await readdir(dir).catch(() => [] as string[]);
  return entries.find((entry) => entry.endsWith(extension));
}

async function sha256(path: string): Promise<string> {
  const hasher = createHash("sha256");
  hasher.update(new Uint8Array(await Bun.file(path).arrayBuffer()));
  return hasher.digest("hex");
}

async function gitSha(): Promise<string> {
  const { stdout } = await run(["git", "rev-parse", "HEAD"], root);
  return stdout.trim();
}

async function tauriVersion(): Promise<string> {
  const { stdout } = await run(["bunx", "@tauri-apps/cli@2", "--version"], desktopDir);
  return stdout.trim();
}

if (dryRun) {
  // Notarisation can still fail verification even with every variable present,
  // so the best a dry run can promise is "signed-and-notarised" as the target
  // status, not a guarantee.
  const plannedStatus: SigningStatus = wantsSigning ? "signed-and-notarised" : "unsigned";
  console.log(`Plan: ${wantsSigning ? "signed + notarised" : "unsigned"} build${target ? ` (target ${target})` : ""}`);
  if (!wantsSigning) {
    console.log(`Missing env: ${missing.join(", ")}`);
  }
  console.log(`Would record signing status: ${plannedStatus}`);
  console.log(`Would write ${join(releaseDir, "RELEASE.md")} and ${join(releaseDir, "SHA256SUMS")}`);
  process.exit(0);
}

const buildCommand = ["bunx", "@tauri-apps/cli@2", "build", ...(target ? ["--target", target] : [])];
console.log(`Running: ${buildCommand.join(" ")}`);
const build = Bun.spawn(buildCommand, { cwd: desktopDir, stdout: "inherit", stderr: "inherit", env: process.env });
const buildStatus = await build.exited;
if (buildStatus !== 0) {
  throw new Error(`tauri build failed (${buildStatus}).`);
}

const dirs = bundleDirs();
const appName = await findArtifact(dirs.app, ".app");
const dmgName = await findArtifact(dirs.dmg, ".dmg");
if (!appName || !dmgName) {
  throw new Error(`Expected .app in ${dirs.app} and .dmg in ${dirs.dmg} after build.`);
}
const appPath = join(dirs.app, appName);
const dmgPath = join(dirs.dmg, dmgName);

let status: SigningStatus = "unsigned";
let reason = missing.length > 0 ? `missing env: ${missing.join(", ")}` : "";

if (wantsSigning) {
  const codesignVerify = await run(["codesign", "--verify", "--deep", "--strict", appPath], root);
  const spctlVerify = await run(["spctl", "-a", "-vv", appPath], root);
  const staplerVerify = await run(["xcrun", "stapler", "validate", dmgPath], root);

  if (codesignVerify.status !== 0) {
    reason = `codesign --verify failed: ${codesignVerify.stderr.trim() || codesignVerify.stdout.trim()}`;
  } else if (spctlVerify.status !== 0) {
    reason = `spctl -a -vv failed: ${spctlVerify.stderr.trim() || spctlVerify.stdout.trim()}`;
  } else if (staplerVerify.status !== 0) {
    status = "signed-not-notarised";
    reason = `xcrun stapler validate failed: ${staplerVerify.stderr.trim() || staplerVerify.stdout.trim()}`;
  } else {
    status = "signed-and-notarised";
    reason = "";
  }
}

const du = await run(["du", "-sk", appPath], root);
const appSizeBytes = Number(du.stdout.trim().split(/\s+/)[0] ?? "0") * 1024;
const dmgSize = Bun.file(dmgPath).size;
const dmgSha = await sha256(dmgPath);

await mkdir(releaseDir, { recursive: true });

const bunVersion = Bun.version;
const tauriCliVersion = await tauriVersion();
const sha = await gitSha();

const releaseMd = `# Release

- App: \`${appName}\` (${appSizeBytes} bytes)
- Dmg: \`${dmgName}\` (${dmgSize} bytes)
- SHA-256 (dmg): \`${dmgSha}\`
- Signing status: **${status}**${reason ? ` — ${reason}` : ""}
- Bun: ${bunVersion}
- Tauri CLI: ${tauriCliVersion}
- Git sha: ${sha}
`;

await writeFile(join(releaseDir, "RELEASE.md"), releaseMd);
await writeFile(join(releaseDir, "SHA256SUMS"), `${dmgSha}  ${dmgName}\n`);

console.log(`Signing status: ${status}${reason ? ` (${reason})` : ""}`);
console.log(`Wrote ${join(releaseDir, "RELEASE.md")}`);
