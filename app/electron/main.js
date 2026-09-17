/*
 * Blitz — Electron main process.
 *
 * Why Electron: the whole premise of this app is that the page you look at is
 * the real PDF, rendered by PDF.js at native fidelity with an overlay on top.
 * That is a browser-engine job, and Electron is the browser engine we already
 * validated against. It also gives the two models a native Node process to
 * run in (onnxruntime-node, not WASM), which is what made layout analysis
 * usable at all -- see electron/layout.js.
 *
 * Both models run here, in this process. The renderer talks to them over IPC
 * (see preload.cjs); nothing listens on a public port.
 */
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

import * as layout from "./layout.js";
import * as net from "./net.js";
import * as library from "./library.js";
import * as tts from "./tts.js";
import * as formula from "./formula.js";

const here = dirname(fileURLToPath(import.meta.url));
// The speech engine is a separate process, and Python cannot read a file from
// inside the asar archive -- so tts_server.py is listed in build.asarUnpack and
// read from the unpacked tree beside it.
const TTS_SCRIPT = join(here, "tts_server.py").replace(
  `${sep}app.asar${sep}`,
  `${sep}app.asar.unpacked${sep}`,
);

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 960,
    backgroundColor: "#1a1a1e",
    show: false,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload uses require(); nothing else crosses the bridge
    },
  });
  win.once("ready-to-show", () => win.show());
  // `npm run dev` points at the Vite dev server for hot reload; a packaged app
  // loads the bundle Vite built (see scripts/dev.mjs and vite.config.js).
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(join(here, "../dist/renderer/index.html"));
  }

  /*
   * Full screen has to be escapable from inside the app.
   *
   * The window's own chrome is what you would normally use to leave it, and
   * full screen is exactly the state that takes the chrome away -- so the
   * way out has to come from the page. The renderer binds Escape and F11 to
   * these, and shows a reminder when it is told the state changed.
   */
  win.on("enter-full-screen", () => win.webContents.send("win:fullscreen", true));
  win.on("leave-full-screen", () => win.webContents.send("win:fullscreen", false));

  // External links open in the user's browser, never in the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

ipcMain.handle("tts:synthesize", (_e, payload) => tts.synthesize(payload));
ipcMain.handle("tts:voices", () => tts.voices());
ipcMain.handle("tts:status", () => tts.status());
ipcMain.handle("layout:analyze", (_e, png) => layout.analyze(Buffer.from(png)));
ipcMain.handle("layout:ready", () => layout.isReady());

// display_formula regions only -- see electron/formula.js's top comment for
// why inline_formula is out of scope. `size` is the crop's own pixel
// dimensions, used for the region-shape sanity check before anything is
// spent on recognition.
ipcMain.handle("formula:recognize", (_e, png, size) => formula.recognize(Buffer.from(png), size));
ipcMain.handle("formula:ready", () => formula.isReady());
ipcMain.handle("formula:available", () => formula.isAvailable());

// The library lives in the main process because it has to outlive the
// renderer's storage; see electron/library.js for why.
ipcMain.handle("library:list", () => library.list());
ipcMain.handle("library:remember", (_e, meta) => library.remember(meta));
ipcMain.handle("library:position", (_e, pos) => library.savePosition(pos));
ipcMain.handle("library:notes", (_e, payload) => library.saveNotes(payload));
ipcMain.handle("library:forget", (_e, id) => library.forget(id));
ipcMain.handle("library:open", (_e, id) => library.open(id));
ipcMain.handle("library:rememberSite", (_e, meta) => library.rememberSite(meta));

// Fetching a documentation site has to happen out here: the renderer is a
// file:// page and every cross-origin request it makes is blocked. Bytes come
// back, nothing else -- see electron/net.js.
ipcMain.handle("net:fetch", (_e, url, opts) => net.fetchResource(url, opts));

ipcMain.handle("win:fullscreen", (_e, want) => {
  if (!win) return false;
  const next = want === undefined || want === null ? !win.isFullScreen() : !!want;
  win.setFullScreen(next);
  return next;
});

app.whenReady().then(() => {
  createWindow();
  // Both models load in the background; the UI is usable before either is up.
  tts.start(TTS_SCRIPT).catch((e) => console.error("[tts]", e.message));
  // Optional: only warm the formula engine if `npm run setup:formula` has
  // been run. Silently absent otherwise -- display equations are additive
  // (see formula.js and research/15-formula-recognition.md §10), so a reader
  // with no formula weights installed just never gets the popover, same as
  // today.
  if (formula.isAvailable()) {
    formula.warm().catch((e) => console.error("[formula]", e.message));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  tts.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => tts.stop());

process.on("uncaughtException", (e) => {
  console.error("[main] uncaught:", e);
  if (win) dialog.showErrorBox("Blitz", String(e?.stack ?? e));
});
