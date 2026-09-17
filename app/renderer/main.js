/*
 * TICKET 16 — rebuild the reading loop on Kokoro, with a word cursor.
 * THROWAWAY PROTOTYPE, not production code.
 *
 * [[05]]'s geometry, spotlight and page-rendering all survive unchanged. What
 * changes: speechSynthesis.speak() becomes a fetch to the Kokoro sidecar
 * (server.py) for a WAV plus word-level timing spans, played through a plain
 * <audio> element. Sentence advance is still an *event* — 'ended' plays the
 * same role u.onend did — so [[10]]'s one-sentence-per-unit invariant holds
 * and there is still no cadence model, no drift correction, no watchdog:
 * <audio>'s 'ended' event doesn't wedge the way speechSynthesis did on Linux,
 * so [[05]]'s wedged-queue guard is simply gone, not replaced.
 *
 * Word position is a lookup, not a model (11): requestAnimationFrame reads
 * audio.currentTime and binary-searches a span table the server computed
 * before the first sample played, aligning Kokoro's phoneme groups to
 * orthographic words by content (see server.py's align_groups_to_words),
 * not by count — counting drifts the moment a sentence has either a number
 * (one word, several groups) or a cliticised function word (several words,
 * one group), and textbooks have both in the same sentence.
 *
 * The word cursor lives only inside variant C (spotlight), because the
 * design question this ticket answers is what a moving cursor looks like
 * inside an already-punched hole. Switchable styles: dim / underline / tint
 * / off — cycle with the second floating bar, or the "c" key.
 */

import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { analyzeLayout } from "./layout.js";
import { parseEpub } from "./epub.js";
import { snapshotSite, lastTally } from "./site.js";
import { initHome, setView } from "./home.js";
import { initPanels, setToc, markToc, setNotes, selectTab, addNoteHere } from "./panels.js";
import loraUrl from "./fonts/lora.woff2?url";
import loraItalicUrl from "./fonts/lora-italic.woff2?url";
import workSansUrl from "./fonts/work-sans.woff2?url";
import plexMonoUrl from "./fonts/ibm-plex-mono-400.woff2?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const SVG_NS = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);
const el = {
  file: $("file"), title: $("docTitle"), openSite: $("openSite"),
  pageNow: $("pageNow"), pageNowText: $("pageNowText"), pageMenu: $("pageMenu"),
  playToggle: $("playToggle"),
  voice: $("voice"), rate: $("rate"), rateOut: $("rateOut"),
  linkPeek: $("linkPeek"), linkPeekIcon: $("linkPeekIcon"), linkPeekText: $("linkPeekText"),
  fsHint: $("fsHint"),
  zoom: $("zoom"), zoomOut: $("zoomOut"),
  autoscroll: $("autoscroll"), showall: $("showall"), showRegions: $("showRegions"),
  layoutHint: $("layoutHint"),
  enableLayout: $("enableLayout"),
  state: $("state"), spoken: $("spoken"),
  sentences: $("sentences"), segcount: $("segcount"),
  pages: $("pages"), viewer: $("viewer"), drop: $("drop"),
  engineStatus: $("engineStatus"),
  prevVariant: $("prevVariant"), nextVariant: $("nextVariant"), variantLabel: $("variantLabel"),
  prevCursor: $("prevCursor"), nextCursor: $("nextCursorBtn"), cursorLabel: $("cursorLabel"),
  busyDot: $("busyDot"),
  variantPills: $("variantPills"), cursorPills: $("cursorPills"), themePills: $("themePills"),
  typefacePills: $("typefacePills"), typographyHint: $("typographyHint"),
  toLibrary: $("toLibrary"),
  fontSize: $("fontSize"), fontSizeOut: $("fontSizeOut"),
  lineWidth: $("lineWidth"), lineWidthOut: $("lineWidthOut"),
  lineHeight: $("lineHeight"), lineHeightOut: $("lineHeightOut"),
};

// ---------------------------------------------------------------- state

let doc = null;
// "pdf", "epub" or "site". PageEntry (below) duck-types the same shape
// whichever it is -- pn/div/rendered/sentences/base -- so the whole scroll,
// zoom, eviction and playback pipeline below is shared unmodified; only
// shell-building, renderPage, evictPage and zoom reflow branch on this.
let docKind = null;

/*
 * An EPUB and a snapshotted documentation site are the same kind of document
 * to everything below: an ordered list of reflowable HTML chapters, each one
 * rendered in its own sandboxed iframe. They differ only in where they came
 * from, which matters exactly twice -- opening them, and what to call a unit
 * of one. Everywhere else, ask this rather than naming a format.
 */
function isChapters() { return docKind === "epub" || docKind === "site"; }

/*
 * What one of this document's pages is called. A site's pages are pages; only
 * a book has chapters.
 */
function unitWord() { return docKind === "epub" ? "chapter" : "page"; }
/** @type {Map<number, PageEntry>} */
const pages = new Map();
let scale = 1.2;
let zoomGeneration = 0; // bumped per reZoom, so a superseded pass bails out

let playing = false;
let generation = 0;   // bumped on every cancel; stale audio events are ignored
let cursor = null;    // {pn, si} — sentence to play after the current one
let speaking = null;  // {pn, si} — sentence currently sounding
let loadingSentence = null; // {pn, si} — set the instant speakOne is asked for it, cleared once audio starts
const timings = [];   // wall-clock synth+play time per sentence, to judge lag

const audioEl = new Audio();
audioEl.preload = "auto";
audioEl.muted = false;  // defensive: rule out an accidental mute path outright
audioEl.volume = 1;
try { audioEl.preservesPitch = true; } catch { /* older browsers: ignore */ }
// Diagnostic for a reported case: the word cursor advanced in real time with
// no audible sound, once, on a first click, not reproduced since. If it
// recurs this is the fastest way to tell "audio never actually started"
// (autoplay policy, muted/volume) from "audio started but was silent" (a
// sibling of the server's zero-length-audio bug -- see server.py's peak-
// amplitude check) from "browser routed it to the wrong output device."
audioEl.addEventListener("loadedmetadata", () => {
  console.log(`[tts] loaded  duration=${audioEl.duration.toFixed(2)}s  volume=${audioEl.volume}  muted=${audioEl.muted}`);
});
audioEl.addEventListener("playing", () => {
  console.log(`[tts] playing  currentTime=${audioEl.currentTime.toFixed(2)}  paused=${audioEl.paused}`);
});

/**
 * The reported bug: the first sentence of a read, only sometimes, loses its
 * opening syllable. Every sentence is synthesized independently and none of
 * the server-side code trims anything, so a per-sentence artifact would
 * happen on *every* sentence, not just the first -- this only being the
 * first playback in a fresh renderer points at the OS audio device instead.
 * Chromium's media clock starts advancing the instant `.play()` is called;
 * opening the actual PulseAudio/ALSA output is not instant, and whatever
 * the clock ticks past while that's still opening never reaches the
 * speakers. Every later play() reuses an already-open device and doesn't
 * lose anything -- which is exactly the "only sometimes, only first"
 * pattern reported (the race is won or lost depending on how fast the
 * device happens to open that run). The (probably) sibling bug logged
 * above it -- a first click with a moving cursor and no sound at all --
 * is the same race taken to its extreme: the device wasn't even open by
 * the time the (short) first utterance had already finished playing out
 * its buffer.
 *
 * Fix: open the device once, on purpose, with true silence, before the
 * reader can ever hear the real first sentence. `play(true)` calls this
 * and awaits it before touching audioEl for anything real.
 */
let audioWarmedUp = false;
const SILENT_WAV_URL = (() => {
  const sr = 8000, samples = Math.round(sr * 0.2); // 200ms -- plenty for a device open
  const dataBytes = samples * 2;
  const buf = new ArrayBuffer(44 + dataBytes); // rest of the buffer is zeroed: true silence, no click
  const dv = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF"); dv.setUint32(4, 36 + dataBytes, true); str(8, "WAVE");
  str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, dataBytes, true);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
})();

async function warmUpAudioOnce() {
  if (audioWarmedUp) return;
  audioWarmedUp = true;
  try {
    audioEl.src = SILENT_WAV_URL;
    await audioEl.play();
    await new Promise((resolve) => {
      audioEl.addEventListener("ended", resolve, { once: true });
      setTimeout(resolve, 400); // don't block a real sentence if `ended` never fires
    });
  } catch (e) {
    // Harmless either way: worst case the first real sentence risks the
    // clipped-syllable race this exists to close, same as before this fix.
    console.warn("[tts] audio warm-up failed (harmless):", e);
  }
}

// Speed. Declared up here with the rest of the playback state because
// ensurePrefetch reads it long before the slider below is wired up.
let synthSpeed = 1;    // the speed sentences are being synthesized at
let playingSpeed = 1;  // the speed the clip currently in the element was made at

let currentBlobUrl = null;
let currentSpans = [];     // this sentence's [{start,end,words:[idx,...]}], time-ordered
let activeWordIdxs = [];   // word indices lit right now
let rafId = null;
const prefetchCache = new Map(); // "pn:si" -> Promise<{sr,audio_b64,words,spans}>

const VARIANTS = [
  { key: "A", name: "Tint" },
  { key: "B", name: "Underline" },
  { key: "C", name: "Spotlight" },
];
let variant = VARIANTS[0];

const CURSOR_STYLES = [
  { key: "dim", name: "Nested dim" },
  { key: "underline", name: "Underline" },
  { key: "tint", name: "Tint" },
  { key: "off", name: "Off" },
];
let cursorStyle = CURSOR_STYLES[0];

// The CSS-pixel width every chapter lays out at, at every zoom level. Fixed
// on purpose: zoom scales the rendered result instead of changing this, so
// magnifying a chapter never re-wraps its lines (applyEpubScale).
const EPUB_PAGE_WIDTH = 760;

// Epub-only reading typography (20): meaningless for a PDF canvas, which has
// no reflowable text to apply a typeface or line width to. loadPref is a
// function declaration further down and is hoisted, so it's safe to call
// this early.
let epubFont = loadPref("blitz.epubFont", "original");
let epubFontSize = Number(loadPref("blitz.epubFontSize", 18));
// Text size is expressed to the reader in px (18px is "as the book set it")
// but applied as a ratio, since it scales the book's own sizes rather than
// replacing them.
const EPUB_BASE_FONT_SIZE = 18;
const epubTextScale = () => epubFontSize / EPUB_BASE_FONT_SIZE;
let epubLineWidth = Number(loadPref("blitz.epubLineWidth", 720));
let epubLineHeight = Number(loadPref("blitz.epubLineHeight", 1.6));

// ---------------------------------------------------------------- utils

const clamp01 = (n) => Math.max(0, Math.min(1, n));

function status(text) {
  el.state.textContent = text;
}

function report() {
  const avg = timings.length
    ? (timings.reduce((a, b) => a + b, 0) / timings.length / 1000).toFixed(2)
    : "–";
  const rendered = [...pages.values()].filter((p) => p.rendered).length;
  const busy = activeRequests > 0 || fetchQueue.length > 0;
  el.busyDot.hidden = !busy;
  status(
    [
      `${playing ? "speaking" : "idle"}  gen ${generation}`,
      speaking ? `at  p${speaking.pn} s${speaking.si}  word ${activeWordIdxs.join(",") || "—"}` : "at  —",
      `pages rendered ${rendered}/${doc ? doc.numPages : 0}   zoom ${scale.toFixed(2)}`,
      `sentences spoken ${timings.length}  mean ${avg}s   synthesizing ${activeRequests}  queued ${fetchQueue.length}`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------- rendering

class PageEntry {
  constructor(pn, div) {
    this.pn = pn;
    this.div = div;
    this.canvas = div.querySelector("canvas");
    this.textLayerDiv = div.querySelector(".textLayer");
    this.svg = div.querySelector(".overlay");
    this.labels = div.querySelector(".regionLabels");
    this.iframe = div.querySelector("iframe"); // epub only; null for a PDF shell
    this.textLayer = null;
    this.proxy = null;
    this.sentences = [];
    this.rendered = false;
    this.rendering = null;
    this.base = null;         // unscaled viewport size, so zoom can resize without PDF.js
    this.regions = null;      // set once layout analysis resolves (06)
    this.layoutLoading = false;
    this.renderTask = null;   // in-flight PDF.js RenderTask, so it can be cancelled
    this.renderFails = 0;     // consecutive failed attempts, so a bad page stops being retried
  }
}

/** Sniff format from the filename first, falling back to the bytes themselves. */
function sniffKind(name, data) {
  if (/\.epub$/i.test(name || "")) return "epub";
  if (/\.pdf$/i.test(name || "")) return "pdf";
  const head = new Uint8Array(data, 0, Math.min(data.byteLength, 4));
  if (head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46) return "pdf"; // %PDF
  if (head[0] === 0x50 && head[1] === 0x4b) return "epub"; // PK.. (zip)
  return null;
}

/*
 * The book currently on the shelf, if this one is on it: {id, pages}. A file
 * with no path behind it (dragged out of a web page) still reads perfectly
 * well, it just cannot be shelved or resumed, so this stays null for it.
 */
let currentBook = null;

/* The filename a PDF was opened from, so its header has something to fall
   back on when the file's own metadata has no usable title. */
let pendingName = "";

/*
 * A PDF's outline, flattened to the same {title, pn, depth} shape an EPUB's
 * nav document produces, so the Contents tab renders one kind of thing.
 *
 * An outline entry points at a destination, not a page, and resolving one
 * costs a getPageIndex round-trip -- a medical textbook has hundreds of
 * them, so they are resolved together rather than one after another. An
 * entry whose destination will not resolve is still listed: it is part of
 * the book's structure, it just cannot be clicked.
 */
async function pdfToc(pdf) {
  const outline = await pdf.getOutline();
  if (!outline?.length) return [];
  const flat = [];
  const walk = (items, depth) => {
    for (const it of items) {
      flat.push({ title: (it.title ?? "").trim() || "—", dest: it.dest, depth });
      if (it.items?.length && depth < 3) walk(it.items, depth + 1);
    }
  };
  walk(outline, 0);
  await Promise.all(flat.map(async (e) => {
    try {
      const d = typeof e.dest === "string" ? await pdf.getDestination(e.dest) : e.dest;
      const ref = Array.isArray(d) ? d[0] : null;
      if (ref && typeof ref === "object") e.pn = (await pdf.getPageIndex(ref)) + 1;
      else if (typeof ref === "number") e.pn = ref + 1;
    } catch { /* an unresolvable destination is not worth losing the entry over */ }
  }));
  return flat.map(({ title, pn, depth }) => ({ title, pn: pn ?? null, depth }));
}

/*
 * The rail names the book; the counter over the page says where in it you
 * are. The page count used to sit in the rail, which spent the most valuable
 * corner of the window on a number and left the title nowhere.
 */
function setDocHeader(title, siteUrl) {
  el.title.textContent = title || "Untitled";
  el.title.title = title || "";
  el.openSite.hidden = !siteUrl;
  if (siteUrl) {
    el.openSite.onclick = (e) => { e.preventDefault(); window.open(siteUrl, "_blank"); };
    el.openSite.title = siteUrl;
  }
  updatePageNow();
}

/** "9 / 26", bottom right, and marked while something is being read. */
function updatePageNow() {
  if (!doc) { el.pageNow.hidden = true; el.playToggle.hidden = true; return; }
  const mid = pageAtOffset(el.viewer.scrollTop + el.viewer.clientHeight / 2);
  const at = speaking?.pn ?? mid?.pn ?? 1;
  el.pageNow.hidden = false;
  // Pinned to the viewer's right edge rather than the window's, so hiding
  // either panel does not leave it stranded over one of them.
  const box = el.viewer.getBoundingClientRect();
  el.pageNow.style.right = `${Math.max(12, Math.round(innerWidth - box.right + 18))}px`;
  el.pageNow.classList.toggle("reading", !!playing);
  el.pageNowText.textContent = `${at} / ${doc.numPages}`;

  // Same fixed/repositioned-from-the-viewer-box treatment as #pageNow just
  // above, centered instead of right-aligned. play() already toggles itself
  // to pause() when something is speaking (see the Space key handler), so
  // this button just needs to look right and call it.
  el.playToggle.hidden = false;
  el.playToggle.style.left = `${Math.round(box.left + box.width / 2)}px`;
  el.playToggle.classList.toggle("playing", !!playing);
  el.playToggle.title = playing ? "Pause (Space)" : "Play (Space)";
  el.playToggle.setAttribute("aria-label", playing ? "Pause" : "Play");
  el.playToggle.querySelector(".iconPlay").hidden = playing;
  el.playToggle.querySelector(".iconPause").hidden = !playing;
}

/** Fill the Contents tab for whichever format is open. */
async function applyToc() {
  if (isChapters()) {
    setToc(doc.toc ?? [], docKind === "site"
      ? "That site had no navigation to read a contents list out of."
      : "This book ships no table of contents.");
    return;
  }
  let entries = [];
  try {
    entries = await pdfToc(doc);
  } catch (e) {
    console.warn("[toc] could not read this PDF's outline", e);
  }
  setToc(entries, "This PDF has no embedded table of contents -- plenty of scanned books don't.");
}

/**
 * Put a page in view, optionally arming the play cursor at a sentence on it.
 * The one way anything jumps: the TOC, a note, and resuming all come here.
 */
async function goToPage(pn, si = null, frag = null) {
  if (!doc) return;
  pn = Math.min(Math.max(1, pn), doc.numPages);
  await renderPage(pn);
  markGeomDirty();
  const g = geomFor(pn);
  if (g) {
    el.viewer.scrollTop = g.top + (frag ? anchorOffset(pn, frag) : 0);
    lastScrollTop = el.viewer.scrollTop;
  }
  if (si != null) cursor = { pn, si };
  markToc(pn);
  renderSentenceList(pn);
  updatePageNow();
}

/*
 * How far down a page a named anchor sits, in the viewer's own pixels.
 *
 * A chapter lays out at its natural width inside its iframe and is scaled
 * from outside, so an offset measured in there has to be multiplied by the
 * zoom to mean anything out here. A little air above it, so the heading you
 * jumped to is not welded to the top edge.
 */
const ANCHOR_AIR = 24;

function anchorOffset(pn, frag) {
  const idoc = pages.get(pn)?.iframe?.contentDocument;
  if (!idoc) return 0;
  let target = null;
  try {
    target = idoc.getElementById(frag) ?? idoc.querySelector(`[name="${CSS.escape(frag)}"]`);
  } catch { /* a fragment that is not a usable selector is just a miss */ }
  if (!target) return 0;
  const top = target.getBoundingClientRect().top - idoc.documentElement.getBoundingClientRect().top;
  return Math.max(0, top * scale - ANCHOR_AIR);
}

/*
 * Whatever text is selected right now, and which page it is on.
 *
 * A PDF's text layer is part of this document, so its selection is the
 * window's. An EPUB chapter is a separate document inside an iframe, so each
 * rendered chapter has to be asked for its own -- only one of them can hold
 * a selection at a time.
 */
function liveSelection() {
  const own = window.getSelection();
  if (own && !own.isCollapsed) {
    const text = own.toString().trim();
    const node = own.anchorNode;
    const div = (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.(".page");
    if (text && div) return { pn: Number(div.dataset.page), text };
  }
  for (const p of pages.values()) {
    if (!p.iframe || !p.rendered) continue;
    const sel = p.iframe.contentDocument?.getSelection?.();
    if (!sel || sel.isCollapsed) continue;
    const text = sel.toString().trim();
    if (text) return { pn: p.pn, text };
  }
  return null;
}

/*
 * What a new note is about, in order of how specific it is: text you
 * selected, then the sentence the reader is on, then just the page.
 *
 * Selection first, and deliberately: notes are not a feature of the voice.
 * Reading with your eyes and marking a passage has to work exactly as well
 * as noting the sentence being read aloud, so anything you can highlight you
 * can note -- in a PDF's text layer or inside an EPUB chapter alike.
 */
/** The name this document gives one of its pages, where it has one. */
function pageTitleOf(pn) {
  const hit = doc?.toc?.find((e) => e.pn === pn);
  return hit?.title ?? null;
}

/*
 * A note records what it is ABOUT, not where it sat.
 *
 * The page number is written down, but only as a hint: a documentation site
 * is re-fetched every time it is opened, and a page can be renumbered,
 * moved or split between one reading and the next. What survives that is the
 * text -- so a note carries its quote and the name of the page it came from,
 * and goToNote (below) finds the quote in whatever the document says today,
 * falling back to the name and only then to the number.
 */
function noteContext() {
  if (!doc) return null;
  const label = (pn) => pageTitleOf(pn) ?? `${unitWord()} ${pn}`;

  const sel = liveSelection();
  if (sel) {
    return {
      pn: sel.pn, si: null, quote: sel.text.slice(0, 400),
      title: pageTitleOf(sel.pn), label: label(sel.pn),
    };
  }

  const at = speaking ?? cursor ?? null;
  const mid = pageAtOffset(el.viewer.scrollTop + el.viewer.clientHeight / 2);
  const pn = at?.pn ?? mid?.pn ?? 1;
  const si = at?.pn === pn ? at.si : null;
  const quote = si == null ? "" : (pages.get(pn)?.sentences[si]?.text ?? "").slice(0, 400);
  return { pn, si, quote, title: pageTitleOf(pn), label: label(pn) };
}

/** Loose enough that re-typeset or re-wrapped text still matches itself. */
function normaliseQuote(text) {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

// Plain text per chapter, built once on demand. Searching this is what lets
// a note find its quote without rendering (and paying for) every page.
const chapterTextCache = new Map();

function chapterText(pn) {
  if (chapterTextCache.has(pn)) return chapterTextCache.get(pn);
  const html = doc?.chapters?.[pn - 1]?.bodyHtml ?? "";
  const box = document.createElement("div");
  box.innerHTML = html;
  const text = normaliseQuote(box.textContent);
  chapterTextCache.set(pn, text);
  return text;
}

/**
 * Where a note points now. Its quote is the real anchor: the page it was
 * taken on is tried first because it is nearly always still right and costs
 * one comparison, then the rest of the document, then the page's name, and
 * only if all of that fails, the number it was written with.
 */
function locateNote(note) {
  const needle = normaliseQuote(note.quote).slice(0, 120);
  if (needle.length > 8 && doc?.chapters) {
    const first = note.pn && note.pn <= doc.numPages ? [note.pn] : [];
    const rest = [];
    for (let pn = 1; pn <= doc.numPages; pn++) if (pn !== note.pn) rest.push(pn);
    for (const pn of [...first, ...rest]) if (chapterText(pn).includes(needle)) return pn;
  }
  if (note.title) {
    const hit = doc?.toc?.find((e) => e.title === note.title && e.pn);
    if (hit) return hit.pn;
  }
  return Math.min(Math.max(1, note.pn ?? 1), doc?.numPages ?? 1);
}

/** Open a note: land on its quote wherever that text lives today. */
async function goToNote(note) {
  if (!doc) return;
  const pn = locateNote(note);
  await goToPage(pn);
  const p = pages.get(pn);
  const needle = normaliseQuote(note.quote).slice(0, 80);
  if (!p?.sentences?.length || needle.length <= 8) return;
  // Either direction: a note quoting a fragment of a sentence, and a note
  // quoting a selection that ran across several of them, both want the
  // sentence where the passage starts.
  const si = p.sentences.findIndex((s) => {
    const t = normaliseQuote(s.text);
    return t.includes(needle) || needle.includes(t.slice(0, 60));
  });
  if (si < 0) return;
  cursor = { pn, si };
  scrollTo(p, sentenceRects(p, p.sentences[si]));
  repaint();
  renderSentenceList(pn);
}

/** Notes belong to a shelved book, so they save through the library. */
function saveNotes(notes) {
  if (!currentBook) return;
  currentBook.notes = notes;
  window.blitz?.library?.notes({ id: currentBook.id, notes }).catch((e) => {
    console.warn("[library] could not save notes", e);
  });
}

const NOTES_NEED_A_SHELF =
  "This document isn't on the shelf, so there is nowhere to keep notes with it. " +
  "Open it from a file on disk rather than a drag out of another app.";

async function openFile(file) {
  const data = await file.arrayBuffer();
  const kind = sniffKind(file.name, data);
  if (!kind) return status(`Can't tell what kind of file "${file.name}" is -- expected a .pdf or .epub`);
  // Ask for the path BEFORE opening: openPdf detaches the ArrayBuffer, and
  // the File object is the only thing that can answer this.
  const path = window.blitz?.pathForFile?.(file) ?? "";
  setView("reader");
  if (kind === "epub") await openEpub(data); else await openPdf(data, { name: file.name });
  applyToc();
  const entry = await shelve(path, file.name);
  if (entry?.position) await resumeAt(entry.position);
  setNotes(entry?.notes ?? [], { enabled: !!entry, reason: NOTES_NEED_A_SHELF });
}

/** Loose enough to recognise the same address typed two ways. */
function sameSiteUrl(a, b) {
  const norm = (u) => String(u ?? "").trim().toLowerCase()
    .replace(/#.*$/, "").replace(/\/index\.html?$/, "/").replace(/\/+$/, "");
  return !!a && norm(a) === norm(b);
}

function ago(at) {
  if (!at) return "earlier";
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 90) return `${Math.max(1, mins)} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/*
 * Open a documentation site at an address. ALWAYS re-fetched.
 *
 * A site is not a file: it changes under you, and reading a stale copy of
 * documentation is worse than not reading it, because nothing about the page
 * tells you it is out of date. So every open goes to the network, and the
 * saved snapshot is a *fallback* rather than the source -- what you get when
 * the site cannot be reached, announced as such and dated, never passed off
 * as current.
 *
 * The fresh snapshot replaces the saved one on the shelf. The entry is keyed
 * on the address rather than on the bytes, so notes and reading position
 * survive the refetch even when the pages themselves have changed.
 */
async function openSiteAt({ url, entryId = null, onProgress = () => {} }) {
  // What we already hold, loaded first for two reasons: it carries the
  // validators that let the refetch ask "has this changed?" rather than
  // re-download the site, and it is what gets shown if the site is
  // unreachable.
  const id = entryId ?? await knownSiteId(url);
  let saved = null;
  let savedEntry = null;
  if (id) {
    const res = await window.blitz.library.open(id).catch(() => ({ ok: false }));
    if (res.ok) {
      try {
        saved = JSON.parse(new TextDecoder().decode(res.data));
        savedEntry = res.entry;
      } catch (e) {
        console.warn("[site] the saved copy could not be read", e);
      }
    }
  }

  let snapshot = null;
  let failure = null;
  try {
    snapshot = await snapshotSite(url, onProgress, saved);
  } catch (e) {
    failure = e;
  }

  let entry = null;
  if (snapshot) {
    try {
      entry = await window.blitz.library.rememberSite({
        url: snapshot.url,
        title: snapshot.title,
        pages: snapshot.chapters.length,
        snapshot: JSON.stringify(snapshot),
      });
    } catch (e) {
      // Same rule as a book that cannot be shelved: it is still readable.
      console.warn("[library] could not shelve this site", e);
    }
  } else {
    // Nothing saved to fall back to means there is nothing to show and the
    // fetch error is the answer -- it goes back to wherever the address was
    // typed, which explains it far better than an empty reader would.
    if (!saved) throw failure;
    snapshot = saved;
    entry = savedEntry;
  }

  setView("reader");
  await openSite(snapshot, { startAt: entry?.position?.pn ?? 1 });
  applyToc();
  currentBook = entry
    ? { id: entry.id, pages: snapshot.chapters.length, notes: entry.notes ?? [] }
    : null;
  setNotes(currentBook?.notes ?? [], { enabled: !!currentBook, reason: NOTES_NEED_A_SHELF });
  if (entry?.position) await resumeAt(entry.position);
  // Last, so it is not overwritten by the resume message: being told you are
  // looking at an old copy is the more important of the two.
  if (failure) {
    status(`Couldn't reach ${url} (${failure.message}) — showing the copy saved ${ago(snapshot.fetchedAt)}`);
  }
  return entry;
}

/** The shelf id for a site at this address, if it is already on the shelf. */
async function knownSiteId(url) {
  const books = await window.blitz?.library?.list?.().catch(() => []) ?? [];
  return books.find((b) => b.kind === "site" && sameSiteUrl(b.url, url))?.id ?? null;
}

/** Adding a site by address, from the home page. */
function addSite(url, onProgress) {
  return openSiteAt({ url, onProgress });
}

/** A book's own title where it has one, its filename where it doesn't. */
async function docTitle(fallbackName) {
  const stem = fallbackName.replace(/\.(pdf|epub)$/i, "");
  if (isChapters()) return doc.title || stem;
  try {
    const t = (await doc.getMetadata())?.info?.Title?.trim();
    // Plenty of PDFs carry a producer's placeholder ("untitled", "Microsoft
    // Word - ch3.doc") as their title; a filename beats that.
    // Scanned-book metadata routinely carries the site it was downloaded
    // from as part of the title; that is not part of the book.
    if (t && t.length > 2 && !/^untitled/i.test(t) && !/\.(docx?|indd|qxd)\b/i.test(t)) {
      return t.replace(/\s*[-–|(]\s*(www\.)?[\w-]+\.(com|net|org|sk|io)\)?\s*$/i, "").trim() || stem;
    }
  } catch { /* no metadata is fine */ }
  return stem;
}

/** Record the open document on the shelf, and pick up any position it has. */
async function shelve(path, name) {
  currentBook = null;
  if (!path || !doc || !window.blitz?.library) return null;
  try {
    const entry = await window.blitz.library.remember({
      path, title: await docTitle(name), kind: docKind, pages: doc.numPages,
    });
    if (!entry) return null; // a scratch file: readable, just not shelved
    currentBook = { id: entry.id, pages: doc.numPages, notes: entry.notes ?? [] };
    return entry;
  } catch (e) {
    // A book that can't be shelved is still a book you can read.
    console.warn("[library] could not shelve this document", e);
    return null;
  }
}

/** Open a book off the shelf, landing where it was left. */
async function openBook(book, onProgress = () => {}) {
  // A site is re-fetched every time rather than read off the shelf: see
  // openSiteAt. The saved snapshot is only what happens when that fails.
  if (book.kind === "site") {
    return openSiteAt({ url: book.url, entryId: book.id, onProgress });
  }
  const res = await window.blitz.library.open(book.id).catch(() => ({ ok: false, reason: "error" }));
  if (!res.ok) {
    // The library points at files rather than copying them, so a book can
    // move out from under an entry. Say so, and offer the picker: reopening
    // it from its new home re-binds the same entry, because the entry is
    // keyed on the bytes and not on the path.
    status(res.reason === "missing" ? `"${book.title}" is no longer at ${book.path}` : "That book could not be opened");
    if (res.reason === "missing") el.file.click();
    return;
  }
  setView("reader");
  const startAt = res.entry.position?.pn ?? 1;
  if (book.kind === "epub") await openEpub(res.data, { startAt });
  else await openPdf(res.data, { startAt, name: book.title });
  applyToc();
  currentBook = { id: book.id, pages: doc.numPages, notes: res.entry.notes ?? [] };
  setNotes(currentBook.notes, { enabled: true });
  await resumeAt(res.entry.position);
}

/*
 * Resume lands on the PAGE that was left, not on the sentence -- the human's
 * call (21): a page is a place you recognise, and being dropped mid-sentence
 * into audio you did not ask for is not. The sentence is not thrown away
 * though: it becomes the play cursor, so pressing play continues the
 * sentence you stopped on rather than restarting the page.
 */
async function resumeAt(pos) {
  if (!pos?.pn || !doc) return;
  const pn = Math.min(Math.max(1, pos.pn), doc.numPages);
  // The opener already rendered this page and scrolled to it (openAt), so
  // this only has to arm the cursor and say where we landed -- it must not
  // travel again, which is what made reopening a book flash page 1 first.
  const here = pageAtOffset(el.viewer.scrollTop + el.viewer.clientHeight / 2)?.pn;
  if (here !== pn) await goToPage(pn, pos.si ?? null);
  else if (pos.si != null) cursor = { pn, si: pos.si };
  markToc(pn);
  renderSentenceList(pn);
  updatePageNow();
  status(`picked up at ${unitWord()} ${pn}`);
}

/*
 * Position is written as you read, not only when you ask for it: the reading
 * loop reports every sentence it speaks, and a settled scroll reports the
 * page you stopped on, so putting the app down at any point leaves something
 * to come back to. Writes are throttled -- a sentence is a couple of seconds
 * of audio, and the library file does not need rewriting that often.
 */
const POSITION_SAVE_MS = 3000;
let pendingPosition = null;
let positionTimer = null;

function notePosition(pn, si = null) {
  if (!currentBook || !pn) return;
  pendingPosition = { id: currentBook.id, pn, si, pages: currentBook.pages };
  if (positionTimer) return;
  positionTimer = setTimeout(() => { positionTimer = null; flushPosition(); }, POSITION_SAVE_MS);
}

function flushPosition() {
  if (!pendingPosition) return;
  const p = pendingPosition;
  pendingPosition = null;
  window.blitz?.library?.position(p).catch(() => {});
}

/** Leave the book and go back to the shelf. */
async function goHome() {
  flushPosition();
  await closeDoc();
  currentBook = null;
  el.drop.classList.remove("hide");
  setView("home");
}

/** Teardown shared by both openers: stop playback, release the old document's pages. */
async function closeDoc() {
  stop();
  // `destroy()` lives on the *loading task*, not on the document proxy, in
  // pdfjs 6 -- `doc.destroy()` is a TypeError, and because it threw before
  // any of the teardown below ran, opening a second file in one session
  // silently left the first document on screen. Only ever reachable on the
  // second open, which is why the single-open smoke test never saw it.
  // Teardown must not be able to wedge the app either way, hence the catch.
  if (doc && docKind === "pdf") {
    try { await doc.loadingTask.destroy(); }
    catch (e) { console.warn("[doc] destroying the previous document failed", e); }
  }
  for (const p of pages.values()) evictPage(p); // release canvases/iframes before dropping the map
  renderOrder.length = 0;
  renderQueue.clear();
  visible.clear();
  pages.clear();
  chapterTextCache.clear();
  el.pages.replaceChildren();
  el.sentences.replaceChildren();
  doc = null;
  docKind = null;
  el.pageNow.hidden = true;
  el.linkPeek.hidden = true;
  el.openSite.hidden = true;
  el.title.textContent = "no document";
  setToc([], "Open a book to see its contents.");
  setNotes([], { enabled: false, reason: "Open a book to take notes on it." });
  syncLayoutControls();
  syncTypographyControls();
}

/**
 * The "reading order via layout model" checkbox only means anything for a
 * PDF -- an epub chapter's TreeWalker already visits nodes in document
 * order, which for reflowable HTML *is* the reading order, so there is no
 * equivalent reordering problem for the layout model to fix (see
 * el.enableLayout.onchange below). Left checkable-but-inert on an epub, the
 * control looks broken: nothing happens, with no indication why. Disable it
 * (and the region-overlay checkbox that depends on it) instead, so an epub
 * makes the control's irrelevance visible rather than silently doing nothing.
 */
function syncLayoutControls() {
  const isPdf = docKind === "pdf";
  el.enableLayout.disabled = !isPdf;
  el.showRegions.disabled = !isPdf;
  el.layoutHint.textContent =
    isChapters()
      ? "Not applicable to reflowable HTML: its chapters are read in document order already, which for reflowable HTML is the correct reading order -- there's no layout model step to run."
      : docKind === "pdf"
        ? "Runs PP-DocLayoutV2 outside the window (~1.4s a page), so scrolling stays smooth. Groups each page into titles, paragraphs and figures so a click picks the paragraph you meant. Off means pages keep their default reading order."
        : "Open a PDF to enable this.";
}

/**
 * Mirror image of syncLayoutControls: typeface and line width/spacing are
 * meaningless over a PDF canvas (nothing reflowable to apply them to) and
 * only mean something for an EPUB chapter's own CSS.
 */
function syncTypographyControls() {
  const isEpub = isChapters();
  el.typefacePills.querySelectorAll("button").forEach((b) => { b.disabled = !isEpub; });
  el.fontSize.disabled = !isEpub;
  el.lineWidth.disabled = !isEpub;
  el.lineHeight.disabled = !isEpub;
  el.typographyHint.textContent = isEpub
    ? "Only affects this document's own reflow -- its own styling still applies underneath \"Original.\""
    : "Only applies to an EPUB or a site -- a PDF page is a fixed render, with no reflowable text to apply a typeface or line width to.";
}

/** Build one page/chapter shell, shared innerHTML for whichever fields both formats use. */
function makeShell(pn, extraClass, bodyHtml) {
  const div = document.createElement("div");
  div.className = `page ${extraClass}`;
  div.dataset.page = String(pn);
  div.innerHTML = bodyHtml +
    `<svg class="overlay" viewBox="0 0 1 1" preserveAspectRatio="none"></svg>` +
    `<div class="regionLabels"></div>`;
  el.pages.append(div);
  return div;
}

/*
 * The size an unrendered shell stands at until its page really rasterises.
 *
 * This used to be page 1's size, which is wrong in exactly the case it is
 * most visible: a book whose cover is a different size from its body. Game
 * Physics Engine Development's page 1 is 336x414 while every other page is
 * 540x665, so all 480 of its shells stood at 62% of the real size and each
 * visibly grew the moment it rasterised -- the "small page that expands"
 * while flinging. Sample a spread of pages and take the most common size
 * instead: one odd page can no longer set the placeholder for the whole
 * book, and on a uniform book (the normal case) every shell is exactly
 * right, so nothing resizes at render time at all.
 */
async function placeholderSize(pdf) {
  const n = pdf.numPages;
  const picks = [...new Set([1, 2, 3, Math.ceil(n / 2), n])].filter((pn) => pn >= 1 && pn <= n);
  const seen = new Map();
  for (const pn of picks) {
    const v = (await pdf.getPage(pn)).getViewport({ scale: 1 });
    const key = `${v.width}x${v.height}`;
    const hit = seen.get(key) ?? { width: v.width, height: v.height, count: 0 };
    hit.count++;
    seen.set(key, hit);
  }
  // Ties go to the earlier page, which Map iteration order gives for free.
  return [...seen.values()].sort((a, b) => b.count - a.count)[0];
}

async function openPdf(data, { startAt = 1, name = "" } = {}) {
  pendingName = name;
  await closeDoc();
  docKind = "pdf";
  syncLayoutControls();
  syncTypographyControls();

  doc = await pdfjsLib.getDocument({ data }).promise;
  el.drop.classList.add("hide");
  setDocHeader(await docTitle(pendingName), null);

  // Shell every page up front at the right aspect ratio, so the scrollbar is
  // honest; rasterise lazily as they come into view.
  const base = await placeholderSize(doc);

  for (let pn = 1; pn <= doc.numPages; pn++) {
    // width/height 0 until rasterised: a default <canvas> is 300x150, and at
    // 4 bytes a pixel that is ~180 KB per page of pure shell -- 145 MB of it
    // on an 809-page book, before anything has been rendered at all.
    const div = makeShell(pn, "pdfpage",
      `<canvas width="0" height="0"></canvas><div class="textLayer"></div>`);
    sizePage(div, base);
    const entry = new PageEntry(pn, div);
    // Page 1's size, as a stand-in until this page is actually opened. Every
    // shell needs *a* height for the scrollbar to be honest, and asking PDF.js
    // for 611 real ones up front is the thing lazy rendering exists to avoid.
    entry.base = { width: base.width, height: base.height };
    pages.set(pn, entry);
    observer.observe(div);
  }
  markGeomDirty();
  fitToWidth();

  await openAt(startAt);
  report();
}

// A book with no per-chapter width info yet gets a guessed placeholder height
// so the scrollbar is roughly honest before anything has actually reflowed --
// same idea as the PDF shell borrowing page 1's size, just a flat guess since
// an EPUB chapter has no upfront aspect ratio to ask for.
const EPUB_PLACEHOLDER_HEIGHT = 900;

/*
 * Open an ordered list of reflowable HTML chapters -- an EPUB's spine, or a
 * documentation site's pages. Both formats reduce to the same thing here, so
 * this is where they meet and everything past it is format-blind.
 */
async function openChapters({ kind, title, chapters, toc, css = "", siteUrl = null, startAt = 1 }) {
  await closeDoc();
  docKind = kind;
  syncLayoutControls();
  syncTypographyControls();

  // numPages, not numChapters: every generic page-shaped codepath below
  // (nextCursor, firstPageWithSentences, report(), the render queue) already
  // reads doc.numPages and only PDF-specific call sites (getPage, destroy)
  // need to know the difference, gated on docKind instead.
  doc = { numPages: chapters.length, chapters, title, toc, css };
  el.drop.classList.add("hide");
  setDocHeader(title, siteUrl);

  for (let pn = 1; pn <= doc.numPages; pn++) {
    const div = makeShell(pn, "epubchapter",
      `<iframe sandbox="allow-same-origin" tabindex="-1" scrolling="no"></iframe>`);
    const entry = new PageEntry(pn, div);
    // Natural (unscaled) placeholder size; sizeEpubChapter applies the zoom,
    // the same contract renderChapter fills in once the real height is known.
    entry.base = { width: EPUB_PAGE_WIDTH, height: EPUB_PLACEHOLDER_HEIGHT };
    sizeEpubChapter(entry);
    pages.set(pn, entry);
    observer.observe(div);
  }
  markGeomDirty();
  fitToWidth();

  await openAt(startAt);
  report();
}

/*
 * Render the page the reader is going back to FIRST, and put the scroll
 * there before anything is painted.
 *
 * This used to render page 1, hand the window over, and only then jump --
 * so reopening a book you were 130 pages into showed you page 1, rendered
 * it, and yanked it away. Rendering the destination first means the first
 * thing drawn is the thing you asked for.
 */
async function openAt(pn) {
  const start = Math.min(Math.max(1, pn || 1), doc.numPages);
  await renderPage(start);
  if (start === 1) return;
  markGeomDirty();
  const g = geomFor(start);
  if (g) {
    el.viewer.scrollTop = g.top;
    lastScrollTop = el.viewer.scrollTop;
  }
  markToc(start);
  updatePageNow();
}

async function openEpub(data, { startAt = 1 } = {}) {
  const parsed = await parseEpub(data);
  await openChapters({
    kind: "epub", title: parsed.title, chapters: parsed.chapters, toc: parsed.toc, startAt,
  });
}

/*
 * A snapshotted documentation site (see renderer/site.js). Its pages are
 * chapters, and its stylesheet is the site's own -- gathered once for the
 * whole snapshot rather than per page, because it is the same file on all of
 * them, so it lives on the document and epubShellHtml injects it.
 */
async function openSite(snapshot, { startAt = 1 } = {}) {
  await openChapters({
    kind: "site", title: snapshot.title, chapters: snapshot.chapters, toc: snapshot.toc,
    css: snapshot.css ?? "", siteUrl: snapshot.url, startAt,
  });
}

/*
 * Where each page sits in the scroll container.
 *
 * Everything on the scroll path used to ask the DOM: the scroll handler called
 * getBoundingClientRect() on *every* page to find the one under the midpoint,
 * which is 611 forced layouts per scroll event on a big textbook. This reads
 * the offsets once into a sorted array and rebuilds only when page sizes
 * actually change (open, zoom, a shell learning its real size).
 */
let geomIndex = null;

function markGeomDirty() { geomIndex = null; }

/*
 * Move the scroll offset without the scroll handler reading it as a fling.
 * Used to compensate for a page resizing off-screen: the velocity estimate is
 * a delta over time, so a one-frame jump of a few hundred px would otherwise
 * look like a fast scroll and stall the render pump for an idle beat.
 */
function scrollByWithoutFling(dy) {
  if (!dy) return;
  el.viewer.scrollTop += dy;
  lastScrollTop = el.viewer.scrollTop;
}

function geom() {
  if (!geomIndex) {
    geomIndex = [...pages.values()]
      .map((p) => ({ pn: p.pn, top: p.div.offsetTop, bottom: p.div.offsetTop + p.div.offsetHeight }))
      .sort((a, b) => a.top - b.top);
  }
  return geomIndex;
}

/** The page containing this scroll offset, or the nearest one. */
function pageAtOffset(y) {
  const g = geom();
  if (!g.length) return null;
  let lo = 0, hi = g.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g[mid].top <= y) lo = mid; else hi = mid - 1;
  }
  return g[lo];
}

/*
 * Zoom scales page heights but not the gaps between them, so the index can be
 * transformed exactly rather than re-read: each page keeps its ordinal, its
 * height scales, and the constant gap stays put. Saves a forced layout on
 * every wheel event of a zoom gesture.
 */
function rescaleGeom(ratio) {
  if (!geomIndex || geomIndex.length === 0 || ratio === 1) return;
  const gap = geomIndex.length > 1 ? geomIndex[1].top - geomIndex[0].bottom : 0;
  let top = geomIndex[0].top;
  for (const e of geomIndex) {
    const h = (e.bottom - e.top) * ratio;
    e.top = top;
    e.bottom = top + h;
    top += h + gap;
  }
}

function geomFor(pn) {
  return geom().find((e) => e.pn === pn) ?? null;
}

/** Record a page's unscaled size; CSS multiplies it by the document zoom. */
function sizePage(div, base) {
  div.style.setProperty("--pw", String(base.width));
  div.style.setProperty("--ph", String(base.height));
}

/*
 * What is on screen right now, kept by the observer rather than measured.
 * Every other route into rendering is edge-triggered -- an intersection
 * change, a scroll event -- and an edge that is missed leaves a blank page
 * with nothing left to nudge it, because the page never stopped
 * intersecting and so never intersects again. This set is what the backstop
 * below reads, and asking it costs nothing, which is what lets the backstop
 * run on a heartbeat on an 800-page book.
 */
const visible = new Set();

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const pn = Number(e.target.dataset.page);
      if (e.isIntersecting) { visible.add(pn); queueRender(pn); }
      else visible.delete(pn);
    }
  },
  { root: null, rootMargin: "400px 0px" },
);

/*
 * Scrolling outranks rendering.
 *
 * The observer used to call renderPage() the instant a page crossed the
 * margin, so flinging through a 600-page book queued a rasterise, a
 * getTextContent, a TextLayer build and a sentence pass for every page the
 * scroll swept over -- hundreds of them, all on the thread that has to move
 * the scrollbar. That is the lag: the work was for pages already long gone by
 * the time it ran.
 *
 * So intersecting only *queues* a page. The pump waits for the scroll to slow
 * down, then renders one page at a time, nearest the viewport first, dropping
 * anything that has since scrolled away. A fast fling therefore costs nothing
 * but the scroll itself, and settles into rendering what you actually stopped
 * on. Slow reading-speed scrolling is not throttled at all -- the gate is
 * velocity, not movement.
 */
const renderQueue = new Set();
const FAST_SCROLL = 1.5;   // px/ms — above this, rendering waits
const SCROLL_IDLE_MS = 100;
const DROP_MARGIN = 1200;  // px from the viewport; queued pages past this are dropped
let lastScrollAt = 0;
let lastScrollTop = 0;
let scrollVelocity = 0;    // px/ms, decayed to 0 once scrolling stops
let pumping = false;

function scrollingFast() {
  if (performance.now() - lastScrollAt > SCROLL_IDLE_MS) return false;
  return scrollVelocity > FAST_SCROLL;
}

/*
 * Distance in px from the viewport, or Infinity if the page is gone from the
 * index. Read off the cached geometry rather than a rect: this runs for every
 * queued page on every turn of the pump, and a rect there is a forced layout
 * in the middle of a fling. The index can be stale, so it is only ever
 * trusted to say a page is FAR -- never to overrule `visible`, which the
 * observer keeps honest.
 */
function offViewport(pn) {
  const g = geomFor(pn);
  if (!g) return Infinity;
  const top = el.viewer.scrollTop;
  const bottom = top + el.viewer.clientHeight;
  if (g.bottom < top) return top - g.bottom;
  if (g.top > bottom) return g.top - bottom;
  return 0;
}

/*
 * The backstop: whatever is on screen and not drawn gets asked for again.
 *
 * Every path into rendering is edge-triggered -- an intersection change, a
 * scroll event -- so any one of them missing its moment leaves a blank page
 * with nothing left to nudge it. This runs when the scroll settles and when
 * the queue drains, and is level-triggered: it looks at what is actually
 * there rather than at what happened.
 */
function ensureVisibleRendered() {
  if (!doc) return;
  for (const pn of visible) {
    const p = pages.get(pn);
    if (!p || p.rendered || p.rendering || renderQueue.has(pn)) continue;
    if ((p.renderFails ?? 0) >= MAX_RENDER_TRIES) continue; // it is not going to work
    queueRender(pn);
  }
}

// A page you are looking at is never left blank for longer than this, no
// matter which edge went missing.
setInterval(ensureVisibleRendered, 1500);

function queueRender(pn) {
  const p = pages.get(pn);
  if (!p || p.rendered || p.rendering) return;
  renderQueue.add(pn);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (renderQueue.size) {
      if (scrollingFast()) {
        await new Promise((r) => setTimeout(r, SCROLL_IDLE_MS));
        continue;
      }
      let next = null;
      let nearest = Infinity;
      for (const pn of renderQueue) {
        const p = pages.get(pn);
        if (!p || p.rendered) { renderQueue.delete(pn); continue; }
        // A page the observer says is on screen is never dropped, however
        // far the (stale-able) geometry index believes it to be. Dropping a
        // visible page is unrecoverable: nothing re-queues it, because it
        // never stopped intersecting and so never intersects again.
        const d = visible.has(pn) ? 0 : offViewport(pn);
        if (d > DROP_MARGIN) { renderQueue.delete(pn); continue; } // scrolled past
        if (d < nearest) { nearest = d; next = pn; }
      }
      if (next === null) continue;
      renderQueue.delete(next);
      // One page failing is one page, not the end of the queue: an
      // exception escaping here used to abandon everything still waiting.
      try { await renderPage(next); }
      catch (err) { console.warn(`[page ${next}] render failed`, err); }
      // Yield a frame between pages so a scroll that starts mid-queue is felt
      // immediately rather than after the whole backlog.
      await new Promise((r) => requestAnimationFrame(r));
    }
  } finally {
    pumping = false;
  }
  ensureVisibleRendered();
}

/**
 * Rasterise a page into its own canvas, cancelling whatever was already
 * drawing into it. PDF.js throws "Cannot use the same canvas during multiple
 * render() operations" if two render tasks share a canvas, and two of them
 * genuinely race here: the IntersectionObserver re-renders on scroll while
 * reZoom is walking every rendered page re-rasterising it. Reproduced in the
 * stress harness; this is the fix.
 */
async function paintCanvas(p, viewport) {
  if (p.renderTask) {
    try { p.renderTask.cancel(); } catch { /* already finished */ }
    p.renderTask = null;
  }
  const dpr = window.devicePixelRatio || 1;
  p.canvas.width = Math.floor(viewport.width * dpr);
  p.canvas.height = Math.floor(viewport.height * dpr);
  const ctx = p.canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const task = p.proxy.render({ canvasContext: ctx, viewport });
  p.renderTask = task;
  try {
    await task.promise;
  } catch (e) {
    // A cancelled render is the expected outcome of the race above, not an error.
    if (e?.name !== "RenderingCancelledException") throw e;
  } finally {
    if (p.renderTask === task) p.renderTask = null;
  }
}

/*
 * Rasterised pages are evicted once they're far from the viewport.
 *
 * Without this, every page scrolled past keeps its full-resolution canvas
 * backing store forever: measured on the 809-page biochemistry book at
 * devicePixelRatio 2, scrolling accumulated 3.3 GB of canvas memory (JS heap
 * stayed under 70 MB the whole time, which is why it looked fine) before the
 * harness stopped. That is the reported "crashes instantaneously" -- the tab
 * is killed for native memory, not for anything JS-visible.
 */
let frameSeq = 0; // stamped into each chapter's iframe so a stale load is recognisable

const MAX_RASTERISED = 14;
const renderOrder = []; // page numbers, most recently rendered last

function noteRendered(pn) {
  const i = renderOrder.indexOf(pn);
  if (i >= 0) renderOrder.splice(i, 1);
  renderOrder.push(pn);
  evictFarPages();
}

/**
 * Evict everything rasterised that is no longer near the viewport, ignoring
 * the LRU cap. During a fast scroll burst many pages finish rendering at
 * once and all of them briefly count as "near", so the cap alone let peak
 * canvas memory reach ~530 MB; sweeping on scroll holds it near the visible
 * working set instead.
 */
function sweepEvictions() {
  for (let i = renderOrder.length - 1; i >= 0; i--) {
    const pn = renderOrder[i];
    const p = pages.get(pn);
    if (!p) { renderOrder.splice(i, 1); continue; }
    if (speaking?.pn === pn || cursor?.pn === pn || loadingSentence?.pn === pn) continue;
    if (nearViewport(p, 600)) continue;
    renderOrder.splice(i, 1);
    evictPage(p);
  }
}

function evictFarPages() {
  while (renderOrder.length > MAX_RASTERISED) {
    // Oldest first, but never evict what is speaking, queued to speak next,
    // or still on screen -- those get skipped and stay in the list.
    const idx = renderOrder.findIndex((pn) => {
      const p = pages.get(pn);
      if (!p) return true;
      if (speaking?.pn === pn || cursor?.pn === pn || loadingSentence?.pn === pn) return false;
      return !nearViewport(p, 600);
    });
    if (idx < 0) return; // everything left is in use; let the cap slip rather than thrash
    const [pn] = renderOrder.splice(idx, 1);
    evictPage(pages.get(pn));
  }
}

/** Release a page's pixels and DOM. It re-renders from scratch when scrolled back to. */
function evictPage(p) {
  if (!p || !p.rendered) return;
  if (p.iframe) {
    // Epub chapter: drop the iframe's document (frees its whole render tree —
    // DOM, fonts, decoded images) but keep the div's measured height, the
    // same way a PDF shell keeps p.base, so the scrollbar doesn't jump.
    p.iframe.removeAttribute("srcdoc");
    p.svg.replaceChildren();
    p.labels.replaceChildren();
    p.sentences = [];
    p._epubNodeIndex = null;
    p.rendered = false;
    p.rendering = null;
    return;
  }
  if (p.renderTask) {
    try { p.renderTask.cancel(); } catch { /* already finished */ }
    p.renderTask = null;
  }
  // Setting either dimension to 0 is what actually frees the backing store;
  // clearing the context does not.
  p.canvas.width = 0;
  p.canvas.height = 0;
  p.textLayerDiv.replaceChildren();
  p.svg.replaceChildren();
  p.labels.replaceChildren();
  p.textLayer = null;
  p.textContent = null;
  p.sentences = [];
  p._geom = null;
  p.rendered = false;
  p.rendering = null;
  // p.regions is deliberately kept: it is page-fraction data, costs nothing,
  // and saves re-running the layout model if this page comes back.
}

async function renderPage(pn) {
  const p = pages.get(pn);
  if (!p || p.rendered) return p;
  // Resolve either way: a caller wanting the page rendered is not the place
  // to surface a render failure, and an unhandled rejection here would take
  // down whatever was awaiting it (openAt, the pump, a jump).
  if (p.rendering) return p.rendering.then(() => p, () => p);
  return isChapters() ? renderChapter(pn) : renderPdfPage(pn);
}

async function renderPdfPage(pn) {
  const p = pages.get(pn);
  p.rendering = (async () => {
    p.proxy = await doc.getPage(pn);
    const base = p.proxy.getViewport({ scale: 1 });
    const was = p.base;
    const resized = !was || was.height !== base.height || was.width !== base.width;
    p.base = { width: base.width, height: base.height };
    const viewport = p.proxy.getViewport({ scale });
    sizePage(p.div, p.base);
    if (resized) {
      markGeomDirty(); // this page was standing at the sampled placeholder size
      // A shell that grows or shrinks while sitting *above* the viewport
      // moves everything below it down or up -- which reads as the page you
      // are actually looking at lurching under you, a page you never saw
      // resize. Take the same delta back out of the scroll offset so the
      // view stays put. (Pages at or below the viewport top are free to
      // resize: nothing already on screen moves.)
      const g = geomFor(pn);
      if (was && g && g.bottom <= el.viewer.scrollTop) {
        scrollByWithoutFling((p.base.height - was.height) * scale);
      }
    }
    // The text layer positions itself off --total-scale-factor, which it
    // inherits from #pages; everything else about it is percentage-based, so
    // that one variable is all it needs (02 §3).

    await paintCanvas(p, viewport);

    // Fonts are only registered as @font-face once the render task has loaded
    // them, so the text layer must come after render() (02 §5).
    const textContent = await p.proxy.getTextContent();
    p.textContent = textContent;
    p.textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: p.textLayerDiv,
      viewport,
    });
    await p.textLayer.render();

    buildSentences(p, p.regions ?? undefined);
    p.rendered = true;
    noteRendered(pn);
    if (el.showall.checked) paintAllBands(p);
    report();
  })();

  await settleRender(p, pn);
  // Opt-in, default off (16 §latest feedback): this used to fire from every
  // page the IntersectionObserver merely scrolled into view, which meant
  // *scrolling* a document — not reading it — queued several seconds of
  // WASM inference per page, on the browser's main thread, for pages the
  // reader may never listen to. That's the scroll jank that was reported.
  // Reading order is still worth having; it just has to be asked for.
  if (p.rendered && el.enableLayout.checked) refineLayout(p); // background, not awaited
  return p;
}

/**
 * An EPUB chapter's iframe *is* its text layer -- there is no separate
 * extraction step. The sandbox has allow-same-origin but not allow-scripts,
 * so the book's own markup can't run anything, but contentDocument is
 * synchronously readable from here, which is what buildEpubSentences (below)
 * walks with a TreeWalker to find real text nodes and build real Ranges
 * against, the same way [[02]]'s PDF text layer does.
 */
/*
 * Put a chapter in its iframe and do not come back until THAT chapter is the
 * document sitting in it.
 *
 * The naive version -- listen for one "load", set srcdoc -- measures the
 * wrong document, and the way it fails is the worst kind: silently, and
 * permanently. Evicting a chapter drops its srcdoc, which navigates the
 * frame to about:blank; that navigation is still in flight when the reader
 * scrolls back and the chapter is asked for again, so its load event fires
 * first and resolves the wait. The chapter is then measured against a blank
 * document (height 1), marked rendered, and never looked at again -- a page
 * that is blank and refuses to load however many times you return to it.
 * The same race is guaranteed, not merely likely, on a typeface change,
 * which evicts and re-renders every open chapter in one tick.
 *
 * So each load carries a token, and only a load that brings back *our*
 * token counts. Anything else -- about:blank, a superseded chapter -- is
 * ignored and the wait continues. If nothing arrives, the page is left
 * unrendered rather than marked done: blank-and-retryable beats
 * blank-forever.
 */
const FRAME_LOAD_MS = 5000;
const FONTS_MS = 3000;
const IMAGES_MS = 6000;

/** Wait for a promise, but never longer than ms -- and never throw. */
function deadline(promise, ms) {
  if (!promise) return Promise.resolve();
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((r) => setTimeout(r, ms)),
  ]);
}

async function loadChapterFrame(p, html, token) {
  const arrived = () => {
    try { return p.iframe.contentDocument?.documentElement?.dataset?.blitzDoc === token; }
    catch { return false; } // cross-origin about:blank; not ours either way
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) {
      // Clear it first: assigning the identical srcdoc back is not
      // guaranteed to start a fresh navigation.
      p.iframe.removeAttribute("srcdoc");
      await new Promise((r) => requestAnimationFrame(r));
    }
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        p.iframe.removeEventListener("load", onLoad);
        resolve();
      };
      const onLoad = () => { if (arrived()) finish(); };
      const timer = setTimeout(finish, FRAME_LOAD_MS);
      p.iframe.addEventListener("load", onLoad);
      p.iframe.srcdoc = html;
    });
    if (arrived()) return true;
  }
  return false;
}

async function renderChapter(pn) {
  const p = pages.get(pn);
  p.rendering = (async () => {
    const chapter = doc.chapters[pn - 1];
    const token = `${pn}:${++frameSeq}`;
    const html = epubShellHtml(chapter, token);

    // Lay the chapter out at its natural width before measuring: the iframe
    // must not still be carrying a previous zoom's transform or size, or the
    // height we measure is the wrong one to scale from.
    p.iframe.style.transform = "none";
    p.iframe.style.width = `${EPUB_PAGE_WIDTH}px`;
    p.iframe.style.height = "";

    if (!await loadChapterFrame(p, html, token)) {
      console.warn(`[page ${pn}] chapter frame never loaded; leaving it to retry`);
      return;
    }
    // Everything waited for here is given a deadline. The render pump is a
    // single lane, so anything that never settles does not stall one page --
    // it stalls every page after it, for good. A lazily-loaded image is
    // exactly that hazard: the frame is still at its default height when
    // this runs, so an image further down is outside the frame's own
    // viewport and never loads, and neither "load" nor "error" ever comes.
    await deadline(p.iframe.contentDocument.fonts?.ready, FONTS_MS);
    // An <img> with no size yet reports zero height, so a cover or figure
    // page measured before its image decodes comes out far too short --
    // that's what an internal iframe scrollbar on an otherwise-plain page
    // was: the div was sized to a too-small pre-image measurement, and the
    // image then finished loading into a box too short to hold it.
    const imgs = [...p.iframe.contentDocument.images];
    for (const img of imgs) img.loading = "eager"; // see above: lazy never arrives in here
    await deadline(Promise.all(imgs.map((img) => img.complete
      ? null
      : new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); }))), IMAGES_MS);

    // Step two of "nothing is clipped" (see fitWideContent): whatever could
    // not be made to scroll inside itself widens the page instead. Capped,
    // because a genuinely pathological element should make one odd page
    // rather than a mile-wide one -- and it says so if it hits the cap.
    let width = EPUB_PAGE_WIDTH;
    const spill = fitWideContent(p.iframe.contentDocument);
    if (spill > 2) {
      width = Math.min(EPUB_PAGE_WIDTH + spill, EPUB_PAGE_WIDTH * 3);
      p.iframe.style.width = `${width}px`;
      const left = fitWideContent(p.iframe.contentDocument);
      if (left > 2) console.warn(`[page ${pn}] ${left}px still outside the page after widening it`);
    }

    const h = Math.max(1, p.iframe.contentDocument.documentElement.scrollHeight);
    const resized = !p.base || p.base.height !== h || p.base.width !== width;
    // Natural, unscaled size -- the same contract as a PDF page's p.base,
    // which holds its scale-1 viewport. sizeEpubChapter multiplies by zoom.
    const wasHeight = p.base?.height ?? null;
    p.base = { width, height: h };
    sizeEpubChapter(p);
    if (resized) {
      // Same as a PDF shell learning its real size: a chapter that grows
      // above the viewport would otherwise shove whatever you are reading.
      const g = geomFor(pn);
      markGeomDirty();
      if (wasHeight !== null && g && g.bottom <= el.viewer.scrollTop) {
        scrollByWithoutFling((h - wasHeight) * scale);
      }
    }

    wireEpubInput(p);
    buildEpubSentences(p);
    p.rendered = true;
    noteRendered(pn);
    if (el.showall.checked) paintAllBands(p);
    report();
  })();

  await settleRender(p, pn);
  return p;
}

/*
 * p.rendering is what queueRender and renderPage test to decide a page is
 * already being dealt with, and nothing ever cleared it on the way out. A
 * render that threw -- or that gave up waiting for its frame -- therefore
 * left a page unrendered AND permanently unaskable: the one shape of blank
 * page that no amount of scrolling back can fix. A failure now clears the
 * flag and asks again shortly.
 */
const MAX_RENDER_TRIES = 3;

async function settleRender(p, pn) {
  try {
    await p.rendering;
  } catch (err) {
    console.warn(`[page ${pn}] render failed`, err);
  }
  if (p.rendered) { p.renderFails = 0; return; }
  p.rendering = null;
  p.renderFails = (p.renderFails ?? 0) + 1;
  // Bounded: a page that cannot be drawn must not become a hot loop between
  // the retry and the backstop that notices it is still blank.
  if (p.renderFails < MAX_RENDER_TRIES) setTimeout(() => queueRender(pn), 400);
  else console.warn(`[page ${pn}] gave up after ${p.renderFails} attempts`);
}

/*
 * Nothing is ever clipped, in two steps.
 *
 * A chapter's page cannot carry a horizontal scrollbar of its own: its
 * height is measured from its content, so it has to be overflow:hidden, and
 * anything sticking out past the column would simply be cut off with no sign
 * it was ever there. That is the one failure a reader cannot detect, so it
 * is not allowed to happen.
 *
 * Step one, here: anything wider than the column that can reasonably scroll
 * inside itself is made to -- a long shell command, a wide table. Restricted
 * to block-ish candidates rather than every node, because each read forces a
 * layout and a docs page has thousands of nodes.
 *
 * Step two is the caller's (renderChapter): whatever is STILL too wide after
 * that widens the page itself. A page 60px wider than its neighbours is a
 * cosmetic oddity; a page missing its right-hand 60px is a lie.
 */
const WIDE_CANDIDATES = "pre, table, figure, img, svg, div, section, blockquote, dl, ul, ol, p, h1, h2, h3";

function fitWideContent(idoc) {
  const limit = idoc.documentElement.clientWidth;
  if (!limit) return 0;
  for (const el of idoc.body.querySelectorAll(WIDE_CANDIDATES)) {
    if (el.scrollWidth <= limit + 1) continue;
    // An inline box cannot scroll; make it a block first or the rule is a
    // no-op and the content stays outside the page.
    if (getComputedStyle(el).display.startsWith("inline")) el.style.display = "block";
    el.style.maxWidth = "100%";
    el.style.overflowX = "auto";
  }
  return Math.max(0, idoc.documentElement.scrollWidth - limit);
}

/*
 * A chapter's iframe takes pointer events itself, so its text can be
 * selected and its links followed. That costs the free ride events used to
 * get: DOM events inside an iframe never bubble into the parent document, so
 * anything the reader wants to know about has to be handed out explicitly.
 *
 * That is now two things only -- a click on one of the page's own links, and
 * a right-click asking for the menu. Ordinary clicks, drags and hovers are
 * left entirely alone inside the frame, which is what makes the page behave
 * like a document rather than like a play button.
 *
 * Coordinates come back in the iframe's own viewport, which is unscaled --
 * the zoom is a transform on the element, so its internal coordinate system
 * never learns about it. Multiplying by the scale and offsetting by the
 * iframe's on-screen box puts them back in client space, which is what
 * every handler downstream already speaks.
 */
function wireEpubInput(p) {
  const cd = p.iframe.contentDocument;
  if (!cd || cd.__blitzWired) return;
  cd.__blitzWired = true;
  const toClient = (e) => {
    const b = p.iframe.getBoundingClientRect();
    return { x: b.left + e.clientX * scale, y: b.top + e.clientY * scale };
  };
  const linkAt = (e) => {
    // A snapshotted site's own cross-references still work: site.js turned
    // every <a> into a marker rather than a link, because nothing can
    // navigate inside a srcdoc iframe. A link into the book jumps; a link
    // out of it opens in the real browser (main.js's setWindowOpenHandler).
    // Not just anchors: a video that could not be embedded becomes a card
    // carrying the same data-external, and clicking it should do the same
    // thing clicking the video would have.
    const a = e.target?.closest?.("[data-page], [data-external]");
    if (!a) return null;
    const to = a.getAttribute("data-page");
    return to
      ? { page: Number(to), frag: a.getAttribute("data-frag") || null }
      : { external: a.getAttribute("data-external") };
  };

  cd.addEventListener("click", (e) => {
    const link = linkAt(e);
    if (!link) return; // a plain click belongs to the document, not to us
    e.preventDefault();
    if (link.page) goToPage(link.page, null, link.frag);
    else window.open(link.external, "_blank");
  });
  cd.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const { x, y } = toClient(e);
    openMenu(menuTargetAt(p, x, y, linkAt(e)), x, y);
  });
  // Where a link goes, before you commit to it. A snapshotted link is a
  // marker, not an <a href>, so the browser has nothing to put in its own
  // status bar -- if the app doesn't say, nobody does.
  // mouseover alone is enough to both show and hide: moving off a link and
  // onto anything else fires it again, with no link under the pointer.
  cd.addEventListener("mouseover", (e) => showLinkPeek(linkAt(e)));
  cd.addEventListener("mouseleave", () => showLinkPeek(null));
  // The menu is in the parent document, so a press inside the frame has to
  // dismiss it explicitly -- the parent never sees this one.
  cd.addEventListener("mousedown", closeMenu);

  // Word hover-preview and double-click-to-play, epub side -- see the note
  // above openMenu. toClient() puts iframe-local coordinates back in outer
  // client space, same as the contextmenu handler just above.
  cd.addEventListener("mousemove", (e) => {
    const { x, y } = toClient(e);
    handleWordHover(p, x, y);
  });
  cd.addEventListener("mouseleave", () => setHoveredWord(null));
  cd.addEventListener("dblclick", (e) => {
    const { x, y } = toClient(e);
    handleWordDblClick(p, x, y);
  });
}

/*
 * Say where a link goes, in the corner a browser would.
 *
 * An in-book jump is named, not numbered: "page 8" tells a reader nothing
 * they wanted to know, and the chapter's own title is what the contents
 * list calls it. An external link shows its address, host first, because
 * the host is the part that decides whether you want to follow it.
 */
function showLinkPeek(link) {
  if (!link) { el.linkPeek.hidden = true; return; }
  if (link.page) {
    const title = doc?.toc?.find((t) => t.pn === link.page)?.title
      ?? doc?.chapters?.[link.page - 1]?.title
      ?? `${unitWord()} ${link.page}`;
    el.linkPeek.classList.remove("external");
    el.linkPeekIcon.textContent = "↳";
    el.linkPeekText.textContent = link.frag ? `${title} — ${link.frag.replace(/-/g, " ")}` : title;
  } else {
    let shown = link.external;
    try {
      const u = new URL(link.external);
      shown = u.host + (u.pathname === "/" ? "" : u.pathname) + u.search + u.hash;
    } catch { /* not a URL we can prettify; show it whole */ }
    el.linkPeek.classList.add("external");
    el.linkPeekIcon.textContent = "↗";
    el.linkPeekText.textContent = shown;
  }
  el.linkPeek.hidden = false;
}

/**
 * The HTML document an epub chapter's sandboxed iframe gets as its srcdoc.
 *
 * The !important rules here are a deliberate fight with the book's own CSS,
 * not an oversight. A cover or title page is routinely authored assuming a
 * fixed device screen -- this book's cover.xhtml sets
 * `body{position:absolute;height:100%}` and `img{height:90vh}` -- which is a
 * reasonable thing to author against a real e-reader viewport and a broken
 * thing to hand a div that's supposed to size itself to its content: the
 * image renders at 90% of whatever height the iframe happens to have *that
 * instant* with no matching width constraint, so it can overflow the page
 * sideways, and the chapter's real content height becomes unmeasurable
 * (position:absolute takes an element out of the flow scrollHeight sums).
 * Forcing position/height/display back to normal flow, and forcing images
 * to fit the page's own width instead of the book's assumed screen, is what
 * every general-purpose reflowable reading view does with this pattern --
 * it costs the *one* case where a book deliberately set a smaller display
 * width or height on a figure, but wins every fixed-layout-flavoured page.
 */
// A book's own headHtml loads *after* this shell's <style>, so any font it
// sets on `body` already wins over an unenforced default here -- true both
// before this change (the original Georgia fallback) and after. What's new
// is a deliberate, `!important` override once the reader has actually
// picked a non-"original" typeface: at that point the choice is meant to
// win regardless of what the book asked for, the same way the position/
// height overrides above always win over the book's own fixed-layout CSS.
// "original" leaves no font-family rule here at all, so the book's own
// choice (or the browser default, if it set none) applies untouched.
const EPUB_FONT_STACKS = {
  serif: '"Lora", Georgia, "Times New Roman", serif',
  sans: '"Work Sans", ui-sans-serif, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
};

// A chapter renders in its own srcdoc document, so the fonts the app itself
// loaded are not available to it -- naming "Lora" in there without this
// silently fell back to a generic serif. Importing the files through Vite
// gets URLs that survive the production build's asset fingerprinting, which
// hardcoded paths would not.
const EPUB_FONT_FACE_CSS = `
  @font-face { font-family: "Lora"; font-style: normal; font-weight: 400 700; src: url("${loraUrl}") format("woff2"); }
  @font-face { font-family: "Lora"; font-style: italic; font-weight: 400 700; src: url("${loraItalicUrl}") format("woff2"); }
  @font-face { font-family: "Work Sans"; font-style: normal; font-weight: 400 700; src: url("${workSansUrl}") format("woff2"); }
  @font-face { font-family: "IBM Plex Mono"; font-style: normal; font-weight: 400; src: url("${plexMonoUrl}") format("woff2"); }
`;

function epubShellHtml(chapter, token = "") {
  const fontRule = EPUB_FONT_STACKS[epubFont]
    ? `font-family: ${EPUB_FONT_STACKS[epubFont]} !important;`
    : "";
  // Font size, line width and line spacing are custom properties, not
  // baked-in values, so a slider drag can restyle already-open chapters live
  // (applyEpubTypography) instead of re-rendering a chapter -- and losing
  // scroll position and playback state -- on every tick.
  //
  // Note what is NOT here: zoom. A chapter always lays out at
  // EPUB_PAGE_WIDTH, so its line breaks are the same at every zoom level;
  // magnification is a transform applied to the whole rendered chapter from
  // outside (sizeEpubChapter). Font size is the separate control that does
  // reflow, which is the distinction real reading systems draw too.
  return `<!doctype html><html data-blitz-doc="${token}" style="--reader-text-scale:${epubTextScale()}; --reader-max-width:${epubLineWidth}px; --reader-line-height:${epubLineHeight}"><head><meta charset="utf-8">` +
    `<style>
      ${EPUB_FONT_FACE_CSS}
      html, body { margin: 0; background: #fff; color: #14161a; overflow: hidden; }
      body {
        /*
         * Text size is a proportional scale, not an inherited font-size.
         * Books routinely hardcode absolute sizes -- this one ships
         * "h3, p { font-size: 18px }" -- and an absolute rule on the
         * paragraph beats any size inherited from body, so setting
         * body{font-size} moved the body and left the prose at 18px.
         * "zoom" multiplies used values instead, so the book's own
         * hierarchy (heading vs prose vs caption) survives intact and the
         * text actually reflows. The column and padding are divided by the
         * same factor so the measure stays physically put and only the
         * glyphs grow -- which is what makes this a text-size control and
         * not a second zoom.
         */
        zoom: var(--reader-text-scale, 1);
        line-height: var(--reader-line-height, 1.6);
        ${fontRule}
        padding: calc(48px / var(--reader-text-scale, 1)) calc(60px / var(--reader-text-scale, 1));
        max-width: calc(var(--reader-max-width, 720px) / var(--reader-text-scale, 1));
        margin: 0 auto;
        overflow-wrap: break-word;
        position: static !important;
        height: auto !important;
        width: auto !important;
      }
      img, svg {
        max-width: 100% !important;
        width: auto !important;
        height: auto !important;
      }
      /*
       * Nothing gets clipped. The page carries overflow:hidden because its
       * height is measured from its content, so anything wider than the
       * column would otherwise be cut off with no scrollbar and no sign it
       * was ever there -- a long shell command, a wide table. These scroll
       * inside themselves instead; fitWideContent() below catches whatever
       * this selector misses.
       */
      pre, table, figure, .highlight, .wy-table-responsive, .md-typeset__table,
      .tabbed-content, .doctest, .literal-block-wrapper {
        max-width: 100%;
        overflow-x: auto;
      }

      /*
       * A video that could not be carried into the snapshot, shown as the
       * thing it is: a still, a play badge, and one click out to where it
       * actually plays. A token reading "[video]" told you something was
       * missing; this tells you what it is and hands it to you.
       */
      .blitzMedia {
        display: block;
        margin: 1.4em 0;
        cursor: pointer;
      }
      .blitzMediaFrame {
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
        aspect-ratio: 16 / 9;
        border-radius: 6px;
        overflow: hidden;
        background: #1b1d21;
      }
      .blitzMediaFrame img {
        width: 100% !important;
        height: 100% !important;
        object-fit: cover;
        display: block;
        opacity: .82;
        transition: opacity .15s ease, transform .3s ease;
      }
      .blitzMedia:hover .blitzMediaFrame img { opacity: 1; transform: scale(1.02); }
      .blitzMediaPlay {
        position: absolute;
        width: 58px;
        height: 40px;
        border-radius: 9px;
        background: rgba(20, 22, 26, .72);
        box-shadow: 0 2px 12px rgba(0, 0, 0, .35);
        transition: background .15s ease, transform .15s ease;
      }
      .blitzMediaPlay::after {
        content: "";
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-42%, -50%);
        border-style: solid;
        border-width: 8px 0 8px 13px;
        border-color: transparent transparent transparent #fff;
      }
      .blitzMedia:hover .blitzMediaPlay { background: #b45a32; transform: scale(1.06); }
      .blitzMedia figcaption {
        margin-top: .5em;
        font-size: .85em;
        opacity: .72;
      }
      .blitzMedia:hover figcaption { opacity: 1; }

      /* Something else that could not be saved -- an embedded demo, a figure
         whose file would not load. Visible on purpose: a page that quietly
         drops something is worse than one that says it did. */
      .blitzMissing {
        display: inline-block;
        margin: .6em 0;
        padding: .35em .7em;
        border: 1px dashed rgba(0, 0, 0, .22);
        border-radius: 3px;
        font-size: .85em;
        font-style: italic;
        opacity: .7;
      }

      /* Text here IS selectable: a note has to be able to quote any
         passage, not just one the voice happens to be on. Clicks are
         forwarded back out to the reader's handlers (wireEpubInput), which
         ignore a click that ends a selection drag. */
      ::selection { background: rgba(180, 90, 50, .22); }
    </style>` +
    // A site's own stylesheet, if this is a site. It belongs to the whole
    // snapshot rather than to any one page, so it lives on the document and
    // is injected here, in exactly the slot a book's own headHtml occupies:
    // after the reader's shell, so the site's styling wins wherever the
    // shell did not have to force the point with !important.
    (doc?.css ? `<style>${doc.css.replaceAll("</style", "<\\/style")}</style>` : "") +
    chapter.headHtml +
    `</head><body>${chapter.bodyHtml}</body></html>`;
}

/**
 * Apply the current zoom to one chapter, PDF-style: the chapter's own
 * document keeps laying out at its natural size (EPUB_PAGE_WIDTH by
 * p.base.height) and the whole rendered result is scaled visually, so a
 * zoom gesture magnifies the page instead of re-wrapping its text. The
 * outer div carries the scaled size because a CSS transform doesn't affect
 * layout, and the scroll flow -- and therefore the geometry index -- needs
 * the space the chapter actually occupies.
 */
function sizeEpubChapter(p) {
  if (!p.base) return;
  p.div.style.width = `${p.base.width * scale}px`;
  p.div.style.height = `${p.base.height * scale}px`;
  if (!p.iframe) return;
  p.iframe.style.width = `${p.base.width}px`;
  p.iframe.style.height = `${p.base.height}px`;
  p.iframe.style.transform = `scale(${scale})`;
}

/** Is this page in or near the visible scroll window? */
function nearViewport(p, margin = 800) {
  const b = p.div.getBoundingClientRect();
  const v = el.viewer.getBoundingClientRect();
  return b.bottom > v.top - margin && b.top < v.bottom + margin;
}

/**
 * TICKET 06. The DOM-order sentences above are the fallback, available
 * immediately so the page is speakable without waiting on a model. This
 * runs the layout model in the background and, if it returns anything
 * usable, rebuilds the page's sentences in true reading order.
 *
 * Deliberately not awaited by renderPage: onnxruntime-web (WASM) is
 * measured at several seconds a page, far slower than [[12]]'s ~731ms on
 * native onnxruntime-node, and blocking the page render on it would
 * reintroduce exactly the scroll stall fixed earlier this session, just
 * from a slower cause. A page is visible and speakable the instant PDF.js
 * finishes; whether its order is *correct* catches up a few seconds later.
 *
 * Known rough edge, accepted for a prototype: if playback is already
 * mid-page when this resolves, p.sentences is replaced under it — indices
 * a live cursor holds can end up pointing at a different sentence. Judging
 * order-correctness doesn't require fixing that; a real build would.
 */
async function refineLayout(p) {
  p.layoutLoading = true;
  p.div.classList.add("layout-loading");
  repaint();
  try {
    // Scrolling fast queues one of these per page passed. Analysis is off the
    // main thread now (see layout-server.mjs) so a backlog no longer freezes
    // anything, but analysing 90 pages someone scrolled past is still pure
    // waste. Settle briefly, then only proceed if the page is still near the
    // viewport -- a page scrolled away from drops out here.
    await new Promise((r) => setTimeout(r, 600));
    if (pages.get(p.pn) !== p) return;
    if (!nearViewport(p)) return;
    const regions = await analyzeLayout(p.canvas);
    if (pages.get(p.pn) !== p) return; // doc changed under us; discard
    p.regions = regions;
    buildSentences(p, regions);
    if (listedPage === p.pn) { listedPage = null; renderSentenceList(p.pn); }
  } catch (e) {
    console.warn("[layout] analysis failed, keeping DOM order for page", p.pn, e);
  } finally {
    p.layoutLoading = false;
    p.div.classList.remove("layout-loading");
    repaint();
  }
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;

/*
 * Zoom in two halves.
 *
 * `applyScale` is synchronous and instant: it resizes every page shell from
 * the cached unscaled size and fixes the scroll position so the point under
 * the cursor stays under the cursor. The canvases are CSS-sized to their
 * shell, so the already-drawn bitmaps stretch immediately -- blurry, but
 * there, and the text layer follows because it positions everything off
 * --total-scale-factor. Ctrl+wheel therefore tracks the wheel with no
 * rasterising in the loop at all.
 *
 * `rasteriseAtScale` then redraws the pages that are actually rendered, once
 * the gesture settles. This used to be one pass that awaited doc.getPage() per
 * page while resizing, which made the document's height change 611 times
 * during a zoom and put the anchor somewhere else entirely.
 */
function applyScale(next, anchorClientY = null) {
  const prev = scale;
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  el.zoomOut.textContent = scale.toFixed(2);
  el.zoom.value = String(scale);
  if (!doc || scale === prev) return;

  // Anchor: the point that must not move. Default is the middle of the
  // viewport, which is what the zoom slider should feel like; ctrl+wheel
  // passes the pointer instead.
  const viewerTop = el.viewer.getBoundingClientRect().top;
  const anchor = anchorClientY == null
    ? el.viewer.clientHeight / 2
    : Math.max(0, Math.min(el.viewer.clientHeight, anchorClientY - viewerTop));
  const at = el.viewer.scrollTop + anchor;
  const before = pageAtOffset(at);
  const frac = before && before.bottom > before.top
    ? (at - before.top) / (before.bottom - before.top)
    : null;

  el.pages.style.setProperty("--zoom", String(scale));
  el.pages.style.setProperty("--total-scale-factor", String(scale));
  rescaleGeom(scale / prev);

  // Re-anchor off the same page rather than scaling scrollTop by the zoom
  // ratio: the gaps between pages do not scale, so the ratio drifts. The
  // anchor page's new position is read back from the DOM rather than taken
  // from the rescaled index -- that read forces one layout, but a stale
  // half-pixel here compounds across a wheel gesture into visible slippage.
  const anchorDiv = before ? pages.get(before.pn)?.div : null;
  if (anchorDiv && frac !== null) {
    const top = anchorDiv.offsetTop;
    const height = anchorDiv.offsetHeight;
    const e = geomFor(before.pn);
    if (e) { e.top = top; e.bottom = top + height; }
    el.viewer.scrollTop = top + frac * height - anchor;
  } else {
    el.viewer.scrollTop = (at * (scale / prev)) - anchor;
  }

  // No repaint: the overlay is a viewBox="0 0 1 1" SVG over a page-fraction
  // coordinate system, so it rescales with the page for free.
  report();
}

async function rasteriseAtScale() {
  if (!doc) return;
  // Two of these overlapping means two render tasks per canvas, which PDF.js
  // refuses; the generation check drops the older walk.
  const gen = ++zoomGeneration;
  for (const p of pages.values()) {
    if (gen !== zoomGeneration) return;
    if (!p.rendered) continue;
    const viewport = p.proxy.getViewport({ scale });
    await paintCanvas(p, viewport);
    if (gen !== zoomGeneration) return;
    // The page can be evicted while that await is outstanding, which nulls
    // the text layer out from under us.
    if (!p.rendered || !p.textLayer) continue;
    p.textLayer.update({ viewport });
    // NOTE: p.sentences is deliberately NOT recomputed. The rects are page
    // fractions, so zoom is meant to cost nothing. If the band drifts after a
    // zoom, that claim (02 §6) is wrong and the ticket should say so.
  }
  // The index was transformed rather than re-measured during the gesture;
  // resync it from the DOM now that the zoom has stopped moving.
  markGeomDirty();
  repaint();
  report();
}

/*
 * Never open a book already scrolled sideways.
 *
 * The default 1.2x zoom was chosen when the window had one panel; with the
 * contents rail on the left and settings on the right there is less room for
 * the page, and an EPUB chapter (760px of layout) overflowed it -- a book
 * that opens with a horizontal scrollbar reads as broken. This only ever
 * zooms *out*, and only at open, so a zoom the reader chose is never
 * second-guessed.
 */
function fitToWidth() {
  const p = pages.get(1);
  if (!p?.base) return;
  const room = el.viewer.clientWidth - 32; // a little air either side of the page
  const fits = room / p.base.width;
  if (fits < scale) reZoom(Math.max(MIN_SCALE, fits));
}

let rasterTimer;
function reZoom(next, anchorClientY = null) {
  if (isChapters()) return applyEpubScale(next, anchorClientY);
  applyScale(next, anchorClientY);
  clearTimeout(rasterTimer);
  rasterTimer = setTimeout(rasteriseAtScale, 150);
}

/**
 * Zoom for an epub is magnification, not reflow. Earlier this multiplied a
 * --zoom font-size variable inside each chapter, which re-wrapped every line
 * on every tick: that is a *text size* control wearing a zoom gesture's
 * clothes, and it made "zoom in" mean "get different line breaks" rather
 * than "look closer at the same page". Now a chapter always lays out at
 * EPUB_PAGE_WIDTH and the rendered result is scaled from outside, exactly
 * like a PDF page's already-drawn bitmap stretching to the new size.
 *
 * That also makes zoom nearly free here, matching PDF: no chapter reflows,
 * nothing is remeasured, and no sentence rects are dropped -- they are page
 * fractions, and scaling a page uniformly leaves every fraction unchanged.
 * Text size, which *does* reflow, is a separate control in the panel.
 */
function applyEpubScale(next, anchorClientY = null) {
  const prev = scale;
  scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
  el.zoomOut.textContent = scale.toFixed(2);
  el.zoom.value = String(scale);
  if (!doc || scale === prev) return;

  const viewerTop = el.viewer.getBoundingClientRect().top;
  const anchor = anchorClientY == null
    ? el.viewer.clientHeight / 2
    : Math.max(0, Math.min(el.viewer.clientHeight, anchorClientY - viewerTop));
  const at = el.viewer.scrollTop + anchor;
  const before = pageAtOffset(at);
  const frac = before && before.bottom > before.top
    ? (at - before.top) / (before.bottom - before.top)
    : null;

  for (const p of pages.values()) sizeEpubChapter(p);
  markGeomDirty();

  const g = geomFor(before?.pn);
  el.viewer.scrollTop = g && frac !== null
    ? g.top + frac * (g.bottom - g.top) - anchor
    : Math.max(0, at - anchor);

  repaint();
  report();
}

/**
 * Line width/spacing, live -- same shape as applyEpubScale just above, minus
 * the scroll-anchoring math: a settings-panel slider isn't zooming toward a
 * pointer, so preserving absolute scrollTop (not a fractional position
 * within whichever page is under the cursor) is the right anchor here.
 */
function applyEpubTypography() {
  if (!doc || !isChapters()) return;
  for (const p of pages.values()) {
    if (!p.rendered || !p.iframe?.contentDocument) continue;
    const root = p.iframe.contentDocument.documentElement;
    root.style.setProperty("--reader-text-scale", String(epubTextScale()));
    root.style.setProperty("--reader-max-width", `${epubLineWidth}px`);
    root.style.setProperty("--reader-line-height", String(epubLineHeight));
    // Unlike zoom, these genuinely reflow the chapter, so its natural height
    // changes and every cached rect describes the old layout.
    // Keep the width this page was measured at: a page widened to hold a
    // table it could not otherwise show must not be narrowed back into
    // clipping it because a font slider moved.
    p.base = { width: p.base?.width ?? EPUB_PAGE_WIDTH, height: Math.max(1, root.scrollHeight) };
    sizeEpubChapter(p);
    for (const s of p.sentences) { s.rects = null; s.words = null; }
  }
  markGeomDirty();
  repaint();
  report();
}

// ------------------------------------------------- sentences and geometry

function buildSentences(p, regions) {
  const strs = p.textLayer.textContentItemsStr;
  const divs = p.textLayer.textDivs;
  // textContentItemsStr mirrors textContent.items 1:1 while includeMarkedContent
  // is off; if that ever stops holding, fall back to no EOL separators.
  const src = p.textContent.items.length === strs.length ? p.textContent.items : [];

  // 02 said "join the strs". That is not quite enough: PDF.js emits no
  // whitespace at a line break (it appends a <br> to the DOM instead), so a
  // plain join welds the last word of one line onto the first of the next
  // ("It is thispersonality that..."), which segments wrong and speaks wrong.
  // Resolve each item's own string first, independent of order -- whether to
  // drop a trailing hyphen and whether a separator follows are both
  // properties of the item itself, not of whatever comes next, so this is
  // safe to do before 06's reordering below.
  let resolved = [];
  for (let i = 0; i < strs.length; i++) {
    const eol = Boolean(src[i]?.hasEOL);
    // A line broken mid-word leaves a hyphen behind ("accelerat-" / "ing").
    // Drop it and join with nothing, so TTS says "accelerating". The hyphen is
    // simply not part of the index space; the Range still covers it visually.
    const hyphenated = eol && /[-‐­]$/.test(strs[i]);
    const str = hyphenated ? strs[i].slice(0, -1) : strs[i];
    const sep = eol && !hyphenated && !/\s$/.test(str);
    resolved.push({ divIdx: i, str, sep, indexable: str.length > 0 });
  }

  const box = p.textLayerDiv.getBoundingClientRect();
  p._geom = { divs, box }; // getWordRects() needs these later; locate is per-sentence, below

  // 06: DOM order is a fallback, not the truth. PDF.js emits text in
  // content-stream order, which can interleave columns on a multi-column
  // page. When the layout model has already told us the true region order
  // (regions is set once analysis finishes, on a later render pass -- see
  // refineLayout), GROUP items by which region they fall in, by max-area
  // overlap, instead of trusting the stream -- each region becomes its own
  // independently-segmented run. No regions yet (or analysis failed) is one
  // group, the whole page, DOM order: exactly [[05]]'s original behaviour.
  //
  // Grouping, not just reordering, matters: a title has no full stop to end
  // on, so if its text and the following paragraph's text ever land in the
  // same Intl.Segmenter pass, nothing tells the segmenter they're different
  // sentences and it reads the two as one (reported directly: clicking a
  // paragraph also selected its title). Giving each region its own
  // segmenter pass makes that boundary structural, not punctuation-dependent.
  const groups = (regions && regions.length)
    ? groupByRegion(resolved, divs, box, regions)
    : [resolved];

  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  const out = [];

  for (const groupItems of groups) {
    const parts = [];
    const items = [];
    let acc = 0;
    for (const { divIdx, str, sep, indexable } of groupItems) {
      // Index only non-empty items: PDF.js creates a div for an empty str but
      // never appends it to the DOM, and a Range endpoint inside one throws (02 §3).
      if (indexable) items.push({ divIdx, start: acc, len: str.length });
      parts.push(str);
      acc += str.length;
      if (sep) { parts.push(" "); acc += 1; }
    }
    const pageText = parts.join("");
    if (!items.length) continue;

    const locate = (idx) => {
      let lo = 0, hi = items.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (items[mid].start <= idx) lo = mid; else hi = mid - 1;
      }
      return items[lo];
    };

    // One Intl.Segmenter sentence is one unit -- no smaller (an earlier
    // version of this file split further at clause punctuation to shorten
    // synth latency; reverted: that's a subtitle-style chop mid-sentence,
    // and the right fix for latency is prefetching ahead, not a smaller
    // unit). Still guard against Intl.Segmenter itself under-splitting: it
    // can occasionally treat two real sentences as one segment (an
    // abbreviation, an odd quote/citation pattern), and that's a genuine
    // bug worth catching here rather than living with a chunk that's
    // *larger* than a sentence.
    const spans = [];
    for (const { segment, index } of seg.segment(pageText)) {
      let s = index, e = index + segment.length;
      while (s < e && /\s/.test(pageText[s])) s++;
      while (e > s && /\s/.test(pageText[e - 1])) e--;
      if (e <= s) continue;
      for (const span of guardSentenceBoundaries(pageText, s, e)) spans.push(span);
    }

    // Nothing unpronounceable may become a unit of its own. A span with no
    // letters in it -- a list marker ("2."), a stray dash, the tail of a
    // split figure reference -- is absorbed into the sentence that follows
    // (or the one before, if it is last) rather than emitted.
    //
    // This is the fix for a real failure seen in the server log: a request
    // whose whole text was "-", which Kokoro rejects outright ("Nothing to
    // synthesize, '-' produced no phonemes"). The client skipped that
    // sentence, so the highlight advanced with no sound -- the reported
    // "audio doesn't work" case. Merging also stops numbered lists being
    // read aloud as "two." "three." "four."
    const kept = [];
    for (let i = 0; i < spans.length; i++) {
      const [a, b] = spans[i];
      if (!/[A-Za-z]/.test(pageText.slice(a, b))) {
        if (i + 1 < spans.length) { spans[i + 1][0] = a; continue; }
        if (kept.length) { kept[kept.length - 1][1] = b; continue; }
        continue; // nothing to attach to; drop it
      }
      kept.push([a, b]);
    }

    {
      for (const [as, ae] of kept) {
        const text = pageText.slice(as, ae);

        const rects = mergeLines(rangeRects(divs, box, locate, as, ae));
        if (!rects.length) continue;
        // Glyphs with no Unicode mapping (Δ in the Millington PDF) come
        // through as C0 control characters, not as nothing. Keep them in the
        // index space so the geometry stays right, but never hand them to TTS.
        const unmapped = (text.match(/[\u0000-\u001f]/g) ?? []).length;

        // Per-word geometry for the word cursor (16) is *offsets only* here —
        // not rects. Computing a Range + getClientRects() per word for every
        // sentence on every page, the moment it scrolls into view, forces a
        // synchronous layout reflow per word; on a normal page that's
        // hundreds of extra reflows just from scrolling past it, never mind
        // reading it. (Measured: this is what made fast scrolling through a
        // multi-page document stall.) getWordRects() below computes and
        // caches the actual rects lazily, the first time a sentence is about
        // to be spoken -- using *this group's* locate, stashed per-sentence,
        // since with regions on, different sentences on the same page can
        // come from different groups with different offset spaces.
        const wordSpans = [];
        for (const m of text.matchAll(/\S+/g)) {
          wordSpans.push({ text: m[0], ws: as + m.index, we: as + m.index + m[0].length });
        }

        out.push({
          pn: p.pn, si: out.length, text, rects, wordSpans, words: null, unmapped,
          speech: text.replace(/[\u0000-\u001f]+/g, " "),
          _locate: locate,
        });
      }
    }
  }
  p.sentences = out;
}

/**
 * Intl.Segmenter already finds sentence boundaries; this only catches the
 * case where it missed one -- a run of *two* sentence-ending marks (one
 * mid-string) inside what it called a single segment. Splits there too, so
 * the unit handed to speech and the highlight is never larger than one
 * sentence. Does not try to be a better sentence splitter than
 * Intl.Segmenter; it only refuses to trust a segment that visibly contains
 * more than one.
 */
function guardSentenceBoundaries(pageText, s, e) {
  const text = pageText.slice(s, e);
  // The lookahead deliberately excludes digits. Allowing them split every
  // numbered list marker into its own "sentence" -- measured on the
  // biochemistry book, "2." "3." "4." … were being spoken as standalone
  // utterances, and figure references ("see Fig. 3.21).") were cut in half
  // at the abbreviation's full stop. A real missed boundary is followed by a
  // capital or an opening quote, not by a digit.
  const boundary = /[.!?][”"'’)\]]*\s+(?=[A-Z"“'’(])/g;
  const MIN_CHUNK = 20; // don't cut after "Fig." or "No." -- too short to be a sentence
  const cuts = [];
  let last = 0;
  for (const m of text.matchAll(boundary)) {
    const cut = m.index + m[0].length;
    if (cut - last < MIN_CHUNK) continue;
    cuts.push(cut);
    last = cut;
  }
  if (!cuts.length) return [[s, e]];
  const spans = [];
  let start = 0;
  for (const cut of cuts) { spans.push([s + start, s + cut]); start = cut; }
  spans.push([s + start, e]);
  return spans
    .map(([a, b]) => {
      while (a < b && /\s/.test(pageText[a])) a++;
      while (b > a && /\s/.test(pageText[b - 1])) b--;
      return [a, b];
    })
    .filter(([a, b]) => b > a);
}

/**
 * Group resolved text items by which layout region they fall in (max-area
 * overlap, matching [[06]]'s research at a 10% threshold): sorted first by
 * region (in the model's reading order), then by original relative order
 * within a region (stable sort — correct almost always, since a single
 * column/region's own stream order is already top-to-bottom). Returns
 * contiguous per-region runs, each to be segmented independently by
 * buildSentences — a title's region and the following paragraph's region
 * must never share one Intl.Segmenter pass, or a title with no ending
 * punctuation reads as the first clause of the next sentence (reported
 * directly: clicking a paragraph also selected its title).
 *
 * An item with no region above threshold inherits its nearest preceding
 * item's region rather than being dropped or scattered — [[06]] left "what
 * the fallback does" as an open decision; this is that decision, made the
 * cheap way rather than the correct-for-every-case way.
 */
function groupByRegion(resolved, divs, box, regions) {
  const boxOf = (divIdx) => {
    const r = divs[divIdx].getBoundingClientRect();
    return {
      x: (r.x - box.x) / box.width, y: (r.y - box.y) / box.height,
      w: r.width / box.width, h: r.height / box.height,
    };
  };
  const overlapFrac = (a, b) => {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const areaA = a.w * a.h;
    return areaA > 0 ? (ix * iy) / areaA : 0;
  };

  let lastRegion = 0;
  const tagged = resolved.map((item, i) => {
    const ib = boxOf(item.divIdx);
    let best = -1, bestFrac = 0.1;
    for (let ri = 0; ri < regions.length; ri++) {
      const f = overlapFrac(ib, regions[ri]);
      if (f > bestFrac) { bestFrac = f; best = ri; }
    }
    if (best >= 0) lastRegion = best; else best = lastRegion;
    return { item, region: best, i };
  });

  tagged.sort((a, b) => a.region - b.region || a.i - b.i);

  // Consecutive same-label regions (the model splits one paragraph into two
  // adjacent "text" boxes more often than it splits a title from its body)
  // merge into one group -- the hard boundary this function exists to add
  // is a *label change* (title -> text), not merely a *region change*.
  // Getting this wrong the other way round reintroduced a splitting bug
  // this fix wasn't meant to add: "It is easy" / "to study individual
  // enzyme systems..." as two sentences, on this corpus, at the boundary
  // between two same-label boxes.
  const groups = [];
  let current = null, currentRegion = null, currentLabel = null;
  for (const t of tagged) {
    const label = t.region >= 0 ? regions[t.region].label : null;
    const sameRun = current && (t.region === currentRegion || (label !== null && label === currentLabel));
    if (!sameRun) {
      current = [];
      groups.push(current);
      currentRegion = t.region;
      currentLabel = label;
    }
    current.push(t.item);
  }
  return groups;
}

/*
 * ---- EPUB sentences and rects ----
 *
 * An EPUB chapter's iframe is its own text layer: TreeWalker finds real Text
 * nodes directly, so items reference nodes themselves rather than PDF's
 * textDivs-by-index, and there is no textPosition() descent to do. The
 * sentence *text* is still built and segmented eagerly (buildEpubSentences,
 * cheap -- Intl.Segmenter is one linear pass over the chapter's string) but
 * unlike a PDF page's dozen sentences, a chapter can hold hundreds, and each
 * one's line RECTS cost a forced layout via Range().getClientRects(). Doing
 * that for every sentence the moment a chapter renders would reintroduce the
 * scroll stall this session just fixed for PDF, just from a new cause -- so
 * rects are computed lazily, the first time a sentence is actually painted
 * or hit-tested, exactly like getWordRects below already does for words.
 */

const BLOCK_TAGS = /^(P|DIV|H[1-6]|LI|BLOCKQUOTE|SECTION|ARTICLE|TABLE|TR|TD|TH|UL|OL|BR|HR|FIGURE|FIGCAPTION|PRE|HEADER|FOOTER|ASIDE|NAV|DT|DD)$/;

function blockAncestor(node) {
  let el = node.parentElement;
  while (el && !BLOCK_TAGS.test(el.tagName)) el = el.parentElement;
  return el;
}

function buildEpubSentences(p) {
  const idoc = p.iframe.contentDocument;
  const walker = idoc.createTreeWalker(idoc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !/\S/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
      const tag = n.parentElement?.tagName;
      if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
      // Shown, but not spoken: a heading's permalink anchor renders as "¶"
      // and belongs on the page, and reading it aloud after every heading
      // does not. Same for the stand-in left where a clip was too large to
      // save -- you can see it, the voice steps over it.
      if (n.parentElement?.closest("[data-blitz-quiet]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  // Concatenate text nodes in document order, trusting the source's own
  // whitespace where it exists (an inline split mid-word, e.g. bold "act" +
  // plain "ive", has none between the nodes and must not gain a space) and
  // adding exactly one only where reading across a block-element boundary
  // (paragraph, heading, list item...) would otherwise weld two unrelated
  // runs together with nothing between them at all.
  const items = []; // { node, start, len }
  const parts = [];
  let acc = 0;
  let prevNode = null;
  let node;
  while ((node = walker.nextNode())) {
    const str = node.nodeValue;
    if (prevNode && blockAncestor(prevNode) !== blockAncestor(node) &&
        !/\s$/.test(parts[parts.length - 1]) && !/^\s/.test(str)) {
      parts.push(" ");
      acc += 1;
    }
    items.push({ node, start: acc, len: str.length });
    parts.push(str);
    acc += str.length;
    prevNode = node;
  }
  if (!items.length) { p.sentences = []; p._epubNodeIndex = null; return; }
  const pageText = parts.join("");
  // node -> item, for epubHitTest (below) to turn a point under the pointer
  // straight into a global text offset without testing every sentence's
  // rects on every mousemove -- the thing that made [[05]]'s "POC-grade,
  // fine at this page count" hitTest not fine at all once a page (chapter)
  // can hold hundreds of sentences.
  p._epubNodeIndex = new Map(items.map((it) => [it.node, it]));

  const locate = (idx) => {
    let lo = 0, hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (items[mid].start <= idx) lo = mid; else hi = mid - 1;
    }
    return items[lo];
  };

  const seg = new Intl.Segmenter("en", { granularity: "sentence" });
  const spans = [];
  for (const { segment, index } of seg.segment(pageText)) {
    let s = index, e = index + segment.length;
    while (s < e && /\s/.test(pageText[s])) s++;
    while (e > s && /\s/.test(pageText[e - 1])) e--;
    if (e <= s) continue;
    for (const span of guardSentenceBoundaries(pageText, s, e)) spans.push(span);
  }

  // Same "nothing unpronounceable stands alone" merge as buildSentences (02
  // §"kept"): a lone list marker or figure-reference tail gets folded into
  // its neighbour rather than sent to Kokoro to reject.
  const kept = [];
  for (let i = 0; i < spans.length; i++) {
    const [a, b] = spans[i];
    if (!/[A-Za-z]/.test(pageText.slice(a, b))) {
      if (i + 1 < spans.length) { spans[i + 1][0] = a; continue; }
      if (kept.length) { kept[kept.length - 1][1] = b; continue; }
      continue;
    }
    kept.push([a, b]);
  }

  const out = [];
  for (const [as, ae] of kept) {
    const text = pageText.slice(as, ae);
    const wordSpans = [];
    for (const m of text.matchAll(/\S+/g)) {
      wordSpans.push({ text: m[0], ws: as + m.index, we: as + m.index + m[0].length });
    }
    out.push({
      pn: p.pn, si: out.length, text, rects: null, wordSpans, words: null, unmapped: 0,
      speech: text, _locate: locate, _start: as, _end: ae,
    });
  }
  p.sentences = out;
}

/** DOM Range -> normalised page-fraction rects, epub version. Items reference
 * real Text nodes directly (no textPosition descent needed). Unlike a PDF
 * page's textLayer -- which lives in the *main* document, so its rects need
 * the outer document's coordinate space -- these nodes live inside the
 * iframe's own document, and getClientRects() already reports positions in
 * *that* document's own viewport (its own (0,0) is the iframe's top-left,
 * independent of where the iframe itself sits in the main page). So this
 * only needs to divide by the iframe's own size to get a page fraction, not
 * subtract its position too -- doing that (an earlier version of this did)
 * double-offsets every rect by the iframe's own position, which is exactly
 * what made every highlight render shifted and truncated. */
function epubRangeRects(p, locate, s, e) {
  if (e <= s) return [];
  const a = locate(s), b = locate(e - 1);
  try {
    const range = p.iframe.contentDocument.createRange();
    range.setStart(a.node, Math.max(0, Math.min(s - a.start, a.node.length)));
    range.setEnd(b.node, Math.max(0, Math.min(e - 1 - b.start + 1, b.node.length)));
    // Divide by the chapter document's OWN layout size, not the iframe's
    // outer bounding box. The rects come from inside that document, in its
    // unscaled coordinates; the outer box carries the zoom transform, so
    // dividing by it would shrink every fraction by the zoom factor. Using
    // the internal size keeps these fractions scale-invariant, which is what
    // lets zoom skip recomputing them at all (applyEpubScale).
    const root = p.iframe.contentDocument.documentElement;
    const width = root.clientWidth || 1;
    const height = root.scrollHeight || 1;
    return [...range.getClientRects()]
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        x: r.x / width, y: r.y / height,
        w: r.width / width, h: r.height / height,
      }));
  } catch {
    return [];
  }
}

/**
 * A sentence's line rects. PDF sentences already have theirs filled in
 * eagerly by buildSentences -- cheap there, a page has ~a dozen -- so this
 * is a plain cache read for them; epub sentences start with rects:null and
 * compute (and cache) lazily here, the first time one is actually painted,
 * hit-tested or scrolled to.
 */
function sentenceRects(p, s) {
  if (s.rects) return s.rects;
  if (!p.iframe) return [];
  s.rects = mergeLines(epubRangeRects(p, s._locate, s._start, s._end));
  return s.rects;
}

/** Compute (and cache) a sentence's per-word rects, only when it's about to speak. */
function getWordRects(p, sentence) {
  if (sentence.words) return sentence.words;
  if (p.iframe) {
    sentence.words = sentence.wordSpans
      .map(({ text, ws, we }) => ({ text, rects: mergeLines(epubRangeRects(p, sentence._locate, ws, we)) }))
      .filter((w) => w.rects.length);
    return sentence.words;
  }
  const { divs } = p._geom;
  const locate = sentence._locate;
  // A fresh box, not the one buildSentences captured: this can run long
  // after render, once the page has scrolled, and range.getClientRects()
  // below always reports *current* viewport position — mixing a stale box
  // with live rects would misplace every word box by the scroll delta.
  const box = p.textLayerDiv.getBoundingClientRect();
  sentence.words = sentence.wordSpans
    .map(({ text, ws, we }) => ({ text, rects: mergeLines(rangeRects(divs, box, locate, ws, we)) }))
    .filter((w) => w.rects.length);
  return sentence.words;
}

/** DOM Range -> normalised page-fraction rects for [s, e) of pageText. */
function rangeRects(divs, box, locate, s, e) {
  if (e <= s) return [];
  const a = locate(s), b = locate(e - 1);
  try {
    const range = document.createRange();
    range.setStart(...textPosition(divs[a.divIdx], s - a.start));
    range.setEnd(...textPosition(divs[b.divIdx], e - 1 - b.start + 1));
    return [...range.getClientRects()]
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({
        x: (r.x - box.x) / box.width,
        y: (r.y - box.y) / box.height,
        w: r.width / box.width,
        h: r.height / box.height,
      }));
  } catch {
    return [];
  }
}

/** Descend to the text node a Range endpoint needs (autolinker.js textPosition). */
function textPosition(div, offset) {
  let node = div;
  while (node && node.nodeType !== Node.TEXT_NODE) node = node.firstChild;
  if (!node) return [div, 0];
  return [node, Math.min(offset, node.length)];
}

/**
 * getClientRects() gives one rect per inline box, so a single visual line that
 * crosses a font change comes back as several. A band wants one rect per line.
 */
function mergeLines(rects) {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const r of sorted) {
    const last = lines[lines.length - 1];
    const sameLine = last &&
      Math.abs(r.y + r.h / 2 - (last.y + last.h / 2)) < Math.max(r.h, last.h) * 0.55;
    if (sameLine) {
      const right = Math.max(last.x + last.w, r.x + r.w);
      const bottom = Math.max(last.y + last.h, r.y + r.h);
      last.x = Math.min(last.x, r.x);
      last.y = Math.min(last.y, r.y);
      last.w = right - last.x;
      last.h = bottom - last.y;
    } else {
      lines.push({ ...r });
    }
  }
  return lines;
}

// ---------------------------------------------------------------- overlay

function clearOverlay(p) {
  p.svg.replaceChildren();
  if (p.labels) p.labels.replaceChildren();
}

function rect(x, y, w, h, fill, opts = {}) {
  const r = document.createElementNS(SVG_NS, "rect");
  r.setAttribute("x", x);
  r.setAttribute("y", y);
  r.setAttribute("width", Math.max(w, 0));
  r.setAttribute("height", Math.max(h, 0));
  r.setAttribute("fill", fill);
  for (const [k, v] of Object.entries(opts)) r.setAttribute(k, v);
  return r;
}

/** Pad a line rect a little so drift reads as "generous", not "misaligned" (02 §4). */
const pad = (r) => ({
  x: clamp01(r.x - r.h * 0.03),
  y: clamp01(r.y - r.h * 0.14),
  w: r.w + r.h * 0.06,
  h: r.h * 1.28,
});

/*
 * `pad` was tuned for a whole LINE band -- 28% extra height and a 14%
 * upward shift read as "generous" there because they're absorbing a full
 * line's ascenders/descenders. Applied to a single word (16's word cursor,
 * and the hover outline below) the same ratios look loose: the box floats
 * above the word and overhangs well past its edges, which is exactly what
 * "not positioned perfectly on the word" describes. This hugs the glyphs
 * instead -- a snug highlighter pill, Speechify's own look, rather than a
 * shrunk line band.
 *
 * Kept deliberately small, on the strength of a direct measurement rather
 * than a guess: a real PDF.js text layer's per-word Range.getClientRects()
 * boxes, rendered with NO padding at all against a natively-typeset PDF
 * (pdflatex output, proportional serif, real kerning), already landed
 * within a pixel of every glyph -- see the debugWordBoxes(pn, si, true)
 * "raw" mode below, which draws them unpadded for exactly this kind of
 * check. An earlier version of this padded by several real pixels on the
 * theory that PDF.js's text layer (it substitutes a generic sans-serif font
 * for the invisible, selectable text, scaled once per line to match the
 * PDF's real width -- see any span's `--scale-x`) drifts further off the
 * true glyph position deeper into a line; measured gaps between consecutive
 * words stayed a constant ~3px ten words into a line, no accumulating drift
 * at all, and padding sized for that theory was big enough to make
 * neighboring words' boxes overlap. So: a hairline only, just enough that
 * cornerRadius's rounding doesn't read as a razor-cut selection box. If a
 * *specific* PDF still looks off after this, it's much more likely a
 * scanned/OCR'd book -- OCR word boxes are estimated from pixels, not exact
 * vector positions, and can be off by more than a hairline unpredictably --
 * which needs looking at that actual PDF, not a bigger constant here.
 */
function padWord(p, r) {
  const { dx, dy } = padPx(p, 1.5, 1);
  return {
    x: clamp01(r.x - dx),
    y: clamp01(r.y - dy),
    w: r.w + dx * 2,
    h: r.h + dy * 2,
  };
}

/**
 * A real {pxX, pxY} pixel amount -> the page-fraction deltas that amount
 * corresponds to along each axis right now, at the page's current zoom --
 * shares cornerRadius's box-stretch reasoning (see its own note) and its
 * box measurement, just without cornerRadius's own height-relative cap,
 * which means nothing here for padding.
 */
function padPx(p, pxX, pxY) {
  const box = p.div.getBoundingClientRect();
  return { dx: (pxX * scale) / box.width, dy: (pxY * scale) / box.height };
}

/*
 * The overlay's viewBox is a unit square stretched independently in x and y
 * over whatever pixel box the page actually rendered at (preserveAspectRatio
 * ="none", see paintRegions' note on this) -- so a single numeric rx/ry
 * looks visibly elliptical on anything but a square page. This converts a
 * real target pixel radius into the mismatched {rx, ry} fractions that read
 * as one true circular corner once the SVG re-stretches them back out.
 * Capped relative to the box's own height so a short word doesn't end up
 * rounder than it is wide.
 */
function cornerRadius(p, boxHeightFrac, targetPx) {
  const box = p.div.getBoundingClientRect();
  const r = Math.min(targetPx, (boxHeightFrac * box.height) / 2);
  return { rx: r / box.width, ry: r / box.height };
}

/**
 * Which of a sentence's line rects the spotlight should punch out. Variant C
 * used to hand paintBand every line a sentence spans, so a three-line
 * sentence lit up all three lines the moment it started speaking. Readers
 * expect the opposite of that -- a spotlight that tracks the one line
 * actually being read and moves down as the word cursor wraps -- so this
 * narrows the punch to just the line(s) under the current word, matched by
 * the same "same vertical center" test mergeLines uses to decide two rects
 * belong to one visual line. Before the first word of a sentence has timed
 * in yet (or for a single-line sentence, where there's nothing to narrow),
 * it falls back to the sentence's first/only line.
 */
function activeLineRects(p, sentence, wordIdxs) {
  const lines = sentenceRects(p, sentence);
  if (lines.length <= 1 || !wordIdxs.length) return lines.length ? [lines[0]] : lines;
  const words = getWordRects(p, sentence);
  const wordBoxes = wordIdxs.map((i) => words[i]).filter(Boolean).flatMap((w) => w.rects);
  if (!wordBoxes.length) return [lines[0]];
  const matched = lines.filter((line) =>
    wordBoxes.some((w) => Math.abs((w.y + w.h / 2) - (line.y + line.h / 2)) < Math.max(w.h, line.h) * 0.55));
  return matched.length ? matched : [lines[0]];
}

function paintBand(p, rects) {
  clearOverlay(p);
  if (!rects || !rects.length) return;
  const boxes = rects.map(pad);

  if (variant.key === "A") {
    for (const b of boxes) p.svg.append(rect(b.x, b.y, b.w, b.h, "rgba(255, 212, 0, 0.34)"));
  } else if (variant.key === "B") {
    for (const b of boxes) {
      p.svg.append(rect(b.x, b.y, b.w, b.h, "rgba(255, 212, 0, 0.10)"));
      p.svg.append(rect(b.x, b.y + b.h - b.h * 0.13, b.w, b.h * 0.13, "rgba(226, 110, 20, 0.9)"));
    }
  } else {
    // Spotlight: dim the whole page and punch the current line out of the
    // mask, corners softened to a real 6px so the punch reads as a deliberate
    // rounded window onto the page rather than a sharp cutout.
    const id = `mask-${p.pn}`;
    const mask = document.createElementNS(SVG_NS, "mask");
    mask.setAttribute("id", id);
    mask.setAttribute("maskUnits", "userSpaceOnUse");
    mask.append(rect(0, 0, 1, 1, "#fff"));
    for (const b of boxes) mask.append(rect(b.x, b.y, b.w, b.h, "#000", cornerRadius(p, b.h, 6)));
    p.svg.append(mask);
    p.svg.append(rect(0, 0, 1, 1, "rgba(10, 12, 18, 0.42)", { mask: `url(#${id})` }));
  }
}

/**
 * The word cursor. Only meaningful inside variant C's punched-out hole — the
 * hole is already at full brightness, so "highlight the current word" can't
 * mean "make it brighter"; each style below finds a different way to make it
 * stand out from the rest of an already-lit sentence without re-darkening
 * the page outside it (16's central design question).
 */
// Claude's own accent coral rather than the generic reading-app amber, per
// ticket ask: word-level highlighting should read as this app's highlight,
// not a stock yellow marker.
const CURSOR_TINT = "rgba(217, 119, 87, 0.34)";
const CURSOR_UNDERLINE = "rgba(196, 98, 66, 0.92)";
const CURSOR_DIM = "rgba(10, 12, 18, 0.24)";

/**
 * The word cursor. Only meaningful inside variant C's punched-out hole — the
 * hole is already at full brightness, so "highlight the current word" can't
 * mean "make it brighter"; each style below finds a different way to make it
 * stand out from the rest of an already-lit sentence without re-darkening
 * the page outside it (16's central design question).
 *
 * `lineRects` is the same active-line rect set paintBand just punched the
 * spotlight out of (activeLineRects), not the whole sentence — so "dim"'s
 * inner mask recedes only the rest of the line actually on screen, and never
 * re-covers lines the outer punch already dimmed away.
 *
 * Every shape here gets a real, pixel-accurate rounded corner (cornerRadius)
 * so the cursor reads as a soft highlighter mark sitting precisely on the
 * word, not a sharp box that happens to overlap it.
 */
function paintWordCursor(p, sentence, wordIdxs, lineRects) {
  if (cursorStyle.key === "off" || !sentence || !wordIdxs.length) return;
  const words = getWordRects(p, sentence);
  const wordBoxes = wordIdxs
    .map((i) => words[i])
    .filter(Boolean)
    .flatMap((w) => w.rects.map((r) => padWord(p, r)));
  if (!wordBoxes.length) return;

  if (cursorStyle.key === "underline") {
    for (const b of wordBoxes) {
      const barH = b.h * 0.1;
      p.svg.append(rect(b.x, b.y + b.h - barH, b.w, barH, CURSOR_UNDERLINE, cornerRadius(p, barH, 3)));
    }
    return;
  }
  if (cursorStyle.key === "tint") {
    for (const b of wordBoxes) {
      p.svg.append(rect(b.x, b.y, b.w, b.h, CURSOR_TINT, cornerRadius(p, b.h, 5)));
    }
    return;
  }
  // "dim": a second, fainter spotlight nested inside the first — gently
  // recede the rest of the already-lit line, rather than marking the current
  // word. Confined to the active line's own rects, so it never touches the
  // page outside the outer punch.
  const id = `wordmask-${p.pn}`;
  const mask = document.createElementNS(SVG_NS, "mask");
  mask.setAttribute("id", id);
  mask.setAttribute("maskUnits", "userSpaceOnUse");
  mask.append(rect(0, 0, 1, 1, "#000"));
  for (const b of (lineRects ?? sentenceRects(p, sentence)).map(pad)) mask.append(rect(b.x, b.y, b.w, b.h, "#fff"));
  for (const b of wordBoxes) mask.append(rect(b.x, b.y, b.w, b.h, "#000", cornerRadius(p, b.h, 5)));
  p.svg.append(mask);
  p.svg.append(rect(0, 0, 1, 1, CURSOR_DIM, { mask: `url(#${id})` }));
}

function paintAllBands(p) {
  clearOverlay(p);
  // Debug-only (the "show every sentence band" checkbox): forces every
  // sentence's rects, which on an epub chapter with hundreds of them is
  // real work. Fine when explicitly opted into; never called otherwise.
  for (const s of p.sentences) {
    for (const r of sentenceRects(p, s).map(pad)) {
      p.svg.append(rect(r.x, r.y, r.w, r.h, "rgba(80, 160, 255, 0.12)", {
        stroke: "rgba(80, 160, 255, 0.55)",
        "stroke-width": 1,
        "vector-effect": "non-scaling-stroke",
      }));
    }
  }
}

/**
 * TICKET 06's explicit ask: "render that order visibly ... so the order can
 * be eyeballed against the real page rather than trusted." Numbered so the
 * reading order (not just the boxes) is checkable at a glance.
 */
function paintRegions(p) {
  if (!p.regions) return;
  // Boxes go in the SVG; labels do NOT. The overlay is viewBox="0 0 1 1"
  // with preserveAspectRatio="none", so it scales x and y by different
  // factors -- rectangles survive that, glyphs come out stretched and
  // unreadable (reported). Labels are positioned HTML instead, so they
  // render at real font size whatever the page aspect ratio is.
  const frag = document.createDocumentFragment();
  p.regions.forEach((r, i) => {
    const hue = Math.round((i / p.regions.length) * 300);
    const color = `hsl(${hue}, 85%, 60%)`;
    p.svg.append(rect(r.x, r.y, r.w, r.h, "none", {
      stroke: color, "stroke-width": 2, "vector-effect": "non-scaling-stroke",
    }));
    // Just the reading-order number, inside the box's top-left corner, with
    // the label on hover. Earlier revisions put the full label in the SVG
    // (stretched unreadable by preserveAspectRatio="none") and then in the
    // page margin (clipped at the page edge, and for a right-hand column it
    // landed on top of the left column's text). A number is two characters
    // wide, so it occludes almost nothing and the order still reads at a
    // glance -- which is the thing this overlay exists to show.
    const tag = document.createElement("span");
    tag.className = "regionTag";
    tag.style.left = `${r.x * 100}%`;
    tag.style.top = `${r.y * 100}%`;
    tag.style.borderColor = color;
    tag.style.color = color;
    tag.textContent = String(i + 1);
    tag.title = `${i + 1}. ${r.label} (${r.score.toFixed(2)})`;
    frag.append(tag);
  });
  p.labels.replaceChildren(frag);
}

function repaint() {
  for (const p of pages.values()) {
    if (!p.rendered) continue;
    if (el.showall.checked) {
      paintAllBands(p);
      if (speaking && speaking.pn === p.pn) {
        // still show where the voice is, on top of the debug bands
        const s = p.sentences[speaking.si];
        if (s) for (const b of sentenceRects(p, s).map(pad)) {
          p.svg.append(rect(b.x, b.y, b.w, b.h, "rgba(255, 212, 0, 0.40)"));
        }
      }
    } else if (speaking && speaking.pn === p.pn) {
      const s = p.sentences[speaking.si];
      // Variant C narrows to the one line the word cursor is on; A/B still
      // band the whole sentence, which is what those two are for.
      const bandRects = s && variant.key === "C" ? activeLineRects(p, s, activeWordIdxs) : s ? sentenceRects(p, s) : null;
      paintBand(p, bandRects);
      if (variant.key === "C") paintWordCursor(p, s, activeWordIdxs, bandRects);
    } else if (variant.key === "C" && speaking) {
      clearOverlay(p);
      p.svg.append(rect(0, 0, 1, 1, "rgba(10, 12, 18, 0.42)"));
    } else {
      clearOverlay(p);
    }

    // Additive, regardless of which branch above ran: regions and loading
    // are independent of whether anything is currently speaking.
    if (el.showRegions.checked) paintRegions(p); else if (p.labels.firstChild) p.labels.replaceChildren();
    if (loadingSentence?.pn === p.pn && !isSame(speaking, loadingSentence)) {
      paintLoading(p, p.sentences[loadingSentence.si]);
    }
    if (hoveredWord?.pn === p.pn) paintWordHover(p);
  }
}

const isSame = (a, b) => Boolean(a && b && a.pn === b.pn && a.si === b.si);

/** Pulsing dashed outline: synthesis is in flight for this sentence. */
function paintLoading(p, sentence) {
  if (!sentence) return;
  for (const b of sentenceRects(p, sentence).map(pad)) {
    const r = rect(b.x, b.y, b.w, b.h, "none", {
      stroke: "rgba(124, 196, 255, 0.9)",
      "stroke-width": 2,
      "stroke-dasharray": "6 4",
      "vector-effect": "non-scaling-stroke",
    });
    r.setAttribute("class", "loading-outline");
    p.svg.append(r);
  }
}

// ---------------------------------------------------------------- scrolling

function scrollTo(p, rects) {
  if (!el.autoscroll.checked || !rects.length) return;
  const pageBox = p.div.getBoundingClientRect();
  const viewBox = el.viewer.getBoundingClientRect();
  const top = pageBox.top + rects[0].y * pageBox.height;
  const bottom = pageBox.top + (rects.at(-1).y + rects.at(-1).h) * pageBox.height;
  const comfortTop = viewBox.top + viewBox.height * 0.15;
  const comfortBottom = viewBox.top + viewBox.height * 0.75;
  if (top >= comfortTop && bottom <= comfortBottom) return;
  el.viewer.scrollBy({
    top: top - (viewBox.top + viewBox.height * 0.32),
    behavior: "smooth",
  });
}

// ---------------------------------------------------------------- playback

async function nextCursor(c) {
  if (!c) return null;
  const p = pages.get(c.pn);
  if (p && c.si + 1 < p.sentences.length) return { pn: c.pn, si: c.si + 1 };
  for (let pn = c.pn + 1; pn <= doc.numPages; pn++) {
    const np = await renderPage(pn);
    if (np && np.sentences.length) return { pn, si: 0 };
  }
  return null;
}

function sentenceAt(c) {
  return c ? pages.get(c.pn)?.sentences[c.si] ?? null : null;
}

const cacheKey = (c) => `${c.pn}:${c.si}`;

function fetchSynth(text, voiceName, speed) {
  return window.blitz.synthesize({ text, voice: voiceName, speed });
}

// A page's worth of sentences all become fetchable the moment it renders
// (see renderPage), which would otherwise fire 10-20 requests at once and
// make every one of them slow. Cap how many the sidecar is doing at a time,
// and let an explicit play() request cut the queue -- the reader is waiting
// on it, the background reader-ahead isn't.
// The sidecar pins each ONNX session to every CPU thread (server.py's
// intra_op_num_threads), so two requests in parallel oversubscribe the
// machine and both get SLOWER, not faster -- measured: raising this past 1
// turned a cold click into a 6-8s wait instead of the ~2-4s one request
// alone takes. One at a time, reordered by priority, is faster in practice.
const MAX_CONCURRENT = 1;
let activeRequests = 0;
const fetchQueue = []; // [{key, run}], FIFO except promote() reorders it

function pumpFetchQueue() {
  while (activeRequests < MAX_CONCURRENT && fetchQueue.length) {
    const { run } = fetchQueue.shift();
    activeRequests++;
    run();
  }
  report(); // keeps the busy-dot and queue depth live, not just on playback events
}

function promote(k) {
  const i = fetchQueue.findIndex((t) => t.key === k);
  if (i > 0) fetchQueue.unshift(fetchQueue.splice(i, 1)[0]);
}

/** Kick off (or reuse) the synthesis request for a sentence, ahead of need. */
function ensurePrefetch(c, opts) {
  const priority = Boolean(opts && opts.priority);
  const k = cacheKey(c);
  if (prefetchCache.has(k)) {
    if (priority) promote(k);
    return prefetchCache.get(k);
  }
  const s = sentenceAt(c);
  if (!s) return Promise.resolve(null);
  // Belt and braces on top of the merge in buildSentences: never ask the
  // synthesiser for text with nothing to pronounce -- it 500s on that.
  if (!/[A-Za-z]/.test(s.speech)) return Promise.resolve(null);

  let resolveFn, rejectFn;
  const promise = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
  prefetchCache.set(k, promise);

  const run = () => {
    fetchSynth(s.speech, el.voice.value, synthSpeed)
      .then(resolveFn, (e) => { prefetchCache.delete(k); rejectFn(e); })
      .finally(() => { activeRequests--; pumpFetchQueue(); });
  };
  fetchQueue[priority ? "unshift" : "push"]({ key: k, run });
  pumpFetchQueue();
  return promise;
}

// Read a few sentences ahead of wherever the *voice* actually is, not
// wherever the viewport happens to be. This used to fire from renderPage,
// which meant scrolling through the document -- not reading it -- queued
// audio for every page that scrolled into view. On a long document, fast
// scrolling could queue hundreds of sentences behind whatever was already
// playing, and worse, buildSentences' per-word geometry (now lazy, see
// getWordRects) used to run eagerly for all of them too. Tying prefetch to
// playback instead means scrolling costs nothing beyond the page render
// [[05]] already paid for.
const READ_AHEAD = 3;
async function prefetchAhead(c, { priorityFirst = false } = {}) {
  let at = c;
  for (let i = 0; i < READ_AHEAD && at; i++) {
    // fire-and-forget; speakOne's own await on the immediate-next sentence
    // is what surfaces a real failure, not this background warm-up
    ensurePrefetch(at, { priority: priorityFirst && i === 0 }).catch(() => {});
    at = await nextCursor(at);
  }
}

function wordsAt(t) {
  // currentSpans is time-ordered (server emits phoneme groups in speech
  // order); find the last span that has started by t.
  let lo = 0, hi = currentSpans.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (currentSpans[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found < 0 ? [] : currentSpans[found].words;
}

function sameWords(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function startWordLoop(gen) {
  const step = () => {
    if (gen !== generation) return;
    const next = wordsAt(audioEl.currentTime);
    if (!sameWords(next, activeWordIdxs)) {
      activeWordIdxs = next;
      repaint();
    }
    rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function stopWordLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  activeWordIdxs = [];
}

async function speakOne(c) {
  const s = sentenceAt(c);
  if (!s) return endOfDocument();
  const gen = generation;
  const startedAt = performance.now();

  // Visible the instant a click is made, not once synthesis returns — a
  // cache miss can take a couple of seconds (see README), and silence
  // during that wait reads as broken rather than as "working on it."
  loadingSentence = c;
  repaint();

  let data, nc;
  try {
    // Runs alongside synthesis, not before it -- the device-open warm-up
    // (see warmUpAudioOnce) is a genuine no-op after the first call, and on
    // the first call it's normally shorter than a synthesis round trip, so
    // this doesn't add latency to the common case. It still has to settle
    // here, before speakOne below ever touches audioEl.src for real audio,
    // or reassigning src mid-warm-up risks cutting the open short.
    [data, nc] = await Promise.all([ensurePrefetch(c, { priority: true }), nextCursor(c), warmUpAudioOnce()]);
  } catch (e) {
    if (gen !== generation) return;
    console.warn("[tts] synth error, skipping sentence", e, "—", s.text.slice(0, 60));
    // One bad sentence shouldn't end the read. Skip it and keep going — the
    // reader hears a gap, not a dead stop. If the sidecar itself is down,
    // every following sentence will fail the same way; that surfaces as
    // reaching endOfDocument almost immediately, which is enough of a signal.
    loadingSentence = null;
    nc = await nextCursor(c).catch(() => null);
    if (nc) return speakOne(nc);
    status(`synth error on the last sentence — is the Kokoro sidecar running? (npm run server)\n${e.message}`);
    return endOfDocument();
  }
  if (gen !== generation) return;
  prefetchCache.delete(cacheKey(c));

  if (!data) {
    // Nothing pronounceable here (see ensurePrefetch's guard). Move on
    // rather than stalling on a sentence that can never make a sound.
    loadingSentence = null;
    cursor = nc;
    if (cursor) return speakOne(cursor);
    return endOfDocument();
  }

  cursor = nc;
  if (cursor) prefetchAhead(cursor, { priorityFirst: true }); // the sentence right after this one, plus a couple more behind it

  loadingSentence = null;
  speaking = c;
  notePosition(c.pn, c.si);
  markToc(c.pn);
  currentSpans = data.spans;
  activeWordIdxs = [];
  el.spoken.textContent = s.text;
  const p = pages.get(c.pn);
  getWordRects(p, s); // pay the per-word layout cost for this one sentence, now that it's needed
  repaint();
  scrollTo(p, sentenceRects(p, s));
  markSentenceList(c);
  report();

  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  const bytes = Uint8Array.from(atob(data.audio_b64), (ch) => ch.charCodeAt(0));
  currentBlobUrl = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  audioEl.src = currentBlobUrl;
  // The clip was synthesized at whatever speed was current when it was
  // asked for; the ratio is what is left for the time-stretcher, which in
  // the settled case is exactly 1 -- no stretching at all.
  playingSpeed = synthSpeed;
  audioEl.playbackRate = Number(el.rate.value) / playingSpeed;

  // Double-click on a word (handleWordDblClick) asks to start mid-sentence,
  // not just at its first word. The whole sentence is still synthesized and
  // played start-to-end as one clip -- Kokoro has no notion of "resume from
  // here" -- so this seeks the *already-loaded* clip to the target word's
  // own timing span instead. wordsAt(audioEl.currentTime) in the word loop
  // below then just naturally picks up from wherever that lands.
  if (c.wordIdx != null) {
    const span = currentSpans.find((sp) => sp.words.includes(c.wordIdx));
    if (span) audioEl.currentTime = span.start;
  }

  audioEl.onended = () => {
    if (gen !== generation) return;
    timings.push(performance.now() - startedAt);
    stopWordLoop();
    if (cursor) speakOne(cursor); else endOfDocument();
  };
  audioEl.onerror = () => {
    if (gen !== generation) return;
    console.warn("[tts] audio element error", audioEl.error);
    if (cursor) speakOne(cursor); else endOfDocument();
  };

  startWordLoop(gen);
  audioEl.play().catch((e) => {
    // Autoplay-policy rejections land here with currentTime stuck at 0, so
    // the word cursor should NOT visibly advance in this case -- if it does
    // (the reported symptom), the audio started fine and was just silent,
    // which points at the server-side peak-amplitude check instead.
    console.warn("[tts] play() rejected -- word cursor should stay frozen at word 0:", e);
  });
}

function endOfDocument() {
  playing = false;
  speaking = null;
  loadingSentence = null;
  stopWordLoop();
  updatePageNow();
  repaint();
  report();
}

async function play(from) {
  if (playing) return pause();
  if (!doc) return;
  let start = from ?? cursor;
  if (!start) {
    const p = await firstPageWithSentences();
    if (!p) return;
    start = { pn: p.pn, si: 0 };
  }
  playing = true;
  updatePageNow();
  speakOne(start);
  report();
}

function pause() {
  playing = false;
  generation++;
  audioEl.pause();
  loadingSentence = null;
  stopWordLoop();
  // resume from the sentence that was interrupted, not the one queued behind it
  if (speaking) cursor = speaking;
  updatePageNow();
  report();
}

function stop() {
  playing = false;
  generation++;
  audioEl.pause();
  audioEl.removeAttribute("src");
  stopWordLoop();
  cursor = null;
  speaking = null;
  loadingSentence = null;
  el.spoken.textContent = "—";
  flushPosition();
  updatePageNow();
  repaint();
  report();
}

async function firstPageWithSentences() {
  for (let pn = 1; pn <= doc.numPages; pn++) {
    const p = await renderPage(pn);
    if (p && p.sentences.length) return p;
  }
  return null;
}

// ---------------------------------------------------------------- sentence list

let listedPage = null;

function renderSentenceList(pn) {
  const p = pages.get(pn);
  if (!p || !p.rendered || listedPage === pn) return;
  listedPage = pn;
  el.segcount.textContent = `p${pn} · ${p.sentences.length} sentences`;
  el.sentences.replaceChildren(
    ...p.sentences.map((s, i) => {
      const li = document.createElement("li");
      li.textContent = s.text;
      // s.rects may still be null here (epub: computed lazily) -- reading the
      // list must not itself force a Range().getClientRects() pass over
      // every sentence in the chapter, so this only reports a count when the
      // rects already happen to be cached.
      li.title = (s.rects ? `${s.rects.length} line rect(s)` : "") +
        (s.unmapped ? ` · ${s.unmapped} unmapped glyph(s)` : "");
      if (s.unmapped) li.style.color = "#ff9b6b";
      li.onclick = () => { stop(); play({ pn, si: i }); };
      return li;
    }),
  );
  markSentenceList(speaking);
}

function markSentenceList(c) {
  if (!c || c.pn !== listedPage) return;
  [...el.sentences.children].forEach((li, i) => li.classList.toggle("on", i === c.si));
  el.sentences.children[c.si]?.scrollIntoView({ block: "nearest" });
}

/*
 * The scroll handler does the least it possibly can: measure how fast we are
 * moving, and set a timer. Everything else -- eviction, the sentence list,
 * resuming the render pump -- happens once the scroll settles. It used to call
 * getBoundingClientRect() on every page in the document on every scroll event,
 * which on a 611-page book is 611 forced layouts per event.
 */
let settleTimer = null;
el.viewer.addEventListener("scroll", () => {
  const now = performance.now();
  const top = el.viewer.scrollTop;
  const dt = now - lastScrollAt;
  // A gap longer than an idle beat is a new gesture, not a slow one.
  scrollVelocity = dt > 0 && dt < SCROLL_IDLE_MS * 4 ? Math.abs(top - lastScrollTop) / dt : 0;
  lastScrollAt = now;
  lastScrollTop = top;

  if (!pumping && renderQueue.size && !scrollingFast()) pump();

  clearTimeout(settleTimer);
  settleTimer = setTimeout(onScrollSettled, 150);
}, { passive: true });

function onScrollSettled() {
  scrollVelocity = 0;
  sweepEvictions();
  ensureVisibleRendered();
  const hit = pageAtOffset(el.viewer.scrollTop + el.viewer.clientHeight / 2);
  updatePageNow();
  if (hit) {
    renderSentenceList(hit.pn);
    markToc(hit.pn);
    // While playing, the reading loop is the authority on position -- an
    // auto-scroll settling would otherwise overwrite the sentence with a
    // bare page number.
    if (!playing) notePosition(hit.pn);
  }
  pump();
}

/** Which sentence, if any, sits under this page-relative point. */
function hitTest(p, clientX, clientY) {
  if (p.iframe) return epubHitTest(p, clientX, clientY);
  const b = p.div.getBoundingClientRect();
  const x = (clientX - b.left) / b.width;
  const y = (clientY - b.top) / b.height;
  const hit = p.sentences.findIndex((s) =>
    s.rects.some((r) => x >= r.x - 0.01 && x <= r.x + r.w + 0.01 && y >= r.y && y <= r.y + r.h));
  return hit >= 0 ? hit : null;
}

/**
 * The epub equivalent of hitTest above, but taking a completely different
 * route to it: this runs on every mousemove for the hover-to-preview badge,
 * and testing every sentence's rects (the PDF approach -- fine there, "a
 * page has ~a dozen") would force sentenceRects for hundreds of sentences on
 * every pixel the pointer crosses. caretRangeFromPoint asks the browser
 * directly which text offset is under the cursor -- no rects computed at
 * all -- and a binary search over sentence boundaries (already sorted,
 * built in order) finds which sentence that offset falls in.
 */
function epubHitTest(p, clientX, clientY) {
  const idoc = p.iframe.contentDocument;
  if (!idoc || !p._epubNodeIndex) return null;
  // The pointer arrives in outer (zoomed) client coordinates; the chapter
  // document hit-tests in its own unscaled ones, so undo the zoom transform.
  const ib = p.iframe.getBoundingClientRect();
  const ix = (clientX - ib.left) / scale, iy = (clientY - ib.top) / scale;
  let range = null;
  if (idoc.caretRangeFromPoint) {
    range = idoc.caretRangeFromPoint(ix, iy);
  } else if (idoc.caretPositionFromPoint) {
    const pos = idoc.caretPositionFromPoint(ix, iy);
    if (pos) { range = idoc.createRange(); range.setStart(pos.offsetNode, pos.offset); }
  }
  if (!range) return null;

  let node = range.startContainer, offset = range.startOffset;
  if (node.nodeType !== Node.TEXT_NODE) {
    let n = node.childNodes[offset] ?? node.childNodes[offset - 1] ?? node.firstChild;
    while (n && n.nodeType !== Node.TEXT_NODE) n = n.firstChild ?? n.nextSibling;
    if (!n) return null;
    node = n; offset = 0;
  }
  const item = p._epubNodeIndex.get(node);
  if (!item) return null;
  const idx = item.start + Math.min(offset, item.len);

  const arr = p.sentences;
  if (!arr.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid]._start <= idx) lo = mid; else hi = mid - 1;
  }
  return idx >= arr[lo]._start && idx < arr[lo]._end ? lo : null;
}

/*
 * Click a sentence on the page itself to speak from there -- unless that
 * click is the end of a selection drag, which is someone quoting a passage
 * for a note, not asking to be read to.
 *
 * A single left click does NOT start playback -- the page is a document
 * first: click to place a cursor, drag to select, click a link to follow it.
 * Reading aloud from an arbitrary click is something you ask for unambiguously
 * -- right-click, press P, or (below) double-click a specific word -- rather
 * than something a stray pointer begins. That was the whole complaint about
 * hover-to-play, and it was fair: you cannot use a document you cannot rest
 * the mouse on. Hovering itself still does nothing but preview -- a quiet
 * outline on whatever word is under the pointer, so double-click has
 * something to aim at, never a sound.
 */

/* --------------------------------------------- word hover / double-click */

// {pn, si, wi} of the word currently under the pointer, or null. wi indexes
// the same (cached, filtered) array getWordRects returns and the server's
// phoneme spans already use -- see wordHitTest and speakOne's wordIdx seek.
let hoveredWord = null;

/**
 * A page-fraction point -> the fraction space word rects were computed in.
 * PDF word rects (getWordRects) are fractions of textLayerDiv's own box;
 * epub word rects (epubRangeRects) are fractions of the chapter document's
 * own clientWidth/scrollHeight, in the iframe's unscaled coordinate system.
 * Mirrors hitTest/epubHitTest's own point conversion exactly, so a hit here
 * lands on the same word a click there would have.
 */
function pointToFraction(p, clientX, clientY) {
  if (p.iframe) {
    const idoc = p.iframe.contentDocument;
    if (!idoc) return null;
    const ib = p.iframe.getBoundingClientRect();
    const root = idoc.documentElement;
    const width = root.clientWidth || 1, height = root.scrollHeight || 1;
    return { x: ((clientX - ib.left) / scale) / width, y: ((clientY - ib.top) / scale) / height };
  }
  const b = p.textLayerDiv.getBoundingClientRect();
  return { x: (clientX - b.left) / b.width, y: (clientY - b.top) / b.height };
}

/**
 * Which word, if any, sits under this point -- reusing the cheap sentence-
 * level hitTest/epubHitTest first (both already safe at mousemove frequency,
 * see epubHitTest's own note), then paying the one hit sentence's per-word
 * layout cost (getWordRects, cached after the first call) rather than
 * scanning every sentence's words on every pixel the pointer crosses.
 */
function wordHitTest(p, clientX, clientY) {
  const si = hitTest(p, clientX, clientY);
  if (si == null) return null;
  const s = p.sentences[si];
  const pt = pointToFraction(p, clientX, clientY);
  if (!pt) return null;
  const words = getWordRects(p, s);
  const wi = words.findIndex((w) => w.rects.some((r) =>
    pt.x >= r.x - 0.004 && pt.x <= r.x + r.w + 0.004 && pt.y >= r.y - 0.01 && pt.y <= r.y + r.h + 0.01));
  return wi < 0 ? null : { pn: p.pn, si, wi };
}

function sameWord(a, b) {
  return a === b || (a && b && a.pn === b.pn && a.si === b.si && a.wi === b.wi);
}

function setHoveredWord(next) {
  if (sameWord(hoveredWord, next)) return;
  hoveredWord = next;
  // Only fires on an actual word change, not per pixel -- the same
  // frequency the reading word-loop already repaints at (startWordLoop).
  repaint();
}

function handleWordHover(p, clientX, clientY) {
  setHoveredWord(wordHitTest(p, clientX, clientY));
}

/** Unambiguous, deliberate, and never confusable with a text-selection drag. */
function handleWordDblClick(p, clientX, clientY) {
  const hit = wordHitTest(p, clientX, clientY);
  if (!hit) return;
  stop();
  play({ pn: hit.pn, si: hit.si, wordIdx: hit.wi });
}

/**
 * A quiet outline on whatever word the pointer is over -- pure preview, see
 * the note above. Same rounded, snug treatment as the reading word cursor
 * (padWord + cornerRadius) but colorless, so it never reads as "this is the
 * word being spoken" when nothing is speaking at all.
 */
function paintWordHover(p) {
  if (!hoveredWord || hoveredWord.pn !== p.pn) return;
  const s = p.sentences[hoveredWord.si];
  const w = s && getWordRects(p, s)[hoveredWord.wi];
  if (!w) return;
  for (const b of w.rects.map((r) => padWord(p, r))) {
    p.svg.append(rect(b.x, b.y, b.w, b.h, "rgba(128, 128, 140, 0.14)", {
      stroke: "rgba(128, 128, 140, 0.5)", "stroke-width": 1.2,
      "vector-effect": "non-scaling-stroke", ...cornerRadius(p, b.h, 5),
    }));
  }
}

/* ------------------------------------------------- the page's own menu */

/** Whatever the pointer is over, in the terms the menu needs. */
function menuTargetAt(p, clientX, clientY, anchor = null) {
  return {
    p,
    si: p?.rendered ? hitTest(p, clientX, clientY) : null,
    selection: liveSelection(),
    link: anchor,
  };
}

function closeMenu() { el.pageMenu.hidden = true; el.pageMenu.replaceChildren(); }

function menuItem(label, key, enabled, onPick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (key) {
    const k = document.createElement("span");
    k.className = "key";
    k.textContent = key;
    b.append(k);
  }
  b.disabled = !enabled;
  if (enabled) b.onclick = () => { closeMenu(); onPick(); };
  return b;
}

function openMenu(target, clientX, clientY) {
  const items = [];
  const { p, si, selection, link } = target;

  const speakingHere = speaking && p && speaking.pn === p.pn && speaking.si === si;
  items.push(menuItem(
    speakingHere ? "Reading this" : "Play from here", "P", si != null && !speakingHere,
    () => { stop(); play({ pn: p.pn, si }); },
  ));
  if (playing) items.push(menuItem("Stop reading", "Esc", true, () => stop()));

  items.push(document.createElement("hr"));
  items.push(menuItem("Copy", "⌘C", !!selection, () => {
    navigator.clipboard?.writeText(selection.text).catch(() => {});
  }));
  items.push(menuItem(selection ? "Note on this passage" : "Note on this page", null, !!doc, () => {
    selectTab("notes");
    addNoteHere();
  }));

  if (link?.external) {
    items.push(document.createElement("hr"));
    items.push(menuItem("Open link in browser", null, true, () => window.open(link.external, "_blank")));
  } else if (link?.page) {
    items.push(document.createElement("hr"));
    items.push(menuItem(`Go to ${unitWord()} ${link.page}`, null, true, () => goToPage(link.page, null, link.frag)));
  }

  el.pageMenu.replaceChildren(...items);
  el.pageMenu.hidden = false;
  // Placed after it is measurable, and flipped rather than pushed off-screen.
  const box = el.pageMenu.getBoundingClientRect();
  const x = Math.min(clientX, innerWidth - box.width - 8);
  const y = clientY + box.height > innerHeight - 8 ? clientY - box.height : clientY;
  el.pageMenu.style.left = `${Math.max(8, x)}px`;
  el.pageMenu.style.top = `${Math.max(8, y)}px`;
}

el.pages.addEventListener("contextmenu", (ev) => {
  const div = ev.target.closest(".page");
  if (!div) return;
  ev.preventDefault();
  const p = pages.get(Number(div.dataset.page));
  openMenu(menuTargetAt(p, ev.clientX, ev.clientY), ev.clientX, ev.clientY);
});

// Word hover-preview and double-click-to-play, PDF side. An epub chapter's
// text lives inside its own iframe document, whose mouse events never bubble
// out here -- that side is wired directly on the iframe in wireEpubInput.
el.pages.addEventListener("mousemove", (ev) => {
  const div = ev.target.closest(".page");
  const p = div && pages.get(Number(div.dataset.page));
  if (!p || p.iframe || !p.rendered) { setHoveredWord(null); return; }
  handleWordHover(p, ev.clientX, ev.clientY);
});
el.pages.addEventListener("mouseleave", () => setHoveredWord(null));
el.pages.addEventListener("dblclick", (ev) => {
  const div = ev.target.closest(".page");
  const p = div && pages.get(Number(div.dataset.page));
  if (!p || p.iframe || !p.rendered) return;
  handleWordDblClick(p, ev.clientX, ev.clientY);
});

// Dismissal: anywhere else, any scroll, Escape. Mousedown rather than click,
// so the menu is gone before whatever was underneath reacts.
addEventListener("mousedown", (ev) => { if (!el.pageMenu.contains(ev.target)) closeMenu(); }, true);
el.viewer.addEventListener("scroll", closeMenu, { passive: true });

// ---------------------------------------------------------------- voices

const PREFERRED_VOICE = "bf_emma"; // liked in [[14]]'s listening comparison

/*
 * Speech loads in the background and can legitimately be missing (the model
 * weights live outside the repo). Say so in the panel rather than letting the
 * first click fail silently -- a silent failure here is exactly the bug that
 * cost a day in the prototype.
 */
async function reportEngineStatus() {
  const { ok, error } = await window.blitz.ttsStatus();
  el.engineStatus.textContent = ok
    ? "Speech engine ready."
    : `Speech unavailable — ${error}`;
  el.engineStatus.classList.toggle("bad", !ok);
}

async function loadVoices() {
  reportEngineStatus().catch(() => {});
  let names = [];
  try {
    names = (await window.blitz.voices()).voices ?? [];
  } catch (e) {
    console.warn("[tts] speech engine unavailable, voice list is a stub:", e);
    names = [PREFERRED_VOICE];
  }
  el.voice.replaceChildren(
    ...names.map((v) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      return o;
    }),
  );
  el.voice.value = names.includes(PREFERRED_VOICE) ? PREFERRED_VOICE : (names[0] ?? "");
}
loadVoices();

// ---------------------------------------------------------------- variants

// Reading a bad value out of localStorage (corrupted, from an older schema,
// or just not there) should never break startup -- fall back silently.
function loadPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode, quota, etc -- not fatal */ }
}

function syncPillGroup(container, attr, activeKey) {
  if (!container) return;
  for (const btn of container.children) {
    btn.classList.toggle("active", btn.dataset[attr] === activeKey);
  }
}

function setVariant(i) {
  variant = VARIANTS[(i + VARIANTS.length) % VARIANTS.length];
  el.variantLabel.textContent = `${variant.key} (${variant.name})`;
  const url = new URL(location.href);
  url.searchParams.set("variant", variant.key);
  history.replaceState(null, "", url);
  savePref("blitz.variant", variant.key);
  syncPillGroup(el.variantPills, "variant", variant.key);
  repaint();
}

// A URL param (used for judging-mode A/B links) wins over the saved
// preference, which wins over the shipped default (spotlight + nested dim,
// see 16).
const startVariant = VARIANTS.findIndex(
  (v) => v.key === (new URL(location.href).searchParams.get("variant") ?? loadPref("blitz.variant", "C")),
);
setVariant(startVariant < 0 ? 0 : startVariant);

el.prevVariant.onclick = () => setVariant(VARIANTS.indexOf(variant) - 1);
el.nextVariant.onclick = () => setVariant(VARIANTS.indexOf(variant) + 1);
el.variantPills?.addEventListener("click", (e) => {
  const key = e.target.closest("button")?.dataset.variant;
  if (key) setVariant(VARIANTS.findIndex((v) => v.key === key));
});

function setCursorStyle(i) {
  cursorStyle = CURSOR_STYLES[(i + CURSOR_STYLES.length) % CURSOR_STYLES.length];
  el.cursorLabel.textContent = `${cursorStyle.key} (${cursorStyle.name})`;
  const url = new URL(location.href);
  url.searchParams.set("cursor", cursorStyle.key);
  history.replaceState(null, "", url);
  savePref("blitz.cursor", cursorStyle.key);
  syncPillGroup(el.cursorPills, "cursor", cursorStyle.key);
  repaint();
}

// Shipped default is "tint" -- a real solid highlighter pill on the word,
// the Speechify-style look that was asked for -- rather than "dim"'s
// nested-spotlight effect, which has no colored mark on the word at all.
const startCursor = CURSOR_STYLES.findIndex(
  (c) => c.key === (new URL(location.href).searchParams.get("cursor") ?? loadPref("blitz.cursor", "tint")),
);
setCursorStyle(startCursor < 0 ? 0 : startCursor);

el.prevCursor.onclick = () => setCursorStyle(CURSOR_STYLES.indexOf(cursorStyle) - 1);
el.nextCursor.onclick = () => setCursorStyle(CURSOR_STYLES.indexOf(cursorStyle) + 1);
el.cursorPills?.addEventListener("click", (e) => {
  const key = e.target.closest("button")?.dataset.cursor;
  if (key) setCursorStyle(CURSOR_STYLES.findIndex((c) => c.key === key));
});

// ---------------------------------------------------------------- theme
//
// Only the app's own chrome (sidebar, switchers) reads these tokens -- the
// page itself stays real paper-white regardless of theme, same as a PDF or
// EPUB's own background is never recolored (13's "overlays may add, never
// replace" applies to the chrome/page boundary too, not just the overlay).
function setTheme(name) {
  document.documentElement.dataset.theme = name;
  savePref("blitz.theme", name);
  syncPillGroup(el.themePills, "themeChoice", name);
}
setTheme(loadPref("blitz.theme", "light"));
el.themePills?.addEventListener("click", (e) => {
  const name = e.target.closest("button")?.dataset.themeChoice;
  if (name) setTheme(name);
});

// ---------------------------------------------------------------- epub typography

function setEpubFont(name) {
  epubFont = name;
  savePref("blitz.epubFont", name);
  syncPillGroup(el.typefacePills, "typeface", name);
  // Unlike line width/spacing, a font-family swap (and the !important that
  // makes a non-"original" choice actually win over the book's own CSS) has
  // to be baked into a fresh shell -- there's no live-updatable custom
  // property for a full font stack toggle the way --zoom/--reader-* work.
  if (isChapters()) {
    for (const [pn, p] of pages) {
      if (p.rendered) { evictPage(p); renderPage(pn); }
    }
  }
}
setEpubFont(epubFont); // sync the pill's active state at startup
el.typefacePills?.addEventListener("click", (e) => {
  const name = e.target.closest("button")?.dataset.typeface;
  if (name) setEpubFont(name);
});

el.fontSize.addEventListener("input", () => {
  epubFontSize = Number(el.fontSize.value);
  el.fontSizeOut.textContent = `${epubFontSize}px`;
  savePref("blitz.epubFontSize", String(epubFontSize));
  applyEpubTypography();
});
el.lineWidth.addEventListener("input", () => {
  epubLineWidth = Number(el.lineWidth.value);
  el.lineWidthOut.textContent = `${epubLineWidth}px`;
  savePref("blitz.epubLineWidth", String(epubLineWidth));
  applyEpubTypography();
});
el.lineHeight.addEventListener("input", () => {
  epubLineHeight = Number(el.lineHeight.value);
  el.lineHeightOut.textContent = epubLineHeight.toFixed(1);
  savePref("blitz.epubLineHeight", String(epubLineHeight));
  applyEpubTypography();
});
el.fontSize.value = String(epubFontSize);
el.fontSizeOut.textContent = `${epubFontSize}px`;
el.lineWidth.value = String(epubLineWidth);
el.lineWidthOut.textContent = `${epubLineWidth}px`;
el.lineHeight.value = String(epubLineHeight);
el.lineHeightOut.textContent = epubLineHeight.toFixed(1);

addEventListener("keydown", (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
  if (e.key === "ArrowLeft") setVariant(VARIANTS.indexOf(variant) - 1);
  else if (e.key === "ArrowRight") setVariant(VARIANTS.indexOf(variant) + 1);
  else if (e.key === "c") setCursorStyle(CURSOR_STYLES.indexOf(cursorStyle) + 1);
  else if (e.key === " ") { e.preventDefault(); play(); }
  else if (e.key === "h") toggleSettings();
});

const toggleSettings = () => document.getElementById("app").classList.toggle("bare");
$("hide").onclick = toggleSettings;
$("closeSettings").onclick = toggleSettings;

/*
 * One settings section open at a time, and the app comes back to whichever
 * one you left open. The panel used to show every control at once, which is
 * a wall rather than a set of choices.
 */
const SECTION_KEY = "blitz.settingsSection";
const sections = [...document.querySelectorAll("#side details.sect")];
const openSection = loadPref(SECTION_KEY, "page");
for (const d of sections) {
  d.open = d.dataset.sect === openSection;
  d.addEventListener("toggle", () => {
    if (!d.open) return;
    for (const other of sections) if (other !== d) other.open = false;
    savePref(SECTION_KEY, d.dataset.sect);
  });
}

// ---------------------------------------------------------------- wiring

el.toLibrary.onclick = () => goHome();
el.playToggle.onclick = () => play();
initPanels({ onGoTo: goToPage, onOpenNote: goToNote, getContext: noteContext, onSaveNotes: saveNotes });
setToc([], "Open a book to see its contents.");
setNotes([], { enabled: false, reason: "Open a book to take notes on it." });
initHome({ onOpen: openBook, onPick: () => el.file.click(), onAddSite: addSite });
setView("home");
// Reading position is throttled, so a quit mid-book would otherwise drop the
// last few seconds of it.
window.addEventListener("pagehide", flushPosition);
window.addEventListener("blur", flushPosition);

el.file.onchange = () => {
  const f = el.file.files?.[0];
  if (f) openFile(f);
};

el.viewer.addEventListener("dragover", (e) => {
  e.preventDefault();
  el.viewer.classList.add("dragging");
});
el.viewer.addEventListener("dragleave", () => el.viewer.classList.remove("dragging"));
el.viewer.addEventListener("drop", (e) => {
  e.preventDefault();
  el.viewer.classList.remove("dragging");
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

// The home page is a drop target as well -- "drop a PDF anywhere on this
// page" is what it says, and the viewer is not mounted while it is showing.
const home = document.getElementById("home");
home.addEventListener("dragover", (e) => e.preventDefault());
home.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

/*
 * One speed control, two mechanisms, and the reader hears neither.
 *
 * This used to be two: a live playback-rate slider and a separate Kokoro
 * "native speed". The live one is instant because it does not re-synthesize
 * anything -- but playbackRate with preservesPitch is Chromium's WSOLA time
 * stretcher, and WSOLA at anything other than 1.0 warbles: periodic dips in
 * volume and crackle at the overlap-add seams. Anyone who moved that slider
 * was listening to a stretched signal for the rest of the session.
 *
 * So the slider still stretches, but only until the drag stops. Then the
 * speed is handed to Kokoro, which changes speed by predicting different
 * durations -- real speech at the new pace, nothing stretched -- and every
 * sentence from the next one on plays back untouched at rate 1.
 */
let rateSettleTimer = null;
const RATE_SETTLE_MS = 400;

el.rate.oninput = () => {
  const want = Number(el.rate.value);
  el.rateOut.textContent = want.toFixed(2);
  // Instant, for the sentence already in the element. Stretching by the
  // ratio, not the absolute rate: this clip may already be a fast one.
  audioEl.playbackRate = want / playingSpeed;
  clearTimeout(rateSettleTimer);
  rateSettleTimer = setTimeout(() => adoptSpeed(want), RATE_SETTLE_MS);
};

/** Make `speed` the speed we synthesize at, and drop the lookahead made at the old one. */
function adoptSpeed(speed) {
  if (speed === synthSpeed) return;
  synthSpeed = speed;
  prefetchCache.clear();
  fetchQueue.length = 0;
  if (cursor) ensurePrefetch(cursor, { priority: true }).catch(() => {});
}

el.voice.onchange = () => {
  prefetchCache.clear();
  fetchQueue.length = 0;
  if (cursor) ensurePrefetch(cursor, { priority: true }).catch(() => {});
};

el.zoom.oninput = () => reZoom(Number(el.zoom.value));

/*
 * Ctrl+wheel zoom, anchored on the pointer -- the gesture every PDF reader
 * has. passive:false because it has to preventDefault: left alone, Chromium
 * turns ctrl+wheel into browser zoom, which scales the chrome along with the
 * page and is not what anyone means by zooming a document.
 *
 * The step is exponential so each notch is the same proportional change at
 * every zoom level; deltaMode 1 is a line-scrolling mouse rather than a
 * trackpad, so its deltas are much coarser.
 */
el.viewer.addEventListener("wheel", (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  const per = e.deltaMode === 1 ? 0.05 : 0.0012;
  reZoom(scale * Math.exp(-e.deltaY * per), e.clientY);
}, { passive: false });

// Keyboard zoom, for the same reason: ctrl +/-/0 is the other half of the
// gesture people already have in their hands.
addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === "+" || e.key === "=") { e.preventDefault(); reZoom(scale * 1.1); }
  else if (e.key === "-") { e.preventDefault(); reZoom(scale / 1.1); }
  else if (e.key === "0") { e.preventDefault(); reZoom(1.2); }
});

el.showall.onchange = repaint;
el.showRegions.onchange = repaint;
el.enableLayout.onchange = () => {
  if (!el.enableLayout.checked || docKind !== "pdf") return;
  // Only meaningful for PDF: reading order there can interleave columns in
  // content-stream order. An epub chapter's TreeWalker already visits nodes
  // in document order, which for reflowable HTML *is* the reading order --
  // there's no equivalent reordering problem for the layout model to fix.
  // Only pages already on screen need a nudge; renderPage() checks the box
  // itself for anything rendered from here on.
  for (const p of pages.values()) if (p.rendered && !p.regions) refineLayout(p);
};
syncLayoutControls(); // no doc open yet -- starts disabled
syncTypographyControls();

/*
 * Full screen is the one state whose exit the app has to supply itself: it
 * hides the window chrome, which is where every other way out lives. So the
 * page binds both keys, and says so the moment it happens -- a reminder that
 * appears once and fades, rather than a permanent badge over the reading.
 */
let isFullScreen = false;
let fsHintTimer = null;

window.blitz.fullscreen?.onChange((on) => {
  isFullScreen = on;
  clearTimeout(fsHintTimer);
  el.fsHint.classList.remove("fading");
  if (!on) { el.fsHint.hidden = true; return; }
  el.fsHint.hidden = false;
  fsHintTimer = setTimeout(() => {
    el.fsHint.classList.add("fading");
    fsHintTimer = setTimeout(() => { el.fsHint.hidden = true; }, 300);
  }, 3200);
});

/*
 * Its own listener, deliberately outside the transport's guards below: those
 * ignore keys while a note is being typed, and being unable to leave full
 * screen because the cursor happens to be in a text box is the same trap
 * again. Escape only acts here when there is actually something to escape.
 */
addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === "F11") { e.preventDefault(); window.blitz.fullscreen.set(); return; }
  if (e.key === "Escape" && isFullScreen && el.pageMenu.hidden) {
    e.preventDefault();
    window.blitz.fullscreen.set(false);
  }
});

/*
 * The transport, in full. There is deliberately no play button anywhere --
 * the human's call, and the right one: a reading app should look like the
 * thing being read. So reading starts from the page's own menu or from here,
 * and this is the only place the keys are defined.
 *
 * Not Space: Space scrolls a document, and behaving like a document is the
 * whole point of this round.
 */
addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // Never while someone is writing a note.
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

  if (e.key === "Escape") {
    if (!el.pageMenu.hidden) { closeMenu(); return; }
    if (isFullScreen) return; // handled below, whatever has focus
    if (playing) { stop(); return; }
    return;
  }
  if (e.key === "p" || e.key === "P") {
    if (!doc) return;
    e.preventDefault();
    if (playing) pause();
    else play(cursor ?? undefined);
  }
});

new ResizeObserver(() => updatePageNow()).observe(el.viewer);

addEventListener("beforeunload", () => audioEl.pause());

report();
console.log("[blitz] pdfjs-dist", pdfjsLib.version);

// Debug hook, used by verify.mjs to check the geometry pipeline headlessly.
window.__spike = {
  pages, renderPage, setVariant, version: pdfjsLib.version,
  get scale() { return scale; },
  preview(pn, si) { speaking = { pn, si }; repaint(); return pages.get(pn)?.sentences[si] ?? null; },
  setCursorStyle, play, stop,
  // Test hooks: the note path is driven by a live text selection, which a
  // harness has to be able to see the way the app does.
  liveSelection, noteContext, addSite, goToNote, locateNote,
  chapterHref: (pn) => doc?.chapters?.[pn - 1]?.href ?? null,
  goToPage, anchorOffset,
  get siteTally() { return lastTally; },
  geomFor, pageAtOffset, evictPage,
  openSiteForTest: openSite,
  get cursorStyle() { return cursorStyle; },
  get fullScreen() { return isFullScreen; },
  get activeWordIdxs() { return activeWordIdxs; },
  // Diagnostic for word-box alignment reports: draws every word's box in a
  // sentence at once (not just the one word a real read would light up),
  // reusing the exact shipped padWord/rect/cornerRadius path, so a
  // screenshot shows precisely what ships. `raw: true` skips padding and
  // rounding entirely -- the Range.getClientRects() measurement with
  // nothing added -- which is the fastest way to tell "the underlying word
  // rect is off" apart from "the padding/rounding made it look off" on a
  // specific page someone reports as wrong.
  debugWordBoxes(pn, si, raw) {
    const p = pages.get(pn);
    const s = p?.sentences[si];
    if (!s) return null;
    const words = getWordRects(p, s);
    clearOverlay(p);
    for (const w of words) {
      const boxes = raw ? w.rects : w.rects.map((r) => padWord(p, r));
      for (const b of boxes) {
        p.svg.append(rect(b.x, b.y, b.w, b.h, "rgba(217, 119, 87, 0.35)", raw ? {} : cornerRadius(p, b.h, 5)));
      }
    }
    return words.map((w) => w.text);
  },
};
