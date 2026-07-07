/**
 * Render the app icon set from build/icon.html (vector art) via Electron:
 *   build/icons/<N>x<N>.png  for the hicolor sizes Linux desktops index
 *   build/icon.png           1024px master (Windows .ico source)
 *
 * hicolor's index.theme tops out at 512x512 — a lone 1024px icon is invisible
 * to GNOME's icon lookup (shows as a generic gear), which is why the deb needs
 * the full size set. Run with: npx electron scripts/build-icons.mjs
 */
import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  await mkdir(path.join(root, "build", "icons"), { recursive: true });

  // One window, loaded once at the master size; each capture just shrinks the
  // DOM (the SVG art scales losslessly) and grabs the top-left size x size rect.
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    useContentSize: true,
  });
  await win.loadFile(path.join(root, "build", "icon.html"));
  await new Promise((r) => setTimeout(r, 400));

  for (const size of [1024, ...SIZES]) {
    // IIFE: top-level const in executeJavaScript persists in the page's global
    // lexical scope, so a second call would throw a redeclaration SyntaxError.
    await win.webContents.executeJavaScript(`(() => {
      for (const el of [document.documentElement, document.body]) {
        el.style.width = el.style.height = "${size}px";
      }
      const svg = document.querySelector("svg");
      svg.setAttribute("width", "${size}");
      svg.setAttribute("height", "${size}");
    })()`);
    await new Promise((r) => setTimeout(r, 150));
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    const out = size === 1024
      ? path.join(root, "build", "icon.png")
      : path.join(root, "build", "icons", `${size}x${size}.png`);
    await writeFile(out, image.toPNG());
    console.log(`${out} (${size}px)`);
  }
  app.quit();
});
