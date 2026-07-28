/**
 * Presentation logic for the event detail view.
 *
 * Pure functions over an event record, so the field selection can be tested
 * without a DOM. The feed carries source-specific extras (CUSIP, contract
 * code, GDP variant, ...) that only apply to some event types; these decide
 * which of them are worth showing and how to word them.
 */

const TYPE_LABELS = {
  fomc_statement: "FOMC statement",
  fomc_press_conference: "FOMC press conference",
  fomc_sep: "FOMC projections",
  fomc_minutes: "FOMC minutes",
  fomc_meeting_day_1: "FOMC meeting, day 1",
  treasury_auction: "Treasury auction",
  treasury_quarterly_refunding: "Quarterly refunding",
  futures_liquidity_roll: "Futures liquidity roll",
  futures_official_roll: "CME official roll",
  futures_expiration: "Futures expiration",
  quad_witching: "Quad witching",
  monthly_opex: "Monthly options expiration",
};

const GDP_VARIANT_LABELS = {
  advance: "Advance estimate — the market-moving print",
  second: "Second estimate — usually a small revision",
  third: "Third estimate — rarely moves futures",
};

export function typeLabel(eventType) {
  if (TYPE_LABELS[eventType]) return TYPE_LABELS[eventType];
  if (eventType.startsWith("macro_release_")) return "Macro release";
  return eventType.replace(/_/g, " ");
}

/**
 * The metadata rows worth showing for this event, in display order.
 * Absent fields are omitted rather than rendered blank.
 */
export function detailRows(event) {
  const rows = [];
  const push = (label, value) => {
    if (value !== undefined && value !== null && value !== "") {
      rows.push({ label, value: String(value) });
    }
  };

  push("Type", typeLabel(event.event_type));
  push(
    "Impact",
    event.market_impact
      ? event.market_impact[0].toUpperCase() + event.market_impact.slice(1)
      : null,
  );

  if (event.meeting_start_date && event.meeting_end_date) {
    push(
      "Meeting",
      event.meeting_start_date === event.meeting_end_date
        ? event.meeting_start_date
        : `${event.meeting_start_date} to ${event.meeting_end_date}`,
    );
  }
  if (event.has_sep) push("Projections", "Includes the SEP dot plot");
  if (event.confirmed === false) {
    push("Status", "Not yet confirmed on the Fed's calendar");
  }

  if (event.release_variant) {
    push("GDP estimate", GDP_VARIANT_LABELS[event.release_variant] ?? event.release_variant);
  }
  push("BEA listing", event.bea_release_title);
  push("FRED release", event.fred_release_id ? `ID ${event.fred_release_id}` : null);

  if (event.security_term || event.security_type) {
    push("Security", `${event.security_term ?? ""} ${event.security_type ?? ""}`.trim());
  }
  push("CUSIP", event.cusip);
  push("Announced", event.announcement_date);
  if (event.part_of_quarterly_refunding) {
    push("Refunding", "Part of the quarterly refunding cycle");
  }

  if (event.contract_code) {
    const symbols = (event.symbols ?? []).map((symbol) => `/${symbol}`).join(", ");
    push("Contract", symbols ? `${event.contract_code} (${symbols})` : event.contract_code);
  }
  if (event.holiday_adjusted) {
    push("Holiday", "Shifted earlier for a market holiday");
  }

  if (event.computed) push("Derivation", "Computed from published rules");
  if (event.manually_overridden) {
    push("Correction", "Manually corrected against the official source");
  }

  return rows;
}

/**
 * A short badge for the list, or null.
 *
 * Only shown when the event day is clearly different from an ordinary day.
 * Most event types sit within noise of 1.0x, and stamping "1.02x normal" on
 * everything would be noise presented as insight.
 */
export function typicalMoveBadge(event) {
  const move = event.typical_move;
  if (!move?.notable || typeof move.ratio !== "number") return null;
  return move.ratio >= 1
    ? `${move.ratio.toFixed(1)}× normal`
    : "quieter than normal";
}

/**
 * The detail-view block: headline, per-index medians with sample sizes, and
 * the window the figures were computed over.
 *
 * Sample size is always shown. A ratio without an `n` invites a confident
 * reading of very little data.
 */
export function typicalMoveDetail(event) {
  const move = event.typical_move;
  if (!move) return null;

  const rows = [];
  for (const [key, label] of [["spx", "S&P 500"], ["ndx", "Nasdaq 100"]]) {
    const stats = move[key];
    if (!stats) continue;
    rows.push({
      label,
      value: `${stats.median_abs_pct.toFixed(2)}% median move (n=${stats.n})`,
    });
  }

  const since = move.sample_start ? ` since ${move.sample_start}` : "";
  return {
    headline: move.summary,
    notable: Boolean(move.notable),
    rows,
    window: `${move.window === "recent" ? "Recent window" : "Full sample"}${since}`,
  };
}

/**
 * The same instant rendered three ways: the viewer's chosen zone, Eastern
 * (how the agency announces it), and UTC (what the feed stores). A trader
 * verifying against an official page needs the Eastern one.
 */
export function formatTimes(event, timeZone) {
  const start = new Date(event.start_utc);
  if (Number.isNaN(start.getTime())) return [];

  if (event.all_day) {
    return [{ label: "Date", value: event.date_et ?? event.start_utc.slice(0, 10) }];
  }

  const render = (zone, label) => ({
    label,
    value: new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(start),
  });

  const rows = [render(timeZone, "Your time")];
  const eastern = render("America/New_York", "Eastern");
  if (eastern.value !== rows[0].value) rows.push(eastern);
  rows.push(render("UTC", "UTC"));
  return rows;
}
