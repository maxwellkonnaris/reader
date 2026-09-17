/*
 * Manual check for electron/formula.js against a real display-equation
 * crop, once `npm run setup:formula` has actually downloaded the weights
 * (not possible in the sandbox that wrote this file -- huggingface.co was
 * blocked there; see formula.js's top comment).
 *
 *   node scripts/formula-check.mjs path/to/crop.png [width height]
 *
 * On first run this also prints the encoder/decoder's real input and output
 * tensor names and the tokenizer's real special-token ids -- exactly the
 * information needed to fix any VERIFY-ON-DEVICE guess in formula.js if
 * recognition comes back wrong or throws.
 */
import { readFileSync } from "node:fs";
import { recognize } from "../electron/formula.js";

const [path, w, h] = process.argv.slice(2);
if (!path) {
  console.error("usage: node scripts/formula-check.mjs <crop.png> [width height]");
  process.exit(1);
}

const png = readFileSync(path);
const size = w && h ? { width: Number(w), height: Number(h) } : undefined;

const result = await recognize(png, size);
if (result.ok) {
  console.log("LaTeX: ", result.latex);
  console.log("Speech:", result.speech);
} else {
  console.log("Rejected:", result.reason);
  if (result.latex) console.log("  (recovered LaTeX before rejection:", result.latex, ")");
}
