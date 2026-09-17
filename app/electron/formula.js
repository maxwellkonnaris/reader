/*
 * Display-equation recognition (pix2text-mfr) in the Electron main process.
 *
 * Follows research/15-formula-recognition.md's answer exactly:
 * breezedeus/pix2text-mfr, a TrOCR-shaped encoder/decoder (DeiT-384 encoder,
 * 6-layer 256-d cache-free decoder, ~1200-token vocab), MIT code and MIT
 * weights, run as two plain ONNX files under onnxruntime-node -- no Python,
 * no PaddlePaddle, no wrapper package. Measured there at ~500ms/equation on
 * CPU, 21/25 exact and 25/25 KaTeX-parseable on real Millington crops.
 *
 * Scope, per that ticket's own most important line: `display_formula`
 * regions ONLY. Every `inline_formula` box the ticket tested was ragged --
 * clipped ascenders, swallowed punctuation -- and produced garbage from both
 * recognisers tested. That is the box's fault, not the recogniser's, and it
 * is not fixed here; callers must not feed this module inline_formula crops
 * until someone tightens those boxes (a connected-component pass, or
 * intersecting the box with the text layer's item boxes).
 *
 * IMPORTANT -- what is and is not verified:
 * This module was written against research/15's measured recipe but COULD
 * NOT be run against the real weights in the sandbox that wrote it: both
 * encoder_model.onnx/decoder_model.onnx and their tokenizer.json are hosted
 * on huggingface.co, and that host is blocked by this sandbox's egress
 * policy (confirmed via the agent proxy status endpoint -- a genuine org
 * policy denial, not a misconfiguration; not worked around, per how this
 * environment is supposed to be used). Every place below that had to guess
 * rather than read the model's own config is marked VERIFY-ON-DEVICE. Run
 * `npm run setup:formula` (scripts/setup-formula.sh) once on a machine with
 * normal internet, then `node scripts/formula-check.mjs <crop.png>` -- it
 * logs the session's real input/output tensor names and the tokenizer's
 * real special-token ids on first load, which is exactly the information
 * needed to correct any wrong guess here.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import * as ort from "onnxruntime-node";
import { Tokenizer } from "tokenizers";
import { renderFormula as mathRenderFormula } from "./mathspeech.js";

const HOME_DIR = process.env.BLITZ_FORMULA_HOME || join(homedir(), ".local", "share", "blitz-formula");
const ENCODER_PATH = join(HOME_DIR, "encoder_model.onnx");
const DECODER_PATH = join(HOME_DIR, "decoder_model.onnx");
const TOKENIZER_PATH = join(HOME_DIR, "tokenizer.json");

// VERIFY-ON-DEVICE: DeiT-family encoders standardly take 384x384 RGB with
// mean=std=0.5 per channel -- (x/255-0.5)/0.5 is exactly that, and matches
// research/15 §2's stated preprocessing. What research/15 did not record is
// the resize *mode* (stretch-to-square vs pad-to-square) or whether the
// encoder actually wants 1 channel (grayscale) rather than 3. Stretch + RGB
// is the more common default for this model family; if recognition quality
// is poor once real weights are in, check preprocessor_config.json next to
// the model files first.
const IMG_SIZE = 384;
const MAX_TOKENS = 256; // research/15 §6: cap hit twice out of 52 real crops, both non-genuine equations.

let sessionsPromise = null;
let tokenizerPromise = null;
let specialIds = null; // { bos, eos, pad } -- VERIFY-ON-DEVICE, see loadSpecialIds()

function modelsPresent() {
  return existsSync(ENCODER_PATH) && existsSync(DECODER_PATH) && existsSync(TOKENIZER_PATH);
}

async function loadSpecialIds(tok) {
  // Prefer whatever the actual export tells us. optimum's ONNX export
  // usually drops a generation_config.json or config.json beside the model
  // files with decoder_start_token_id / eos_token_id / pad_token_id --
  // reading those beats guessing. Only if neither file exists do we fall
  // back to a guess, and that fallback is loud on purpose.
  for (const name of ["generation_config.json", "config.json"]) {
    const p = join(HOME_DIR, name);
    if (existsSync(p)) {
      try {
        const cfg = JSON.parse(readFileSync(p, "utf8"));
        const bos = cfg.decoder_start_token_id ?? cfg.bos_token_id;
        const eos = cfg.eos_token_id;
        const pad = cfg.pad_token_id ?? eos;
        if (bos != null && eos != null) {
          console.log(`[formula] special-token ids from ${name}: bos=${bos} eos=${eos} pad=${pad}`);
          return { bos, eos, pad };
        }
      } catch (e) {
        console.warn(`[formula] could not parse ${name}: ${e.message}`);
      }
    }
  }
  // TrOCR-family models very commonly use the same id for BOS and EOS
  // (decoder_start_token_id == eos_token_id), often 2 for a byte-level BPE
  // vocab or 0/1 for a small custom vocab. This guess is UNVERIFIED --
  // formula-check.mjs prints the tokenizer's actual vocab for </s>-shaped
  // tokens on first run specifically so this can be corrected immediately.
  const vocab = tok.getVocabSize ? await tok.getVocabSize() : null;
  console.warn(
    "[formula] no generation_config.json/config.json found next to the model files; " +
      `guessing bos=eos=pad=0 (vocab size reported as ${vocab}). ` +
      "This is very likely wrong -- check the real config once weights are downloaded.",
  );
  return { bos: 0, eos: 0, pad: 0 };
}

async function getSessions() {
  if (!sessionsPromise) {
    sessionsPromise = (async () => {
      if (!modelsPresent()) {
        throw new Error(
          `formula recognition models not found in ${HOME_DIR}. Run 'npm run setup:formula' first.`,
        );
      }
      const [encoder, decoder] = await Promise.all([
        ort.InferenceSession.create(ENCODER_PATH),
        ort.InferenceSession.create(DECODER_PATH),
      ]);
      console.log("[formula] encoder inputs:", encoder.inputNames, "outputs:", encoder.outputNames);
      console.log("[formula] decoder inputs:", decoder.inputNames, "outputs:", decoder.outputNames);
      return { encoder, decoder };
    })();
  }
  return sessionsPromise;
}

async function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = (async () => {
      if (!existsSync(TOKENIZER_PATH)) {
        throw new Error(`${TOKENIZER_PATH} not found. Run 'npm run setup:formula' first.`);
      }
      const tok = await Tokenizer.fromFile(TOKENIZER_PATH);
      specialIds = await loadSpecialIds(tok);
      return tok;
    })();
  }
  return tokenizerPromise;
}

/** pngBuffer -> Float32Array in NCHW [1,3,384,384], normalized (x/255-0.5)/0.5. */
async function preprocess(pngBuffer) {
  const { data, info } = await sharp(pngBuffer)
    .resize(IMG_SIZE, IMG_SIZE, { fit: "fill" }) // VERIFY-ON-DEVICE: stretch vs. pad
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new Error(`expected 3-channel RGB after preprocessing, got ${info.channels}`);
  }
  // HWC uint8 -> CHW float32, normalized per channel identically.
  const out = new Float32Array(3 * IMG_SIZE * IMG_SIZE);
  const plane = IMG_SIZE * IMG_SIZE;
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      out[c * plane + i] = (data[i * 3 + c] / 255 - 0.5) / 0.5;
    }
  }
  return out;
}

// ONNX sessions are not reentrant (see layout.js's identical comment) --
// one chain for the pair, since encoder/decoder are always used together.
let queue = Promise.resolve();

/**
 * @param {Buffer} pngBuffer - a display_formula region, cropped and
 *   re-rendered at 300dpi from the PDF (research/15 §2: cropping the layout
 *   model's own lower-dpi raster throws away resolution the recogniser wants).
 * @param {{width: number, height: number}} regionSize - the crop's pixel
 *   size, for the aspect/size heuristic below.
 * @returns {Promise<{ok: true, latex: string, mathml: string, speech: string} | {ok: false, reason: string}>}
 *
 * Never returns a "confident nonsense" result silently: gated on (1) decode
 * finishing before the token cap, (2) katex accepting the LaTeX as valid
 * markup, AND (3) a crude region-shape check, because research/15 §7 proved
 * the first two gates alone still let a mislabelled non-formula region
 * through with well-formed, wrong, renderable LaTeX.
 */
export async function recognize(pngBuffer, regionSize) {
  const run = queue.then(() => recognizeInner(pngBuffer, regionSize));
  queue = run.then(() => {}, () => {});
  return run;
}

async function recognizeInner(pngBuffer, regionSize) {
  // Heuristic 3 from research/15 §7: both of that ticket's false positives
  // were a wide-short raster and an oversized run, both outside the shape
  // real display equations take. Thresholds are a first guess, not measured
  // on a corpus the way §3's KaTeX-gate numbers are -- tune against your
  // own book if this rejects real equations or lets junk through.
  if (regionSize) {
    const ratio = regionSize.width / Math.max(1, regionSize.height);
    if (ratio > 15 || ratio < 1 / 15) {
      return { ok: false, reason: `region aspect ratio ${ratio.toFixed(1)} outside expected shape` };
    }
  }

  const [{ encoder, decoder }, tok] = await Promise.all([getSessions(), getTokenizer()]);
  const pixels = await preprocess(pngBuffer);

  const pixelInputName = encoder.inputNames[0]; // auto-detected, not hardcoded
  const encOut = await encoder.run({
    [pixelInputName]: new ort.Tensor("float32", pixels, [1, 3, IMG_SIZE, IMG_SIZE]),
  });
  const encoderHidden = encOut[encoder.outputNames[0]];

  // Greedy decode, cache-free (research/15 §2: this export has use_cache:
  // false, so every step re-runs the full decoder over the ids-so-far
  // rather than reusing a KV cache -- simpler, and fine at this length).
  const ids = [specialIds.bos];
  let capHit = true;
  for (let step = 0; step < MAX_TOKENS; step++) {
    const decOut = await decoder.run({
      [decoder.inputNames[0]]: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      [decoder.inputNames[1]]: encoderHidden,
    });
    const logits = decOut[decoder.outputNames[0]];
    const vocabSize = logits.dims[logits.dims.length - 1];
    const lastStep = logits.data.slice((ids.length - 1) * vocabSize, ids.length * vocabSize);
    let best = 0;
    let bestVal = -Infinity;
    for (let v = 0; v < vocabSize; v++) {
      if (lastStep[v] > bestVal) { bestVal = lastStep[v]; best = v; }
    }
    ids.push(best);
    if (best === specialIds.eos) { capHit = false; break; }
  }
  if (capHit) {
    return { ok: false, reason: `hit ${MAX_TOKENS}-token cap without EOS -- treat as failure, per research/15 §6` };
  }

  const latex = (await tok.decode(ids.slice(1, -1), true)).trim();
  if (!latex) return { ok: false, reason: "empty decode" };

  const math = await mathRenderFormula(latex);
  if (!math.ok) return { ok: false, reason: `latex recovered but rejected: ${math.error}`, latex };

  return { ok: true, latex, mathml: math.mathml, speech: math.speech };
}

export async function warm() {
  try {
    await Promise.all([getSessions(), getTokenizer()]);
    return true;
  } catch (e) {
    console.error("[formula] init failed:", e.message);
    return false;
  }
}

export const isReady = () => sessionsPromise !== null && tokenizerPromise !== null;
export const isAvailable = () => modelsPresent();
