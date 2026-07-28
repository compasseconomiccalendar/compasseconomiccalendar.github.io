/**
 * Tests for the event detail view's field selection.
 *
 * The feed attaches different extras depending on the source, so the point of
 * these is that a field only appears when it applies and is never rendered
 * blank.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  detailRows,
  formatTimes,
  typeLabel,
  typicalMoveBadge,
  typicalMoveDetail,
} from "../src/details.js";

const labelsOf = (event) => detailRows(event).map((row) => row.label);
const valueOf = (event, label) =>
  detailRows(event).find((row) => row.label === label)?.value;

const base = {
  id: "x",
  event_type: "macro_release_cpi",
  title: "CPI",
  start_utc: "2026-09-16T18:00:00Z",
  date_et: "2026-09-16",
  all_day: false,
  market_impact: "high",
  source_url: "https://example.gov",
  note: "note",
};

test("typeLabel names known types and degrades gracefully", () => {
  assert.equal(typeLabel("fomc_statement"), "FOMC statement");
  assert.equal(typeLabel("quad_witching"), "Quad witching");
  assert.equal(typeLabel("macro_release_gdp"), "Macro release");
  assert.equal(typeLabel("brand_new_type"), "brand new type");
});

test("a minimal event yields only the universal rows", () => {
  assert.deepEqual(labelsOf(base), ["Type", "Impact"]);
  assert.equal(valueOf(base, "Impact"), "High");
});

test("empty and false extras are omitted, not rendered blank", () => {
  const event = {
    ...base,
    cusip: "",
    security_term: "",
    bea_release_title: null,
    has_sep: false,
    holiday_adjusted: false,
    computed: false,
    part_of_quarterly_refunding: false,
  };
  assert.deepEqual(labelsOf(event), ["Type", "Impact"]);
});

test("an FOMC statement surfaces meeting span and SEP", () => {
  const event = {
    ...base,
    event_type: "fomc_statement",
    meeting_start_date: "2026-09-15",
    meeting_end_date: "2026-09-16",
    has_sep: true,
  };
  assert.equal(valueOf(event, "Meeting"), "2026-09-15 to 2026-09-16");
  assert.equal(valueOf(event, "Projections"), "Includes the SEP dot plot");
});

test("a one-day meeting is not rendered as a range", () => {
  const event = {
    ...base,
    meeting_start_date: "2026-09-16",
    meeting_end_date: "2026-09-16",
  };
  assert.equal(valueOf(event, "Meeting"), "2026-09-16");
});

test("an unconfirmed press conference says so", () => {
  const confirmed = { ...base, confirmed: true };
  const pending = { ...base, confirmed: false };
  assert.equal(valueOf(confirmed, "Status"), undefined);
  assert.equal(
    valueOf(pending, "Status"),
    "Not yet confirmed on the Fed's calendar",
  );
});

test("GDP variants are explained, not just labelled", () => {
  const advance = { ...base, event_type: "macro_release_gdp", release_variant: "advance" };
  const third = { ...base, event_type: "macro_release_gdp", release_variant: "third" };
  assert.match(valueOf(advance, "GDP estimate"), /market-moving/);
  assert.match(valueOf(third, "GDP estimate"), /rarely moves/);
});

test("a futures event lists its contract and symbols", () => {
  const event = {
    ...base,
    event_type: "futures_expiration",
    contract_code: "U6",
    symbols: ["ES", "NQ", "MES", "MNQ"],
    computed: true,
    holiday_adjusted: true,
  };
  assert.equal(valueOf(event, "Contract"), "U6 (/ES, /NQ, /MES, /MNQ)");
  assert.equal(valueOf(event, "Holiday"), "Shifted earlier for a market holiday");
  assert.equal(valueOf(event, "Derivation"), "Computed from published rules");
});

test("a Treasury auction lists security, CUSIP and refunding flag", () => {
  const event = {
    ...base,
    event_type: "treasury_auction",
    security_term: "10-Year",
    security_type: "Note",
    cusip: "91282CRC7",
    announcement_date: "2026-07-23",
    part_of_quarterly_refunding: true,
  };
  assert.equal(valueOf(event, "Security"), "10-Year Note");
  assert.equal(valueOf(event, "CUSIP"), "91282CRC7");
  assert.equal(valueOf(event, "Refunding"), "Part of the quarterly refunding cycle");
});

test("formatTimes always includes Eastern for verification", () => {
  // 18:00Z is 2pm EDT and noon MDT.
  const rows = formatTimes(base, "America/Denver");
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));
  assert.match(byLabel["Your time"], /12:00 PM/);
  assert.match(byLabel["Eastern"], /2:00 PM EDT/);
  assert.match(byLabel["UTC"], /6:00 PM UTC/);
});

test("formatTimes does not repeat Eastern when it is already your zone", () => {
  const labels = formatTimes(base, "America/New_York").map((row) => row.label);
  assert.deepEqual(labels, ["Your time", "UTC"]);
});

test("an all-day event shows a date, not a time", () => {
  const event = { ...base, all_day: true, start_utc: "2026-09-15T00:00:00Z" };
  assert.deepEqual(formatTimes(event, "UTC"), [
    { label: "Date", value: "2026-09-16" },
  ]);
});

test("formatTimes tolerates an unparseable timestamp", () => {
  assert.deepEqual(formatTimes({ ...base, start_utc: "nonsense" }, "UTC"), []);
});

test("typicalMoveBadge only fires for clearly unusual days", () => {
  const notable = { ...base, typical_move: { ratio: 1.69, notable: true } };
  const quiet = { ...base, typical_move: { ratio: 0.82, notable: true } };
  const ordinary = { ...base, typical_move: { ratio: 1.04, notable: false } };

  assert.equal(typicalMoveBadge(notable), "1.7× normal");
  assert.equal(typicalMoveBadge(quiet), "quieter than normal");
  // The whole point: an ordinary day gets no badge rather than "1.0× normal".
  assert.equal(typicalMoveBadge(ordinary), null);
  assert.equal(typicalMoveBadge(base), null);
});

test("typicalMoveDetail always reports sample size", () => {
  const event = {
    ...base,
    typical_move: {
      ratio: 1.69, notable: true, window: "recent", sample_start: "2023-07-29",
      summary: "Historically moves about 1.7x as much as a normal day.",
      spx: { median_abs_pct: 0.65, ratio: 1.69, n: 34 },
      ndx: { median_abs_pct: 1.06, ratio: 1.74, n: 34 },
    },
  };
  const detail = typicalMoveDetail(event);
  assert.equal(detail.notable, true);
  assert.match(detail.headline, /1\.7x/);
  assert.deepEqual(detail.rows.map((row) => row.label), ["S&P 500", "Nasdaq 100"]);
  // A ratio without an n invites over-reading a tiny sample.
  for (const row of detail.rows) assert.match(row.value, /n=34/);
  assert.match(detail.window, /Recent window since 2023-07-29/);
});

test("typicalMoveDetail handles a single index and the full-sample fallback", () => {
  const event = {
    ...base,
    typical_move: {
      ratio: 1.0, notable: false, window: "full", sample_start: "2016-07-28",
      summary: "Historically moves about as much as a normal day.",
      spx: { median_abs_pct: 0.49, ratio: 1.0, n: 39 },
      ndx: null,
    },
  };
  const detail = typicalMoveDetail(event);
  assert.equal(detail.rows.length, 1);
  assert.equal(detail.notable, false);
  assert.match(detail.window, /Full sample since 2016-07-28/);
  assert.equal(typicalMoveDetail(base), null);
});
