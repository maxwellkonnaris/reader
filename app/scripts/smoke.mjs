/*
 * Startup smoke test: launch the packaged renderer inside Electron and assert
 * the window actually came up wired -- speech engine reachable, voice list
 * populated, no console errors. Drives the real app over CDP rather than
 * mocking, because everything interesting here is in the wiring.
 *
 *   npm run build && node scripts/smoke.mjs
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { writeFixturePdf } from "./fixture-pdf.mjs";

const PORT = Number(process.env.BLITZ_SMOKE_CDP_PORT || 9333);
// BLITZ_SMOKE_BIN points at a packaged build (release/linux-unpacked/blitz, or
// the AppImage). Worth running both ways: the asar-packed app has already
// diverged from the source tree once, when Python could not be read out of the
// archive and the shipped app had no voice.
const BIN = process.env.BLITZ_SMOKE_BIN;
// Electron's own sandbox refuses to start under a root UID (crbug.com/638180)
// -- true for CI containers and this repo's own dev sandbox alike. Opt in
// explicitly rather than always passing --no-sandbox, since that flag weakens
// the renderer sandbox and should not be the default for a real user's build.
const EXTRA_ARGS = process.env.BLITZ_SMOKE_NO_SANDBOX ? ["--no-sandbox"] : [];
const app = BIN
  ? spawn(BIN, [`--remote-debugging-port=${PORT}`, ...EXTRA_ARGS], { stdio: ["ignore", "pipe", "pipe"] })
  : spawn("npx", ["electron", ".", `--remote-debugging-port=${PORT}`, ...EXTRA_ARGS], {
      stdio: ["ignore", "pipe", "pipe"],
    });
const appLog = [];
app.stdout.on("data", (d) => appLog.push(String(d)));
app.stderr.on("data", (d) => appLog.push(String(d)));

const done = (code, msg) => {
  if (msg) console.log(msg);
  if (app.exitCode === null) app.kill("SIGTERM");
  process.exit(code);
};

async function target() {
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`, { signal: AbortSignal.timeout(800) });
      const [t] = (await res.json()).filter((t) => t.type === "page");
      if (t?.webSocketDebuggerUrl) return t;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  done(1, "FAIL: the window never opened");
}

const t = await target();
const ws = new WebSocket(t.webSocketDebuggerUrl);
const pending = new Map();
const errors = [];
let id = 0;

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

ws.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  } else if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  } else if (m.method === "Runtime.bindingCalled" && m.params.name === "__smokeReject") {
    errors.push(m.params.payload);
  } else if (m.method === "Runtime.exceptionThrown") {
    errors.push(m.params.exceptionDetails.text + " " + (m.params.exceptionDetails.exception?.description ?? ""));
  }
});

await new Promise((r) => ws.on("open", r));
await send("Runtime.enable");
await send("DOM.enable");
// Unhandled rejections don't surface as Runtime.exceptionThrown with a usable
// message -- PDF.js failures arrive minified as "Uncaught (in promise) Bs" --
// so listen for them in the page and read the real name off the reason.
await send("Runtime.addBinding", { name: "__smokeReject" });
await send("Runtime.evaluate", {
  expression: "addEventListener('unhandledrejection', (e) => " +
    "__smokeReject(`${e.reason?.name ?? 'rejection'}: ${e.reason?.message ?? e.reason}`))",
});

const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`${d.text} ${d.exception?.description ?? ""}`.trim());
  }
  return r.result.value;
};

// The engines load in the background; give them the same grace a reader would.
let status = null;
for (let i = 0; i < 60; i++) {
  status = await evaluate("window.blitz.ttsStatus()");
  if (status?.ok) break;
  await new Promise((r) => setTimeout(r, 1000));
}

// Open a real document. This is the check that was missing when a packaged
// build shipped with a Chromium too old for PDF.js 6 (no Uint8Array.toHex):
// the window came up perfectly, and every file silently did nothing.
const fixture = writeFixturePdf(join(tmpdir(), "blitz-smoke-fixture.pdf"));
const root = await send("DOM.getDocument", { depth: 1 });
const input = await send("DOM.querySelector", { nodeId: root.root.nodeId, selector: "#file" });
await send("DOM.setFileInputFiles", { files: [fixture], nodeId: input.nodeId });

let opened = null;
for (let i = 0; i < 40; i++) {
  // `rendered` is the honest signal: the canvas gets its width at the *start*
  // of paintCanvas, so polling canvas.width passes before PDF.js has drawn or
  // built a text layer at all.
  opened = await evaluate(
    "({ pages: document.querySelectorAll('.pdfpage').length," +
    "   rendered: !!window.__spike?.pages.get(1)?.rendered," +
    "   words: document.querySelectorAll('.textLayer span').length })",
  );
  if (opened.pages > 0 && opened.rendered) break;
  await new Promise((r) => setTimeout(r, 500));
}

const checks = [
  ["speech engine ready", status?.ok, status?.error],
  ["voice list populated", await evaluate("document.getElementById('voice').options.length > 1"), "voice <select> is empty"],
  ["viewer mounted", await evaluate("!!document.getElementById('pages')"), "#pages missing"],
  ["layout model reachable", typeof (await evaluate("window.blitz.layoutReady()")) === "boolean", "layoutReady did not answer"],
  ["PDF opens", opened?.pages > 0, "the file input accepted a PDF and no page appeared"],
  ["first page renders", opened?.rendered, "page 1 never finished rasterising"],
  ["text layer has words", opened?.words > 0, "no spans in the text layer — nothing to highlight"],
  ["no console errors", errors.length === 0, errors.join(" | ")],
];

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failed++;
}
if (failed && appLog.length) console.log("\n--- app output ---\n" + appLog.join("").split("\n").filter((l) => !l.includes("onnxruntime:")).join("\n"));
done(failed ? 1 : 0, failed ? `\n${failed} check(s) failed` : "\nall checks passed");
