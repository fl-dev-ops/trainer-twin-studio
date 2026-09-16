import { readFile } from "node:fs/promises";
import path from "node:path";
import { init, type WrappedPdfiumModule } from "@embedpdf/pdfium";

/**
 * Locates each resume claim inside the PDF's own text layer and returns the exact string the
 * learner's viewer can highlight.
 *
 * The viewer highlights by running a literal pdfium search over the rendered PDF, so an anchor is
 * only useful when it is a verbatim substring of that layer. The claim text does not qualify: it is
 * rendered by the markdown converter, which re-spaces hyphenated entry titles ("Machine Learning
 * Engineer - Intern" becomes "Machine Learning Engineer-Intern") and leaves the line-break
 * hyphenation inside a word ("algorithms" becomes "algo- rithms"). Both sides are canonicalized the
 * same way so the claim can be found, and the span is then re-emitted in the layer's own characters.
 */

/** pdfium marks a hyphenated line break with U+FFFE; converters and editors add the rest. */
const INVISIBLE: Record<string, true> = {
  "\uFFFE": true,
  "\u00AD": true,
  "\u200B": true,
  "\u2060": true,
  "\uFEFF": true,
};
/** Every dash form a resume may use for the same glyph. */
const DASH: Record<string, true> = {
  "-": true,
  "\u2010": true,
  "\u2011": true,
  "\u2012": true,
  "\u2013": true,
  "\u2014": true,
  "\u2015": true,
};
const SPACE: Record<string, true> = {
  " ": true,
  "\t": true,
  "\n": true,
  "\r": true,
  "\f": true,
  "\v": true,
  "\u00A0": true,
  "\u2007": true,
  "\u2009": true,
  "\u202F": true,
};

type Pdfium = WrappedPdfiumModule & {
  pdfium: WrappedPdfiumModule["pdfium"] & { HEAPU8: Uint8Array };
};

let loading: Promise<Pdfium> | null = null;

/** pdfium is a 4.6 MB WASM binary, so it is initialized once per server process. */
function pdfium(): Promise<Pdfium> {
  loading ??= (async () => {
    // Plain path, not a module specifier: webpack must not try to bundle the binary.
    // `outputFileTracingIncludes` in next.config.ts ships this file with the server routes.
    const wasmPath = path.join(process.cwd(), "node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm");
    const module_ = (await init({ wasmBinary: await readFile(wasmPath) } as never)) as Pdfium;
    // The engine's own constructor calls this before any document is opened.
    module_.PDFiumExt_Init();
    return module_;
  })();
  return loading;
}

/**
 * Canonical comparison form plus the raw offset of every canonical character.
 *
 * Two renderings of the same resume text must land on the same string:
 * - the converter re-spaces hyphenated entry titles — the layer has `Machine Learning Engineer -
 *   Intern` where the converter wrote `Machine Learning Engineer-Intern`;
 * - the converter keeps a line break inside a hyphenated word — the layer has `algorithms` where the
 *   converter wrote `algo- rithms`.
 *
 * A dash surrounded by spaces therefore becomes a bare hyphen, a dash that ends a word and is
 * followed by a break disappears, and everything lowercases. A dash with no space on either side is
 * a genuine compound (`Secondary-Science`, `2020-apr`) and survives.
 */
function canonicalize(source: string) {
  let collapsed = "";
  const rawOf: number[] = [];
  let spacePending = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (INVISIBLE[character]) continue;
    if (SPACE[character]) {
      spacePending = true;
      continue;
    }
    if (spacePending && collapsed.length > 0) {
      collapsed += " ";
      rawOf.push(index);
    }
    spacePending = false;
    const lowered = character.toLowerCase();
    collapsed += DASH[lowered] ? "-" : lowered;
    rawOf.push(index);
  }

  let text = "";
  const offsets: number[] = [];
  for (let index = 0; index < collapsed.length; index++) {
    const character = collapsed[index];
    if (character === "-") {
      const spaceBefore = text.endsWith(" ");
      let next = index + 1;
      while (next < collapsed.length && collapsed[next] === " ") next++;
      if (next > index + 1 && !spaceBefore) {
        // A break inside a word: the hyphen and the break both go.
        index = next - 1;
        continue;
      }
      if (spaceBefore) {
        text = text.slice(0, -1);
        offsets.pop();
      }
      text += "-";
      offsets.push(rawOf[index]);
      index = next - 1;
      continue;
    }
    // The layer pads before closing punctuation where the converter does not ("Palakkad , Kerala").
    if (character === " " && /[,.;:\])]/.test(collapsed[index + 1] ?? "")) continue;
    text += character;
    offsets.push(rawOf[index]);
  }
  return { text, offsets };
}

/**
 * The claim's span inside one page of the text layer, as raw offsets into that page's text, or null
 * when the claim is not on the page.
 */
export function claimSpanInPage(pageText: string, claim: string) {
  const page = canonicalize(pageText);
  const needle = canonicalize(claim).text;
  if (!needle) return null;
  const at = page.text.indexOf(needle);
  if (at < 0) return null;
  let first = at;
  let last = at + needle.length - 1;
  while (first <= last && page.text[first] === " ") first++;
  while (last >= first && page.text[last] === " ") last--;
  if (last < first) return null;
  return { start: page.offsets[first], end: page.offsets[last] + 1 };
}

/** Collapse what pdfium inserts for page layout, keeping the layer's own characters. */
function collapseLayout(raw: string) {
  return raw
    .replace(/-\uFFFE\s*/g, "")
    .replace(/[\uFFFE\u00AD\u200B\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Anchors for the given claim texts, in the same order, or null where the claim could not be found
 * on a page. Every returned anchor is confirmed with the very search call the viewer makes, so a
 * stored anchor always lands. Never throws for a malformed or encrypted PDF: the caller's fallback
 * keeps uploads working.
 */
export async function locateClaimAnchors(
  pdf: Uint8Array,
  claimTexts: string[]
): Promise<Array<string | null>> {
  if (claimTexts.length === 0) return [];
  const module_ = await pdfium();
  const { malloc, free } = module_.pdfium.wasmExports;

  const documentBytes = malloc(pdf.byteLength);
  module_.pdfium.HEAPU8.set(pdf, documentBytes);
  const document_ = module_.FPDF_LoadMemDocument(documentBytes, pdf.byteLength, "");
  if (!document_) {
    free(documentBytes);
    return claimTexts.map(() => null);
  }

  const pages: Array<{ text: string; page: number; textPage: number }> = [];
  try {
    const pageCount = module_.FPDF_GetPageCount(document_);
    for (let index = 0; index < pageCount; index++) {
      const page = module_.FPDF_LoadPage(document_, index);
      if (!page) continue;
      const textPage = module_.FPDFText_LoadPage(page);
      if (!textPage) {
        module_.FPDF_ClosePage(page);
        continue;
      }
      const length = module_.FPDFText_CountChars(textPage);
      const buffer = malloc(2 * (length + 1));
      module_.FPDFText_GetText(textPage, 0, length, buffer);
      const text = module_.pdfium.UTF16ToString(buffer);
      free(buffer);
      pages.push({ text, page, textPage });
    }

    // The exact call the viewer makes when it highlights, so a verified anchor always lands.
    const foundInLayer = (textPage: number, query: string) => {
      const bytes = 2 * (query.length + 1);
      const queryPointer = malloc(bytes);
      module_.pdfium.stringToUTF16(query, queryPointer, bytes);
      const handle = module_.FPDFText_FindStart(textPage, queryPointer, 0, 0);
      const found = handle ? module_.FPDFText_FindNext(handle) : false;
      if (handle) module_.FPDFText_FindClose(handle);
      free(queryPointer);
      return Boolean(found);
    };

    return claimTexts.map((claim) => {
      for (const page of pages) {
        const span = claimSpanInPage(page.text, claim);
        if (!span) continue;
        const raw = page.text.slice(span.start, span.end);
        for (const candidate of [collapseLayout(raw), raw]) {
          if (candidate && foundInLayer(page.textPage, candidate)) return candidate;
        }
      }
      return null;
    });
  } finally {
    for (const page of pages) {
      module_.FPDFText_ClosePage(page.textPage);
      module_.FPDF_ClosePage(page.page);
    }
    module_.FPDF_CloseDocument(document_);
    free(documentBytes);
  }
}
