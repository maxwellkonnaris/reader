/*
 * End-to-end formula-recognition check against a real textbook page:
 * render the page -> detect display_formula regions with the same layout
 * model the app uses -> re-render each region from the PDF at 300dpi (not
 * cropped from the lower-dpi layout raster -- research/15-formula-
 * recognition.md section 2 measured that this matters) -> recognize.
 *
 *   node scripts/textbook-formula-check.mjs <book.pdf> <page>
 *   node scripts/textbook-formula-check.mjs <book.pdf> <start-page> <end-page>
 *
 * Both page numbers are 1-based and inclusive. With a range, pages that
 * have no display_formula region print one summary line and move on --
 * only pages that actually have one get the full crop+recognize treatment.
 * Most pages in a book have zero equations (research/15's own Millington
 * sample: 11 of 18 sampled pages had none), so scanning a range is the
 * practical way to find one instead of guessing page numbers by hand.
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

const [pdfPath, startArg, endArg] = process.argv.slice(2);
if (!pdfPath || !startArg) {
  console.error("usage: node scripts/textbook-formula-check.mjs <book.pdf> <page> [end-page]");
  process.exit(1);
}
const startPage = Number(startArg);
const endPage = endArg ? Number(endArg) : startPage;

const work = mkdtempSync(join(tmpdir(), "blitz-formula-check-"));
try {
  let totalFound = 0;
  for (let page = startPage; page <= endPage; page++) {
    const pageNum0 = page - 1;

    // 1. Render the full page at 200dpi -- what the layout model sees.
    const fullPng = join(work, `page-${page}.png`);
    let rw, rh;
    try {
      [rw, rh] = execFileSync("python3", [PY, "page-full", pdfPath, String(pageNum0), String(LAYOUT_DPI), fullPng])
        .toString().trim().split(" ").map(Number);
    } catch (e) {
      console.log(`page ${page}: could not render (past end of document?) -- stopping. ${e.message.split("\n")[0]}`);
      break;
    }

    // 2. Layout detection -- the same PP-DocLayoutV2 call the app makes.
    if (page === startPage) console.log("Loading layout model (first call is slower -- downloads/warms the model)...");
    const boxes = await layout.analyze(readFileSync(fullPng));
    const formulaBoxes = boxes.filter((b) => b.label === "display_formula");

    if (formulaBoxes.length === 0) {
      console.log(`page ${page}: ${rw}x${rh}px, ${boxes.length} regions, 0 display_formula (${[...new Set(boxes.map((b) => b.label))].join(", ") || "empty page"})`);
      continue;
    }

    totalFound += formulaBoxes.length;
    console.log(`\npage ${page}: ${formulaBoxes.length} display_formula region(s) found`);

    // 3. For each: convert the 200dpi-pixel box to PDF points, pad, and
    // re-render THAT region straight from the PDF at 300dpi.
    for (const [i, region] of formulaBoxes.entries()) {
      const [x1, y1, x2, y2] = region.box;
      const toPt = (px) => (px / LAYOUT_DPI) * 72;
      const px0 = toPt(x1) - PAD_PT, py0 = toPt(y1) - PAD_PT;
      const px1 = toPt(x2) + PAD_PT, py1 = toPt(y2) + PAD_PT;

      const cropPng = join(work, `crop-${page}-${i}.png`);
      const [cw, ch] = execFileSync("python3", [
        PY, "page-clip", pdfPath, String(pageNum0),
        String(px0), String(py0), String(px1), String(py1), String(CROP_DPI), cropPng,
      ]).toString().trim().split(" ").map(Number);

      console.log(`  --- region ${i + 1}/${formulaBoxes.length} --- score=${region.score?.toFixed(2)} crop=${cw}x${ch}px`);
      const result = await recognize(readFileSync(cropPng), { width: cw, height: ch });
      if (result.ok) {
        console.log("  LaTeX: ", result.latex);
        console.log("  Speech:", result.speech);
      } else {
        console.log("  Rejected:", result.reason);
        if (result.latex) console.log("    (recovered LaTeX before rejection:", result.latex, ")");
      }
    }
  }
  if (endPage > startPage) console.log(`\nScanned pages ${startPage}-${endPage}: ${totalFound} display_formula region(s) total.`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
