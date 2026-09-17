/*
 * End-to-end formula-recognition check against a real textbook page:
 * render the page -> detect display_formula regions with the same layout
 * model the app uses -> re-render each region from the PDF at 300dpi (not
 * cropped from the lower-dpi layout raster -- research/15-formula-
 * recognition.md section 2 measured that this matters) -> recognize.
 *
 *   node scripts/textbook-formula-check.mjs <book.pdf> <page-number-1-based>
 *
 * Needs PyMuPDF: pip install --user pymupdf  (or --break-system-packages
 * --user if your distro's pip refuses otherwise -- e.g. Fedora).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as layout from "../electron/layout.js";
import { recognize } from "../electron/formula.js";

const here = dirname(fileURLToPath(import.meta.url));
const PY = join(here, "pdf_render.py");
const LAYOUT_DPI = 200; // matches research/15's own methodology
const CROP_DPI = 300;
const PAD_PT = 3;

const [pdfPath, pageArg] = process.argv.slice(2);
if (!pdfPath || !pageArg) {
  console.error("usage: node scripts/textbook-formula-check.mjs <book.pdf> <page-number-1-based>");
  process.exit(1);
}
const pageNum0 = Number(pageArg) - 1;

const work = mkdtempSync(join(tmpdir(), "blitz-formula-check-"));
try {
  // 1. Render the full page at 200dpi -- what the layout model sees.
  const fullPng = join(work, "page.png");
  const [rw, rh] = execFileSync("python3", [PY, "page-full", pdfPath, String(pageNum0), String(LAYOUT_DPI), fullPng])
    .toString().trim().split(" ").map(Number);
  console.log(`Rendered page ${pageArg} at ${LAYOUT_DPI}dpi: ${rw}x${rh}px`);

  // 2. Layout detection -- the same PP-DocLayoutV2 call the app makes.
  console.log("Loading layout model (first call is slower -- downloads/warms the model)...");
  const boxes = await layout.analyze(readFileSync(fullPng));
  const formulaBoxes = boxes.filter((b) => b.label === "display_formula");
  console.log(`${boxes.length} regions detected, ${formulaBoxes.length} display_formula`);
  if (formulaBoxes.length === 0) {
    console.log("No display_formula regions on this page. Labels found:", [...new Set(boxes.map((b) => b.label))]);
    process.exit(0);
  }

  // 3. For each: convert the 200dpi-pixel box to PDF points, pad, and
  // re-render THAT region straight from the PDF at 300dpi.
  for (const [i, region] of formulaBoxes.entries()) {
    const [x1, y1, x2, y2] = region.box;
    const toPt = (px) => (px / LAYOUT_DPI) * 72;
    const px0 = toPt(x1) - PAD_PT, py0 = toPt(y1) - PAD_PT;
    const px1 = toPt(x2) + PAD_PT, py1 = toPt(y2) + PAD_PT;

    const cropPng = join(work, `crop-${i}.png`);
    const [cw, ch] = execFileSync("python3", [
      PY, "page-clip", pdfPath, String(pageNum0),
      String(px0), String(py0), String(px1), String(py1), String(CROP_DPI), cropPng,
    ]).toString().trim().split(" ").map(Number);

    console.log(`\n--- region ${i + 1}/${formulaBoxes.length} --- score=${region.score?.toFixed(2)} crop=${cw}x${ch}px`);
    const result = await recognize(readFileSync(cropPng), { width: cw, height: ch });
    if (result.ok) {
      console.log("LaTeX: ", result.latex);
      console.log("Speech:", result.speech);
    } else {
      console.log("Rejected:", result.reason);
      if (result.latex) console.log("  (recovered LaTeX before rejection:", result.latex, ")");
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
