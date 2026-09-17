/*
 * LaTeX -> (MathML, spoken text) in the Electron main process.
 *
 * This is the piece research/15-formula-recognition.md flagged as unexplored
 * "fog": the recogniser (formula.js) proves equation *content* is recoverable,
 * but never asks whether it can be *spoken*. It can. KaTeX already renders
 * every recovered LaTeX string to MathML for free (§7 of that ticket), and
 * MathJax's Speech Rule Engine (Apache-2.0) -- the same engine behind
 * MathJax's own accessibility mode -- turns MathML into natural spoken
 * English. Both are plain npm packages, nothing HuggingFace-hosted, nothing
 * that needs a model export.
 *
 * Verified directly in this repo's sandbox (not just read about):
 *   katex.renderToString('\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}', {output:'mathml'})
 *   -> sre.toSpeech(...) ->
 *   "the fraction with numerator negative b plus or minus the square root of
 *    b squared minus 4 a c and denominator 2 a"                 (clearspeak)
 * against several of the exact equation shapes research/15 tested on
 * Millington (fractions, powers, bold vectors, matrices). See toSpeech's own
 * jsdoc below for the full test transcript.
 *
 * KaTeX's throwOnError doubles as the parse-gate research/15 §3 and §10
 * require before anything reaches the screen: a malformed LaTeX string from
 * the recogniser throws here rather than rendering "Iboldsymbol" over a page.
 */
import katex from "katex";
// speech-rule-engine is CJS with a dynamically-assigned exports object, so
// Node's ESM/CJS interop only synthesises a `default`, not named exports
// (verified in this sandbox -- `import * as sre` leaves sre.setupEngine
// undefined even though sre.default.setupEngine exists).
import sreDefault from "speech-rule-engine";
const sre = sreDefault;

let engineReady = null;

// clearspeak reads more like natural prose than mathspeak's "StartFraction
// ... EndFraction" scaffolding, which matters more here than for a sighted
// screen-reader user: this is going through Kokoro as a spoken sentence,
// not read by someone who can also see the braille-like structure markers.
function ensureEngine() {
  if (!engineReady) {
    engineReady = sre.setupEngine({
      domain: "clearspeak",
      style: "default",
      markup: "none",
      locale: "en",
    });
  }
  return engineReady;
}

/**
 * @param {string} latex
 * @returns {Promise<{ok: true, mathml: string, speech: string} | {ok: false, error: string}>}
 *
 * Actual output, verified by running `node scripts/mathspeech-check.mjs` in
 * this sandbox (clearspeak, this module's fixed domain):
 *   "v = \\lim_{\\Delta t \\to 0} \\frac{\\Delta p}{\\Delta t}"
 *     -> "v equals lim over normal triangle t right arrow 0 of normal
 *         triangle p over normal triangle t"
 *   "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}"
 *     -> "the fraction with numerator negative b plus or minus the square
 *         root of b squared minus 4 a c and denominator 2 a"
 *   "x^2 + 3x - 5"          -> "x squared plus 3 x minus 5"
 *   "\\boldsymbol{p}"       -> "bold italic p"
 *   "\\begin{bmatrix} 1 & 0 \\\\ 0 & 1 \\end{bmatrix}"
 *     -> "the 2 by 2 matrix Row 1: 1 0 Row 2: 0 1"    (matrices are exactly
 *         the shape research/15 §3 found both recognisers degrade on, so
 *         pace this one especially carefully if it is ever spoken)
 *
 * One real caveat the test surfaced: clearspeak reads capital Δ as
 * "triangle" (the geometric shape), not "delta" -- correct for an actual
 * triangle, wrong for the calculus convention this textbook uses it in. A
 * physics/calculus-flavoured locale rule would need to override that; not
 * done here.
 *
 * A second caveat the test surfaced deliberately: feeding it research/15
 * §7's "confident nonsense" case -- LaTeX generated from a page the layout
 * model *mislabelled* as a formula -- produces well-formed speech, not a
 * rejection. katex's parse gate only catches malformed LaTeX, not wrong-but-
 * syntactically-valid LaTeX. formula.js's token-cap-hit and region-shape
 * checks (research/15 §7's other two mitigations) are what has to catch that
 * case; this function alone cannot.
 */
export async function renderFormula(latex) {
  await ensureEngine();
  let mathml;
  try {
    // mathml output + throwOnError is the free syntax gate research/15 §3
    // measured catching malformed recogniser output before it renders.
    mathml = katex.renderToString(latex, { output: "mathml", throwOnError: true });
  } catch (e) {
    return { ok: false, error: `katex: ${e.message}` };
  }
  const mathTag = mathml.match(/<math[\s\S]*?<\/math>/);
  if (!mathTag) return { ok: false, error: "katex produced no <math> element" };

  let speech;
  try {
    speech = sre.toSpeech(mathTag[0]);
  } catch (e) {
    return { ok: false, error: `speech-rule-engine: ${e.message}` };
  }
  if (!speech || !speech.trim()) return { ok: false, error: "empty speech output" };

  return { ok: true, mathml: mathTag[0], speech };
}

/*
 * Sub-expression-level highlighting (spotlighting the numerator, then the
 * denominator, as each is spoken) is one step further than this ticket
 * needs and is NOT wired up anywhere yet -- flagging the path for later
 * rather than building it blind:
 *
 *   const enriched = await sre.toEnriched(mathTag[0]);   // MathML annotated
 *     // with data-semantic-id / data-semantic-children per node
 *   const struct = sre.toSpeechStructure(mathTag[0]);     // { [nodeId]: {
 *     // "speech-none": "...", ... } } -- per-node speech fragments, keyed
 *     // by the same ids as the enriched MathML's data-semantic-id
 *
 * Rendering the enriched MathML (instead of plain KaTeX output) and keeping
 * the id attributes in the DOM would give real per-node screen coordinates
 * to highlight against, walked in the same order sre.walk() steps a screen
 * reader through the expression. Both calls were smoke-tested in this
 * sandbox and return real per-node data -- this is a wiring task, not a
 * research one, whenever sub-expression highlighting is worth the extra UI.
 */
