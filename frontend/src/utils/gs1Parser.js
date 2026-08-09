import { GS1Parser } from "@valentynb/gs1-parser";

// =========================================================================
// GS1 BARCODE PARSER
// =========================================================================
// Uses @valentynb/gs1-parser (a maintained, spec-based GS1-128 decoder)
// instead of hand-rolled field-boundary guessing — that guessing (matching
// digit patterns to guess where a variable-length field like batch/lot
// ends) was the root cause of truncated batch codes and price text leaking
// into the name field, because it could misfire whenever a field's own
// content happened to contain a sequence that looked like the start of
// another Application Identifier. A real GS1 decoder resolves field
// boundaries from the actual separator character and the spec's fixed-vs-
// variable-length rules, not guesswork.

const GS = "\x1D";

// AI 10 (batch/lot) is defined by the GS1 spec as N2+X..20 — max 20
// alphanumeric characters. A small safety margin over spec is reasonable
// (some real-world encoders pad slightly), but a large one works against
// us: our actual failure mode has been garbage/concatenated data landing
// in the batch field, and an overly generous max length makes the parser
// more willing to silently absorb exactly that kind of corrupted string
// as if it were a real batch code, rather than flagging it.
const gs1Parser = new GS1Parser({ lotMaxLength: 24 });

// Normalizes whatever shape the library hands back for AI 17 (expiry) into
// the exact YYYY-MM format the rest of the app expects. This matters
// beyond just consistency: StockManagement.jsx and RestockScreen.jsx both
// sync a scanned expiry into their Month/Year fields using an ANCHORED
// regex (/^\d{4}-\d{2}$/) that only matches a 7-character string — handing
// them a longer ISO datetime string fails that check silently, so the
// value would be stored but never show up in the visible fields.
const normalizeExpiry = (value) => {
  if (!value) return "";

  if (value instanceof Date) {
    return value.toISOString().slice(0, 7);
  }

  const raw = String(value).trim();
  if (!raw) return "";

  const compact = raw.replace(/T.*$/, "");

  const dateMatch = compact.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (dateMatch) return `${dateMatch[1]}-${dateMatch[2]}`;

  const yearMonthMatch = compact.match(/^(\d{4})[-/](\d{2})$/);
  if (yearMonthMatch) return `${yearMonthMatch[1]}-${yearMonthMatch[2]}`;

  // Raw YYMMDD fallback, in case the library ever hands back the
  // unparsed source string instead of a normalized date.
  const sixDigitMatch = compact.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (sixDigitMatch) {
    const year = parseInt(sixDigitMatch[1], 10);
    const fullYear = year >= 70 ? 1900 + year : 2000 + year;
    return `${fullYear}-${sixDigitMatch[2]}`;
  }

  return raw.slice(0, 7);
};

// Cleans up whatever the hardware scanner actually sent before handing it
// to the GS1 decoder: strips stray control characters (but keeps the real
// GS 0x1D field separator), drops a stray leading '*' some scanners add,
// and — if there's noise before the real GTIN starts (a misread character,
// a symbology identifier the scanner didn't strip, etc.) — finds where
// "01" + 14 digits actually begins and recovers from there instead of
// failing the whole scan over leading garbage.
export const sanitizeScannerPayload = (scan) => {
  if (!scan || typeof scan !== "string") return "";

  let sanitized = scan
    .replace(/\u0000/g, "")
    .replace(/[^\x20-\x7E\x1D]/g, "")
    .replace(/\*/g, "")
    .trim();

  if (!sanitized) return "";

  const startMatch = sanitized.match(/01\d{14}/);
  if (startMatch && startMatch.index !== undefined && startMatch.index > 0) {
    sanitized = sanitized.slice(startMatch.index);
  }

  return sanitized;
};

// =========================================================================
// NO-SEPARATOR FALLBACK
// =========================================================================
// Some of this pharmacy's real barcodes carry NO separator character
// anywhere at all — not just after the fixed-length expiry field, which
// the defensive insertion above handles, but between every field. The
// GS1Parser library correctly can't resolve field boundaries in that case
// (there's genuinely nothing to resolve them from), so this is a second,
// narrower parser built specifically for that situation.
//
// It's anchored on one fact that's actually verifiable rather than
// guessed: AI 17 (expiry) is always exactly 6 digits representing a real
// calendar date. Scanning for every "17" substring and keeping only the
// one whose following 6 digits form a valid month/day is what correctly
// resolves cases where "17" also appears coincidentally elsewhere in the
// string (confirmed against a real scan where an earlier "17" produced
// month "72" — invalid — and the true one came later).
//
// The field order (batch-then-expiry vs expiry-then-batch) and the set of
// trailing fields (a serial number under AI 21, a name+price blob under
// AI 240, sometimes both chained together) both vary across real scans
// from this pharmacy — reverse-engineered from 17 actual hardware scans,
// not assumed. When a scan doesn't fit any of these recognized shapes,
// this returns nulls rather than guessing — an honest "couldn't resolve
// this one" is safer than a confident wrong answer.
const isValidYYMMDD = (sixDigits) => {
  if (!/^\d{6}$/.test(sixDigits)) return false;
  const mm = parseInt(sixDigits.slice(2, 4), 10);
  const dd = parseInt(sixDigits.slice(4, 6), 10);
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
};

const findValidExpiryPosition = (rest) => {
  let i = 0;
  while (true) {
    const idx = rest.indexOf("17", i);
    if (idx === -1) return -1;
    if (isValidYYMMDD(rest.slice(idx + 2, idx + 8))) return idx;
    i = idx + 1;
  }
};

// Parses whatever comes after batch+expiry are already resolved — a chain
// of AI-marker segments (21 = serial, 240 = name/price blob), each running
// until the next recognized marker or end of string.
const parseTrailingChain = (tail, parsed) => {
  let remaining = tail;
  while (remaining.length > 0) {
    const marker = remaining.slice(0, 3) === "240" ? "240"
      : remaining.slice(0, 2) === "21" ? "21"
      : null;
    if (!marker) break;

    const rest = remaining.slice(marker.length);
    const nextIdx = (() => {
      const positions = ["21", "240"]
        .map((m) => rest.indexOf(m))
        .filter((p) => p > 0);
      return positions.length ? Math.min(...positions) : rest.length;
    })();
    const value = rest.slice(0, nextIdx);
    remaining = rest.slice(nextIdx);

    if (marker === "240") {
      const rsMatch = value.match(/(.*?)Rs\.?(\d+(\.\d+)?)/i);
      if (rsMatch) {
        parsed.name = rsMatch[1].trim();
        parsed.retailPrice = rsMatch[2];
      } else if (value.trim()) {
        parsed.name = value.trim();
      }
    }
    // AI 21 (serial number) isn't used elsewhere in this app — resolving
    // it out of the chain matters so it doesn't get left dangling inside
    // the batch or name, but the value itself doesn't need to be kept.
  }
};

const parseNoSeparatorFallback = (sanitized) => {
  const result = { gtin: null, batch: null, expiry: null, name: "", retailPrice: "" };

  const gtin = sanitized.slice(2, 16);
  const rest = sanitized.slice(16);
  const expPos = findValidExpiryPosition(rest);
  if (expPos === -1) return result; // no verifiable date anywhere — don't guess

  const expiryDigits = rest.slice(expPos + 2, expPos + 8);
  const year = 2000 + parseInt(expiryDigits.slice(0, 2), 10);
  const expiry = `${year}-${expiryDigits.slice(2, 4)}`;

  if (rest.startsWith("17") && expPos === 0) {
    // Order: GTIN -> expiry -> batch. Batch is bounded by a price marker
    // (this pharmacy's own convention) or a genuine AI 240 marker — but
    // "240" can also appear coincidentally as a plain digit sequence
    // inside a longer numeric batch (confirmed: e.g. "...19624030s..."
    // contains "240" purely by chance). A REAL AI 240 marker is always
    // followed by actual product-name text (letters); a coincidental
    // match is followed by more digits (continuing the batch number) or
    // just the trailing "s" artifact — checking for that is what tells
    // them apart reliably.
    const afterExpiry = rest.slice(8);
    if (!afterExpiry.startsWith("10")) return result;
    const batchRegion = afterExpiry.slice(2);

    const rsIdx = batchRegion.search(/s?\W*Rs\.?\d/i);
    const preRs = rsIdx >= 0 ? batchRegion.slice(0, rsIdx) : batchRegion;
    const markerMatch = preRs.match(/^(.*?)(21|240)/);
    const afterMarker = markerMatch ? preRs.slice(markerMatch[1].length + markerMatch[2].length) : "";
    const looksLikeRealName = /[A-Za-z].*[A-Za-z]/.test(afterMarker.replace(/s$/i, ""));

    if (markerMatch && looksLikeRealName) {
      result.gtin = gtin;
      result.expiry = expiry;
      result.batch = markerMatch[1].trim();
      parseTrailingChain(batchRegion.slice(markerMatch[1].length), result);
      return result;
    }

    const rsMatch = batchRegion.match(/^(.*?)s?\W*Rs\.?(\d+(\.\d+)?)/i);
    if (rsMatch) {
      result.gtin = gtin;
      result.expiry = expiry;
      result.batch = rsMatch[1].trim();
      result.retailPrice = rsMatch[2];
      return result;
    }

    // No recognizable terminator at all — keep the whole remainder as
    // batch rather than discarding it.
    result.gtin = gtin;
    result.expiry = expiry;
    result.batch = batchRegion.trim();
    return result;
  }

  if (rest.startsWith("10")) {
    // Order: GTIN -> batch -> expiry -> (serial/name chain).
    result.gtin = gtin;
    result.expiry = expiry;
    result.batch = rest.slice(2, expPos).trim();
    parseTrailingChain(rest.slice(expPos + 8), result);
    return result;
  }

  return result; // doesn't fit either recognized shape — don't guess
};

export const parsePharmacyBarcode = (scan) => {
  const parsed = {
    raw: scan || "",
    gtin: scan || "",
    batch: "",
    expiry: "",
    name: "",
    retailPrice: "",
  };

  const sanitized = sanitizeScannerPayload(scan);
  if (!sanitized) return parsed;

  // Not every product barcode is full GS1-128 — some are plain EAN/UPC. In
  // that case there's no structure to decode; the raw scan itself IS the
  // identifying code, same as before.
  if (!sanitized.startsWith("01") || sanitized.length < 16) {
    parsed.gtin = sanitized;
    return parsed;
  }

  // Defensive normalization: AI 17 (expiry) is fixed-length (exactly 6
  // digits) per the GS1 spec and technically needs no terminator — but
  // this parser library expects a separator after every field, fixed-
  // length or not, and otherwise silently absorbs whatever comes right
  // after the 6 expiry digits into that field instead of treating it as
  // the next one. Inserting a separator there when it's missing fixes
  // that without altering anything for scans that already send one
  // (verified against both cases before this shipped).
  let normalized = sanitized;
  const expiryFieldMatch = normalized.match(/^01(\d{14})17(\d{6})/);
  if (expiryFieldMatch) {
    const afterExpiryIdx = 2 + 14 + 2 + 6; // "01" + gtin(14) + "17" + YYMMDD(6)
    if (normalized[afterExpiryIdx] !== GS) {
      normalized = normalized.slice(0, afterExpiryIdx) + GS + normalized.slice(afterExpiryIdx);
    }
  }

  let structuredOk = false;

  try {
    const result = gs1Parser.decode(normalized);
    const data = result.data || {};

    if (data.gtin && data.gtin.data) parsed.gtin = data.gtin.data;
    if (data.batch && data.batch.data) parsed.batch = data.batch.data;
    if (data.expDate && data.expDate.data) {
      parsed.expiry = normalizeExpiry(data.expDate.data);
    }

    // This pharmacy's own barcode generator stuffs a free-text
    // "name + Rs.price" blob into AI 240 (Additional Product ID) — that's
    // not a standard GS1 use of the field, so the library correctly hands
    // it back as opaque text; splitting it into name/price is this app's
    // own business logic on top.
    const extraText = (data.additionalProductID && data.additionalProductID.data) || "";
    const rsMatch = extraText.match(/(.*?)Rs\.?(\d+(\.\d+)?)/i);
    if (rsMatch) {
      parsed.name = rsMatch[1].trim();
      parsed.retailPrice = rsMatch[2];
    } else if (extraText) {
      parsed.name = extraText.trim();
    }

    // Fallback for a specific, recurring encoding gap: some of this
    // pharmacy's barcodes have NO separator after the batch field at all
    // (not just after expiry), so trailing price/name text runs straight
    // into the batch with nothing marking the boundary — e.g. a batch of
    // "601-4702401" printed with no gap before "sRs.160.00". There's no
    // way to know with certainty where the real batch ends without a
    // delimiter, but a "Rs." price marker is a reliable-enough anchor for
    // THIS app's own convention: trim the batch back to just before it,
    // and pull out whatever price follows, rather than leaving the price
    // text embedded inside the stored batch code.
    if (!parsed.retailPrice && parsed.batch) {
      const batchPriceMatch = parsed.batch.match(/^(.*?)s?\W*Rs\.?(\d+(\.\d+)?)/i);
      if (batchPriceMatch) {
        parsed.batch = batchPriceMatch[1].trim();
        parsed.retailPrice = batchPriceMatch[2];
      }
    }

    structuredOk = !!(parsed.batch && parsed.expiry);

    // A batch that still contains an embedded "240" marker followed by
    // real name-like text means the decoder swallowed more than the
    // actual batch (it had no closing separator to stop at) — the Rs-
    // price cleanup above only trims the price, not this. Treat it as
    // unreliable so the no-separator fallback below (which correctly
    // resolves the 240 boundary) gets a chance to produce the real split.
    if (structuredOk) {
      const embeddedMarker = parsed.batch.match(/^(.*?)(240)(.*)$/);
      if (embeddedMarker && /[A-Za-z].*[A-Za-z]/.test(embeddedMarker[3].replace(/s$/i, ""))) {
        structuredOk = false;
      }
    }
  } catch (err) {
    // Malformed/non-conforming GS1 data — fall through to the
    // no-separator fallback below.
  }

  // Only reached when the structured, spec-based decode above didn't
  // produce a usable batch+expiry — i.e. genuinely no separator anywhere
  // in this scan. See parseNoSeparatorFallback for how this resolves
  // field boundaries without one.
  if (!structuredOk) {
    const fb = parseNoSeparatorFallback(sanitized);
    if (fb.batch && fb.expiry) {
      parsed.gtin = fb.gtin;
      parsed.batch = fb.batch;
      parsed.expiry = fb.expiry;
      if (fb.name) parsed.name = fb.name;
      if (fb.retailPrice) parsed.retailPrice = fb.retailPrice;
    }
  }

  return parsed;
};

// A canonical, known-good test scan — useful for a quick sanity check
// after any change to this file, without needing physical scanner
// hardware on hand.
export const SAMPLE_GS1_TEST_SCAN = `010123456789012317260101${GS}10ABC123${GS}240Panadol ExtraRs100`;