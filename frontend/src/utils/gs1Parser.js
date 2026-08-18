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

  // This is meant to strip a HANDFUL of stray leading bytes a misconfigured
  // scanner sometimes injects before the real code — not to jump forward
  // to any coincidental "01"+14-digit run anywhere in the string. A large
  // jump distance means what's being discarded is very likely the actual
  // intended start of a different, non-GS1-128 barcode that just happens
  // to contain a matching digit run further in — confirmed against real
  // inventory rows where this fabricated a GTIN with no real basis (from
  // barcodes starting "8014..." and "1210...", neither of which is
  // GS1-128 at all). Genuine leading scanner noise is a few stray
  // characters, not dozens.
  //
  // The short-distance cap above ISN'T enough on its own, though: on an
  // all-digit barcode like "8014261880...", a fake "01"+14-digit run can
  // start at index 1 too — well inside the cap — and stripping there
  // chops a real leading digit off a plain numeric code, not noise. Real
  // scanner noise is non-digit junk (control bytes, stray symbols); it
  // never looks like more digits belonging to the same number. So this
  // only strips when the discarded prefix has at least one non-digit
  // character in it — confirmed against that same "8014..." row, which
  // this used to still mis-fire on even under the 5-char cap.
  const MAX_NOISE_PREFIX = 5;
  const startMatch = sanitized.match(/01\d{14}/);
  if (
    startMatch &&
    startMatch.index !== undefined &&
    startMatch.index > 0 &&
    startMatch.index <= MAX_NOISE_PREFIX &&
    !/^\d+$/.test(sanitized.slice(0, startMatch.index))
  ) {
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
  // GS1 allows DD = "00" on AI 17 to mean "no specific day" (commonly read
  // as end-of-month) — that's a real, spec-legal value, not garbage, and
  // rejecting it was silently failing every scan that used it (confirmed
  // against real scans in this pharmacy's batch that use day "00").
  return mm >= 1 && mm <= 12 && dd >= 0 && dd <= 31;
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

// Matches this pharmacy's various "Rs" price notations, all seen in real
// scans: Rs100, Rs.100, Rs. 100, Rs:100, Rs: 100 — and the same preceded by
// a stray apostrophe or trailing "s" pack-size artifact ("Tab'Rs:510.00",
// "tab28sRs.1064") or an "MRP." prefix ("MRP.Rs.900.00", "MRP.Rs. 407.00").
// The separator after "Rs" (".", ":", or nothing) and the whitespace around
// it are both optional because different scans from this pharmacy are
// inconsistent about them.
// Also recognizes "M.R.P." (with periods, no "Rs" alongside at all) —
// confirmed against a real scan ending "...NORPLAT75MGTABM.R.P.684.67".
const PRICE_REGEX = /^(.*?)s?\W*?(?:Rs|M\.?R\.?P\.?)\s*[.:]?\s*(\d+(?:\.\d+)?)/i;

// "MRP" (Maximum Retail Price) is a label prefix printed right before the
// price, not a product name — this pharmacy's scans just don't separate
// them. Treating it as a real name (confirmed: several scans were showing
// "MRP" as the product name) is wrong; when that's all we've got, leave
// name blank so the app falls back to looking the product up by GTIN.
const isPlaceholderName = (name) => /^m\.?\s*r\.?\s*p\.?$/i.test(name);

const splitNameAndPrice = (text) => {
  const match = text.match(PRICE_REGEX);
  if (match) {
    const name = match[1].trim();
    return { name: isPlaceholderName(name) ? "" : name, retailPrice: match[2] };
  }
  const name = text.trim();
  return { name: isPlaceholderName(name) ? "" : name, retailPrice: "" };
};

// AI 11 (production/pack date) is fixed-length (6 digits) just like AI 17,
// and this pharmacy's generator sometimes chains it directly after the
// batch with no separator: batch(10) -> prodDate(11) -> expiry(17). Left
// unhandled, the whole "batch + AI11 marker + production date" span gets
// swallowed into batch — confirmed against a real scan where the expected
// batch was "152" but the parser produced "15211260702" (batch + "11" + a
// valid production date, glued on with nothing to mark the boundary).
// Checking specifically the LAST 8 characters of the candidate batch is
// what's safe here: production date always sits immediately before
// expiry, so if the tail is "11" plus a real calendar date, that's it.
// Also reports whether it actually found one, since that's used below as
// a signal for a second, narrower cleanup step.
const stripEmbeddedProductionDate = (batchCandidate) => {
  if (batchCandidate.length < 8) return { batch: batchCandidate, hadProductionDate: false };
  const tail = batchCandidate.slice(-8);
  if (tail.startsWith("11") && isValidYYMMDD(tail.slice(2))) {
    return { batch: batchCandidate.slice(0, -8), hadProductionDate: true };
  }
  return { batch: batchCandidate, hadProductionDate: false };
};

// Seen so far in exactly one scan (GTIN 08966000036901: "2448A0324", once
// the production date above is stripped off). This pharmacy's vendor for
// that product glues a 4-digit sub-code directly in front of the real
// batch with nothing marking the boundary — the physical label's actual
// batch is "A0324", not "2448A0324".
//
// This is deliberately scoped tight — only applied when we ALSO found a
// real embedded production date on this same candidate (hadProductionDate)
// — so it can't touch ordinary batches that happen to start with 4 digits
// followed by a letter but have no production date attached, like
// "0033T212" / "0027T308" / "0006T610", which are confirmed-correct as-is
// and would otherwise match this same shape.
const maybeStripVendorSubcode = (batch, hadProductionDate) => {
  if (!hadProductionDate) return batch;
  const match = batch.match(/^(\d{4})([A-Za-z].*)$/);
  return match ? match[2] : batch;
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
      const { name, retailPrice } = splitNameAndPrice(value);
      if (name) parsed.name = name;
      if (retailPrice) parsed.retailPrice = retailPrice;
    }
    // AI 21 (serial number) isn't used elsewhere in this app — resolving
    // it out of the chain matters so it doesn't get left dangling inside
    // the batch or name, but the value itself doesn't need to be kept.
  }
};

// Shared by both "expiry comes before batch" orderings below (17-then-10,
// and the newer 21-then-17-then-10). In both cases, once expiry has been
// located, what's left must start with the batch marker "10" — this
// pharmacy's generator always puts batch right after expiry in that
// ordering, with an optional 240 name/price blob (and/or a 21 serial)
// chained after it.
const resolveBatchAndTrailing = (afterExpiry) => {
  if (!afterExpiry.startsWith("10")) return null;
  const batchRegion = afterExpiry.slice(2);

  const rsIdx = batchRegion.search(/s?\W*?Rs\s*[.:]?\s*\d/i);
  const preRs = rsIdx >= 0 ? batchRegion.slice(0, rsIdx) : batchRegion;

  // A batch region can ALSO have a genuine AI 21 (serial number) embedded
  // before the 240 name blob — not just after the price at the very end,
  // where parseTrailingChain already handles it. Confirmed against a real
  // scan: "FW0053" + serial "21A28Z2OA1DEFC3A8" + "240Eye Susp", with no
  // separator marking where the serial starts.
  //
  // This has to be told apart from the coincidental "21" case above (e.g.
  // "0033T212", where "21" is just two digits of the batch number). The
  // reliable signal: a genuine embedded serial here always leads into an
  // actual "240" name marker further along — a coincidental "21" that's
  // really just part of the batch digits has no such marker to lead into
  // (the batch is simply the whole remaining region, nothing after it).
  // Confirmed against a real scan, "Tab Abocal" with batch "862151XV" and
  // no name/price suffix at all: without requiring a real "240" here, the
  // coincidental "21" inside "862151XV" got mistaken for a serial start,
  // truncating the batch down to just "86".
  const findGenuineSerialBoundary = (text) => {
    let i = 0;
    while (true) {
      const idx = text.indexOf("21", i);
      if (idx === -1) return -1;
      // A genuine embedded serial always comes AFTER some real batch
      // content — idx === 0 would mean "no batch at all", which doesn't
      // happen. Without this, a batch that simply STARTS with "21" (e.g.
      // "218F48" on a real "NORPLAT 75mg" scan) gets mistaken for having
      // zero-length batch + a serial from character 0, wiping the batch
      // out entirely. Confirmed against that scan.
      if (idx === 0) { i = idx + 1; continue; }
      const after = text.slice(idx + 2);
      const nameIdx = after.indexOf("240");
      if (nameIdx === -1) { i = idx + 1; continue; }
      const span = after.slice(0, nameIdx);
      if (span.length >= 4 && !/[a-z]/.test(span)) return idx;
      i = idx + 1;
    }
  };

  const finalizeBatch = (candidate) => {
    const { batch, hadProductionDate } = stripEmbeddedProductionDate(candidate);
    return maybeStripVendorSubcode(batch, hadProductionDate);
  };

  const serialIdx = findGenuineSerialBoundary(preRs);
  if (serialIdx !== -1) {
    const out = { batch: finalizeBatch(preRs.slice(0, serialIdx).trim()), name: "", retailPrice: "" };
    parseTrailingChain(batchRegion.slice(serialIdx), out);
    return out;
  }

  // Only "240" counts as a batch/name boundary here — NOT "21" (handled
  // above, only when it looks genuine). A coincidental "21" substring
  // inside the batch code itself must not truncate it early — confirmed
  // against a real scan where a batch like "0033T212" contains "21"
  // purely by chance, two characters before the real "240" marker.
  //
  // "240" itself can still appear coincidentally inside a longer numeric
  // batch — a REAL AI 240 marker is always followed by actual
  // product-name text (letters); a coincidental match is followed by more
  // digits (continuing the batch number) or just a trailing "s" artifact —
  // checking for that is what tells them apart reliably.
  const markerMatch = preRs.match(/^(.*?)(240)/);
  const afterMarker = markerMatch ? preRs.slice(markerMatch[1].length + markerMatch[2].length) : "";
  const looksLikeRealName = /[A-Za-z].*[A-Za-z]/.test(afterMarker.replace(/s$/i, ""));

  if (markerMatch && looksLikeRealName) {
    const out = { batch: finalizeBatch(markerMatch[1].trim()), name: "", retailPrice: "" };
    parseTrailingChain(batchRegion.slice(markerMatch[1].length), out);
    return out;
  }

  const rsMatch = batchRegion.match(PRICE_REGEX);
  if (rsMatch) {
    return { batch: finalizeBatch(rsMatch[1].trim()), retailPrice: rsMatch[2], name: "" };
  }

  // No recognizable terminator at all — keep the whole remainder as
  // batch rather than discarding it.
  return { batch: finalizeBatch(batchRegion.trim()), name: "", retailPrice: "" };
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
    // Order: GTIN -> expiry -> batch -> (name/serial chain).
    const resolved = resolveBatchAndTrailing(rest.slice(expPos + 8));
    if (!resolved) return result;
    result.gtin = gtin;
    result.expiry = expiry;
    result.batch = resolved.batch;
    if (resolved.name) result.name = resolved.name;
    if (resolved.retailPrice) result.retailPrice = resolved.retailPrice;
    return result;
  }

  if (rest.startsWith("11") && expPos === 8) {
    // Order: GTIN -> production date(11) -> expiry(17) -> batch(10) ->
    // (name/serial chain). Same AI order (11, 17, 10, 240) already
    // supported above in parenthesized form, e.g.
    // "(01)...(11)251210(17)271130(10)F3973(240)MRP RS.96.50" — this is
    // that identical order with no separators at all. Confirmed against
    // seven real scans, all "...240MRP RS.xxx.xx"-suffixed, e.g.
    // "112601281728123110F5013240MRP RS.280.00" -> prod-date 2026-01-28,
    // expiry 2028-12-31, batch F5013, price 280.00. The "expPos === 8"
    // check (production date is always exactly "11"+6 digits = 8 chars)
    // is what distinguishes this from a coincidental "17"+valid-date
    // showing up elsewhere by chance.
    const resolved = resolveBatchAndTrailing(rest.slice(expPos + 8));
    if (!resolved) return result;
    result.gtin = gtin;
    result.expiry = expiry;
    result.batch = resolved.batch;
    if (resolved.name) result.name = resolved.name;
    if (resolved.retailPrice) result.retailPrice = resolved.retailPrice;
    return result;
  }

  if (rest.startsWith("10")) {
    // Order: GTIN -> batch -> expiry -> (serial/name chain).
    result.gtin = gtin;
    result.expiry = expiry;
    const { batch, hadProductionDate } = stripEmbeddedProductionDate(rest.slice(2, expPos).trim());
    result.batch = maybeStripVendorSubcode(batch, hadProductionDate);
    parseTrailingChain(rest.slice(expPos + 8), result);
    return result;
  }

  if (rest.startsWith("21")) {
    // Order: GTIN -> serial(21, fixed 14 chars) -> batch(10) -> production
    // date(11) -> expiry(17) -> optionally a name/price chain(240/21).
    // Distinct from the "serial ahead of expiry/batch" ordering below:
    // here batch comes BEFORE expiry, with a production date sandwiched
    // between them, and the serial is always exactly 14 characters wide
    // before "10" begins. Confirmed against six real scans ending right
    // after expiry with nothing further, e.g.
    // "21Y79X4M7T6705W910MG0441126051917280518" -> 14-char serial + batch
    // "MG044" + prod-date 260519 + expiry 280518 (2028-05) — and a
    // seventh with a name/price blob still attached after expiry, e.g.
    // "21PLCMERG1KB8L40100451126060017280500240Osso-Dsusp120ml1s.Rs.550.00"
    // -> serial + batch "045" + prod-date 260600 + expiry 280500
    // (2028-05) + "240Osso-Dsusp120ml1s.Rs.550.00". Tried first (more
    // specific) before the looser "21 ahead of everything" shape further
    // down.
    const afterSerial = rest.slice(2 + 14);
    const fixedOrderMatch = afterSerial.startsWith("10")
      ? afterSerial.slice(2).match(/^(.*?)11(\d{6})17(\d{6})(.*)$/)
      : null;
    if (fixedOrderMatch) {
      const [, fixedBatch, , fixedExpiryDigits, fixedTrailing] = fixedOrderMatch;
      if (fixedBatch && isValidYYMMDD(fixedExpiryDigits)) {
        const fixedYear = 2000 + parseInt(fixedExpiryDigits.slice(0, 2), 10);
        result.gtin = gtin;
        result.batch = fixedBatch;
        result.expiry = `${fixedYear}-${fixedExpiryDigits.slice(2, 4)}`;
        if (fixedTrailing) parseTrailingChain(fixedTrailing, result);
        return result;
      }
    }

    // Order: GTIN -> serial(21) -> expiry -> batch -> (name/serial chain).
    // Reverse-engineered from real scans (this pharmacy's generator
    // sometimes puts the serial number ahead of expiry/batch instead of
    // after them) that previously parsed correctly under an older parser
    // version but fall through as "no recognized shape" here without this
    // branch. AI 21 has no separator and no fixed length to bound it, so —
    // same as everywhere else in this fallback — the verified expiry
    // position (not a length guess) is what tells us where the serial
    // actually ends.
    const resolved = resolveBatchAndTrailing(rest.slice(expPos + 8));
    if (!resolved) return result;
    result.gtin = gtin;
    result.expiry = expiry;
    result.batch = resolved.batch;
    if (resolved.name) result.name = resolved.name;
    if (resolved.retailPrice) result.retailPrice = resolved.retailPrice;
    return result;
  }

  return result; // doesn't fit any recognized shape — don't guess
};

// =========================================================================
// GTIN-LESS SCANS (secondary/supplementary label barcodes)
// =========================================================================
// Some of this pharmacy's items carry a SECOND barcode on the pack that
// encodes only expiry + batch + price/name — no GTIN (AI 01) at all —
// because the GTIN is already on a separate primary barcode elsewhere on
// the box. Reverse-engineered from real scans of this exact shape: always
// starts directly with AI 17 (expiry), then AI 10 (batch), then the usual
// 240/21 trailing chain — e.g. raw "172804171011166240PurpalCaps20mg14sRs:280.00"
// decodes as expiry 2028-04, batch "11166", name "PurpalCaps20mg14s", price
// 280.00. Scoped to exactly that one confirmed ordering — unlike the
// GTIN-bearing fallback above, there's no observed "batch-before-expiry,
// no GTIN" scan from this pharmacy to build a second branch from, so that
// shape isn't guessed at here.
const parseNoGtinTrailingOnly = (sanitized) => {
  const result = { gtin: null, batch: null, expiry: null, name: "", retailPrice: "" };
  if (!sanitized.startsWith("17")) return result;

  const expiryDigits = sanitized.slice(2, 8);
  if (!isValidYYMMDD(expiryDigits)) return result;

  const resolved = resolveBatchAndTrailing(sanitized.slice(8));
  if (!resolved) return result;

  const year = 2000 + parseInt(expiryDigits.slice(0, 2), 10);
  result.expiry = `${year}-${expiryDigits.slice(2, 4)}`;
  result.batch = resolved.batch;
  if (resolved.name) result.name = resolved.name;
  if (resolved.retailPrice) result.retailPrice = resolved.retailPrice;
  return result;
};

// =========================================================================
// PARENTHESIZED (HUMAN-READABLE) AI FORMAT
// =========================================================================
// Some scanners/printers emit GS1 data in its human-readable form instead
// of FNC1-separated: every AI wrapped in literal parentheses OR square
// brackets, e.g. "08964001855514(10)729E(17)310128(21)1457582534" or
// "08964001857648[10]708E[17]300927[21]1444230235" (confirmed both styles
// show up from this pharmacy's hardware — same data, different wrapper
// character). Unlike every other pattern this file handles, the GTIN
// itself isn't prefixed with "(01)"/"[01]" — it's just the bare 14 digits
// up front, with every AI after it wrapped. That bare-digit start is
// exactly why this was getting raw-scanned: it fails the "starts with 01"
// plain-barcode check further down, so without this, it looked identical
// to a non-GS1 EAN/UPC.
const parseParenthesizedFormat = (sanitized) => {
  if (!sanitized.includes("(") && !sanitized.includes("[")) return null;

  const gtinMatch = sanitized.match(/^(?:[(\[]01[)\]])?(\d{14})/);
  // Some of this pharmacy's items carry a SECOND barcode with no GTIN
  // segment at all — e.g. "(17)290504(10)31708(240)BryskTab20mg20sRs:448.00" —
  // because the GTIN is already on a separate primary barcode elsewhere on
  // the pack. When there's no leading GTIN, just start scanning AI segments
  // from the beginning instead of failing the whole line.
  const result = { gtin: gtinMatch ? gtinMatch[1] : null, batch: null, expiry: null, name: "", retailPrice: "" };
  const remaining = gtinMatch ? sanitized.slice(gtinMatch[0].length) : sanitized;

  const segmentRegex = /[(\[](\d{2,3})[)\]]([^(\[]*)/g;
  let match;
  let foundAny = false;
  while ((match = segmentRegex.exec(remaining)) !== null) {
    foundAny = true;
    const ai = match[1];
    const value = match[2].trim();

    if (ai === "10") {
      result.batch = value;
    } else if (ai === "17" && isValidYYMMDD(value)) {
      const year = 2000 + parseInt(value.slice(0, 2), 10);
      result.expiry = `${year}-${value.slice(2, 4)}`;
    } else if (ai === "240") {
      const { name, retailPrice } = splitNameAndPrice(value);
      if (name) result.name = name;
      if (retailPrice) result.retailPrice = retailPrice;
    }
    // AI 11 (production date), AI 21 (serial), and anything else: not
    // surfaced elsewhere in this app — parsed only so they don't get
    // mistaken for one of the fields above, value itself is discarded.
  }

  return foundAny ? result : null;
};

// =========================================================================
// SLASH-FORMATTED DATES (a distinct, non-standard variant)
// =========================================================================
// Standard GS1 AI 11/17 values are exactly 6 digits (YYMMDD), no
// separators. At least one manufacturer's barcode generator instead
// prints the date as literal DD/MM/YYYY. Confirmed against one real scan:
// "01" + GTIN + "17" + "30/09/2027" + "10" + batch + "11" + a second
// slash-date (production date) + "240" + name/price — e.g.
// "01089640015631811730/09/20271025802051131/10/2025240Cefia400mgCaps5sRs564.00"
// decodes as expiry 2027-09, batch "2580205", price 564.00. Only one
// example so far, but the literal slashes make the AI boundaries
// unambiguous even from a single scan — there's no other way to read
// "30/09/2027" as anything but a date, so this doesn't carry the same
// "might be a coincidence" risk that the plain-digit patterns above do.
const parseSlashDateFormat = (sanitized) => {
  const match = sanitized.match(
    /^01(\d{14})17(\d{2})\/(\d{2})\/(\d{4})10(.*?)11\d{2}\/\d{2}\/\d{4}(240.*)?$/
  );
  if (!match) return null;

  const [, gtin, dd, mm, yyyy, batch, trailing] = match;
  if (!batch) return null;

  const result = { gtin, batch, expiry: `${yyyy}-${mm}`, name: "", retailPrice: "" };
  if (trailing) parseTrailingChain(trailing, result);
  return result;
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

  const slashDated = parseSlashDateFormat(sanitized);
  if (slashDated && slashDated.batch && slashDated.expiry) {
    parsed.gtin = slashDated.gtin;
    parsed.batch = slashDated.batch;
    parsed.expiry = slashDated.expiry;
    if (slashDated.name) parsed.name = slashDated.name;
    if (slashDated.retailPrice) parsed.retailPrice = slashDated.retailPrice;
    return parsed;
  }

  const parenthesized = parseParenthesizedFormat(sanitized);
  if (parenthesized && parenthesized.batch && parenthesized.expiry) {
    // No real GTIN on this scan (see parseParenthesizedFormat) — the full
    // raw string is what gets stored/matched as this item's identifying
    // barcode instead, same convention used everywhere else in this file.
    parsed.gtin = parenthesized.gtin || sanitized;
    parsed.batch = parenthesized.batch;
    parsed.expiry = parenthesized.expiry;
    if (parenthesized.name) parsed.name = parenthesized.name;
    if (parenthesized.retailPrice) parsed.retailPrice = parenthesized.retailPrice;
    return parsed;
  }

  // GTIN-less, non-parenthesized structured scan — same "no GTIN on this
  // label" situation as above, just without the parentheses. See
  // parseNoGtinTrailingOnly for the confirmed shape this covers.
  if (!sanitized.startsWith("01")) {
    const noGtin = parseNoGtinTrailingOnly(sanitized);
    if (noGtin.batch && noGtin.expiry) {
      parsed.gtin = sanitized;
      parsed.batch = noGtin.batch;
      parsed.expiry = noGtin.expiry;
      if (noGtin.name) parsed.name = noGtin.name;
      if (noGtin.retailPrice) parsed.retailPrice = noGtin.retailPrice;
      return parsed;
    }
  }

  // Not every product barcode is full GS1-128 — some are plain EAN/UPC. In
  // that case there's no structure to decode; the raw scan itself IS the
  // identifying code, same as before.
  if (!sanitized.startsWith("01") || sanitized.length < 16) {
    parsed.gtin = sanitized;
    return parsed;
  }

  // Whether this scan has a REAL GS1 field separator anywhere in it is
  // the deciding factor for whether the third-party library can be
  // trusted at all here — not just whether it happens to throw. A GS1-128
  // decoder resolves variable-length field boundaries (like batch) from
  // that separator; with none present, there's no spec-defined way for it
  // to know where batch ends, so whatever it does in that situation is
  // undocumented and unreliable rather than a real "success" — confirmed
  // against real scans where the library returned a plausible-looking but
  // WRONG batch/expiry (passing the structuredOk check below) for input
  // that has no separator anywhere, instead of throwing as expected. This
  // pharmacy has a large, well-understood population of exactly these
  // no-separator scans (that's what parseNoSeparatorFallback exists for),
  // so for those we skip the library entirely rather than gamble on
  // whatever it does with input outside its spec-defined scope.
  const hasRealSeparator = sanitized.includes(GS);

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

  if (hasRealSeparator) {
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
    const { name: extraName, retailPrice: extraPrice } = splitNameAndPrice(extraText);
    if (extraName) parsed.name = extraName;
    if (extraPrice) parsed.retailPrice = extraPrice;

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
      const batchPriceMatch = parsed.batch.match(PRICE_REGEX);
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

// =========================================================================
// LEGACY-DATA LOOKUP COMPATIBILITY
// =========================================================================
// Fixing the parser (above) only helps going forward. It does nothing for
// the ~99 existing inventory rows whose `barcode` column already holds a
// full raw/junk scan string, saved back when an earlier version of this
// parser failed on that scan and (per parsePharmacyBarcode's own fallback
// behavior) stored the raw text as if it were the identifying code. Once
// the parser is fixed, scanning that SAME product produces the correct
// clean GTIN — which no longer matches that stored raw row, so a scan now
// fails to find it even though nothing about the physical barcode changed.
//
// This isn't something parsePharmacyBarcode itself can fix — it only
// resolves what the scan *means*, not what's sitting in the database. Any
// screen that matches a scan against `inventory.barcode` needs to try more
// than one candidate string before giving up. getBarcodeLookupCandidates
// below returns that list, ordered clean-GTIN-first (the correct,
// going-forward match), then progressively less-cleaned forms of the same
// scan, on the chance an older row still has one of those stored verbatim.
//
// Wired into all three barcode-driven screens:
//   - Sales (App.jsx's handleGlobalBarcodeScan) — tries each candidate
//     against getProductsByBarcode in turn until one hits.
//   - Inventory / Stock Management (StockManagement.jsx) — matches the
//     in-memory inventory list against every candidate, not just the
//     clean GTIN.
//   - Restock (RestockScreen.jsx) — same.
// In all three, once a legacy row is matched via an old candidate, any
// NEW batch/product saved from that point on is written back out with
// the clean GTIN (not the old junk string) — so touching a legacy item
// through any of these screens self-heals its barcode going forward.
export const getBarcodeLookupCandidates = (scan) => {
  const parsed = parsePharmacyBarcode(scan);
  const sanitized = sanitizeScannerPayload(scan);
  const original = (scan || "").trim();

  const candidates = [parsed.gtin, sanitized, original].filter(Boolean);
  return [...new Set(candidates)];
};

// A canonical, known-good test scan — useful for a quick sanity check
// after any change to this file, without needing physical scanner
// hardware on hand.
export const SAMPLE_GS1_TEST_SCAN = `010123456789012317260101${GS}10ABC123${GS}240Panadol ExtraRs100`;