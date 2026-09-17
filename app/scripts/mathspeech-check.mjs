/*
 * Standalone check for electron/mathspeech.js -- no Electron, no models,
 * just katex + speech-rule-engine against the equation shapes
 * research/15-formula-recognition.md measured pix2text-mfr recovering from
 * real Millington pages. Run: node scripts/mathspeech-check.mjs
 */
import { renderFormula } from "../electron/mathspeech.js";

const cases = [
  "v = \\lim_{\\Delta t \\to 0} \\frac{\\Delta p}{\\Delta t}",
  "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
  "x^2 + 3x - 5",
  "\\boldsymbol{p}",
  "\\begin{bmatrix} 1 & 0 \\\\ 0 & 1 \\end{bmatrix}",
  // A malformed string shaped like the confident-nonsense failure mode
  // research/15 §7 measured from a mislabelled region -- must be rejected,
  // not spoken.
  "\\mathrm{IIain~alphibet}\\quad\\textrm{abcdelghijklmnopqrstuvwxyz}",
  // Genuinely broken LaTeX -- must be rejected by the katex gate.
  "\\frac{1}{",
];

let failed = 0;
for (const latex of cases) {
  const r = await renderFormula(latex);
  if (r.ok) {
    console.log(`ok    ${JSON.stringify(latex)}\n      -> ${r.speech}`);
  } else {
    console.log(`reject ${JSON.stringify(latex)}\n      -> ${r.error}`);
  }
}

// The two "must be rejected" cases above: the alphabet one is well-formed
// LaTeX (katex accepts it fine, same as research/15 measured) so the katex
// gate alone does NOT catch it -- that one needs the token-cap/region-shape
// heuristics research/15 §7 recommends at the formula.js layer, not here.
// This script only asserts the genuinely malformed LaTeX is rejected.
const brokenResult = await renderFormula("\\frac{1}{");
if (brokenResult.ok) {
  console.error("\nFAIL: malformed LaTeX was not rejected");
  failed++;
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
