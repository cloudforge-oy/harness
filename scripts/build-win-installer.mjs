/**
 * Compile the Windows NSIS installer from dist/win-unpacked using the native
 * (non-wine) makensis that electron-builder caches, so the installer can be
 * produced on Linux/macOS too. Run after `electron-builder --win` has
 * populated dist/win-unpacked (the dist:win npm script chains this).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version, build } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

const sourceDir = path.join(root, "dist", "win-unpacked");
if (!fs.existsSync(path.join(sourceDir, "Harness.exe"))) {
  console.error(`${sourceDir} is missing — run \`npm run dist:win\` (electron-builder) first.`);
  process.exit(1);
}

// Prefer electron-builder's cached NSIS bundle (downloaded by any --win build);
// fall back to a system makensis if one is installed.
function findMakensis() {
  const cacheRoot = process.env.ELECTRON_BUILDER_CACHE ?? path.join(os.homedir(), ".cache", "electron-builder");
  const platformDir = { linux: "linux", darwin: "mac", win32: "Bin" }[process.platform];
  if (fs.existsSync(cacheRoot)) {
    for (const bundle of fs.readdirSync(cacheRoot).filter((d) => d.startsWith("nsis-")).sort().reverse()) {
      if (bundle.startsWith("nsis-resources")) continue;
      for (const inner of fs.readdirSync(path.join(cacheRoot, bundle))) {
        const nsisDir = path.join(cacheRoot, bundle, inner);
        const bin = path.join(nsisDir, platformDir, process.platform === "win32" ? "makensis.exe" : "makensis");
        if (fs.existsSync(bin) && fs.existsSync(path.join(nsisDir, "Stubs"))) return { bin, nsisDir };
      }
    }
  }
  return { bin: "makensis", nsisDir: null }; // hope it's on PATH with its own data dir
}

const { bin, nsisDir } = findMakensis();
const outFile = path.join(root, "dist", `Harness-Setup-${version}.exe`);
const iconFile = path.join(root, build?.win?.icon?.replace(/\.png$/, ".ico") ?? "build/icon.ico");

console.log(`makensis: ${bin}`);
console.log(`building ${outFile} from ${sourceDir} ...`);

execFileSync(
  bin,
  [
    "-INPUTCHARSET", "UTF8",
    `-DVERSION=${version}`,
    `-DSOURCE_DIR=${sourceDir}`,
    `-DOUT_FILE=${outFile}`,
    `-DICON_FILE=${iconFile}`,
    path.join(root, "build", "installer.nsi"),
  ],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: nsisDir ? { ...process.env, NSISDIR: nsisDir } : process.env,
  },
);

console.log(`built ${outFile} (${(fs.statSync(outFile).size / 1024 / 1024).toFixed(0)} MB)`);
