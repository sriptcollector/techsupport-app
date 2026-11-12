// Our own Windows release build, on this PC, at no cost (replaces the GitHub Actions Windows job).
//   node scripts/build-windows.mjs            -> builds HEAD into release-out/<version>/
// Same steps as .github/workflows/release.yml: unit tests, signed NSIS build, .sig and .sha256.
// The updater key is read from Secret Manager into this process only; it is never printed or written.
import { execSync } from "node:child_process";
import { copyFileSync, createReadStream, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const app = join(root, "app");
const run = (cmd, cwd, env = process.env) => execSync(cmd, { cwd, env, stdio: "inherit", shell: true });

if (execSync("git status --porcelain", { cwd: root }).toString().trim()) throw new Error("commit first: the build must match a commit");
const version = JSON.parse(readFileSync(join(app, "src-tauri", "tauri.conf.json"), "utf8")).version;
const sha = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
console.log(`building Tech Support ${version} (${sha}) for Windows`);

run("bun install --frozen-lockfile", app);
run("cargo test --lib", join(app, "src-tauri"));

const key = execSync("gcloud secrets versions access latest --secret=TECHSUPPORT_UPDATER_PRIVATE_KEY --project=westward-apps-prod", { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
run("node_modules\\.bin\\tauri build --bundles nsis", app, { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" });

const nsis = join(app, "src-tauri", "target", "release", "bundle", "nsis");
const exe = readdirSync(nsis).find((f) => f.includes(version) && f.endsWith("-setup.exe"));
if (!exe) throw new Error(`no ${version} installer in ${nsis}`);
const out = join(root, "release-out", `v${version}`);
mkdirSync(out, { recursive: true });
copyFileSync(join(nsis, exe), join(out, "Tech-Support-Setup.exe"));
copyFileSync(join(nsis, `${exe}.sig`), join(out, "Tech-Support-Setup.exe.sig"));
const h = createHash("sha256");
for await (const c of createReadStream(join(out, "Tech-Support-Setup.exe"))) h.update(c);
writeFileSync(join(out, "Tech-Support-Setup.exe.sha256"), `${h.digest("hex")}  Tech-Support-Setup.exe\n`);
writeFileSync(join(out, "BUILD.txt"), `version ${version}\ncommit ${sha}\nbuilt ${new Date().toISOString()} on ${process.env.COMPUTERNAME ?? "this PC"}\n`);
console.log(`done: ${out}\nnext: node ../techsupport/deploy/publish.mjs v${version} --test --from "${out}"`);
