/**
 * Jev screening layer for seller-finance multifamily leads (via Vercel AI Gateway).
 * Claude (retrieval) -> this script (deterministic gates + Jev judgment + scoring) -> Claude (skeptic pass + report).
 * Jev handles the fuzzy reads of listing text; code handles all arithmetic, dates, and thresholds.
 *
 * Quality model: a lead must be OPEN TO SELLER FINANCING. Quality then comes from three signals,
 * ideally all together: (1) clear, express seller-finance openness, (2) seller motivation, (3) time on market.
 * Listings that also welcome cash or conventional offers are NOT penalized — only an explicit refusal of
 * seller financing disqualifies on financing grounds.
 *
 * Usage: node --env-file=.env.local jev-screen.ts <candidates.json> <results.json> [--mock]
 * Auth: AI_GATEWAY_API_KEY in .env.local (never printed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { experimental_evaluate as evaluate } from "ai";

const MODEL = "typesafe-ai/jev";

type Candidate = {
  id?: string; address?: string; url?: string; platform?: string;
  units?: number; price?: number; market_tier?: string;
  list_date?: string | null; dom?: number | null; price_reductions?: number;
  status_on_page?: string; gross_rent_monthly?: number | null; rent_source?: string;
  noi_annual?: number | null; cap_rate_stated?: number | null; expense_ratio?: number | null;
  year_built?: number | null; description?: string; financing_fields?: string;
  verified_fields?: string[];
};

type Answers = {
  sf_signal: { choice: string; confidence: number; probabilities: Record<string, number> };
  seller_is_lender: number; cash_or_conventional_welcome: number; listing_active: number;
  distressed_sale: number; new_construction: number; commercial_majority: number;
  motivation: number; condition: number; occupancy: number; free_and_clear: number; red_flags: number;
};

const bool = (instructions: string) => ({ type: "boolean" as const, instructions });

const QUESTIONS = {
  sf_signal: {
    type: "choice" as const,
    instructions:
      "Considering ALL financing language in the listing, what is the STRONGEST statement it makes about the SELLER/OWNER personally financing the purchase (seller financing, owner will carry, OWC, seller carry, owner terms, contract for deed, land contract, wrap)? A listing that prefers or accepts cash or conventional offers but ALSO offers or will consider seller financing counts as offering or considering it. Financing from a bank, lender, or 'preferred lender' is NOT seller financing.",
    criteria: {
      explicit_with_terms: "Seller financing is clearly offered AND at least one term is stated (down payment, interest rate, amortization, or balloon), even if cash or conventional offers are also welcome",
      explicit_no_terms: "Seller financing is clearly offered but no specific terms are stated, even if cash or conventional offers are also welcome",
      open_to_consider: "The seller will consider, entertain, or is open to seller financing or creative terms, without committing, even if cash or conventional offers are also welcome",
      assumable_only: "The only creative option mentioned is assuming the seller's existing loan",
      refused: "The listing explicitly states the seller will NOT provide or consider seller financing",
      none: "The listing contains no seller-financing language at all (it may mention cash, conventional, FHA, VA, SBA, or lender financing, or not discuss financing)",
    },
  },
  seller_is_lender: bool("The listing states that the seller or owner (not a bank, lender, or mortgage company) would provide or consider providing financing to the buyer"),
  cash_or_conventional_welcome: bool("The listing mentions that cash offers or conventional/bank-financed offers are welcome or preferred"),
  listing_active: bool("The listing text and status field indicate the property is still actively for sale, and it is NOT pending, contingent, under contract, sold, off market, coming soon, or accepting backup offers"),
  distressed_sale: bool("The sale is an auction, foreclosure, REO, bank-owned, or short sale"),
  new_construction: bool("The property is new construction or has not yet been built"),
  commercial_majority: bool("The property is mixed-use and commercial or retail space produces the majority of its income"),
  motivation: {
    type: "score" as const,
    instructions: "How motivated the seller appears to be, based only on the listing text",
    criteria: [
      "No motivation signals",
      "Mild: price improved or reduced, or 'priced to sell'",
      "Clear: 'motivated seller', 'bring all offers', 'make an offer', 'must sell', or multiple price reductions",
      "Strong: a personal reason to sell (retiring, estate, relocating, health, tired landlord, portfolio consolidation) combined with urgency or flexibility on price or terms",
    ],
  },
  condition: {
    type: "score" as const,
    instructions: "Physical condition of the property as described in the listing",
    criteria: [
      "Turnkey or recently renovated, no work needed",
      "Well maintained, only cosmetic updates suggested",
      "Some deferred maintenance or dated units",
      "Significant repairs needed (roof, systems, several units)",
      "Heavy rehab, gut renovation, or uninhabitable units",
    ],
  },
  occupancy: {
    type: "score" as const,
    instructions: "How occupied or stabilized the property is according to the listing",
    criteria: ["Vacant or mostly vacant", "Partially occupied", "Mostly occupied", "Fully occupied or described as stabilized"],
  },
  free_and_clear: bool("The listing states or strongly implies the owner has no mortgage (free and clear, owned outright, long-time owner since decades ago)"),
  red_flags: bool("The listing mentions a material problem: code violations, foundation or structural issues, fire or water damage, flood zone concerns, tenant disputes or evictions, or insurance problems"),
};

const SF_QUALIFYING = ["explicit_with_terms", "explicit_no_terms", "open_to_consider"];
const sfOpenProb = (a: { sf_signal: { probabilities: Record<string, number> } }) =>
  SF_QUALIFYING.reduce((t, k) => t + (a.sf_signal.probabilities[k] ?? 0), 0);

// ---------- deterministic helpers (never ask Jev to do math or dates) ----------
const today = new Date(new Date().toISOString().slice(0, 10));

function domOf(c: Candidate): number | null {
  if (c.list_date) {
    const d = new Date(c.list_date);
    if (!isNaN(d.getTime())) return Math.round((today.getTime() - d.getTime()) / 86_400_000);
  }
  return c.dom ?? null;
}

function capRateOf(c: Candidate): [number | null, string] {
  if (c.cap_rate_stated) return [Number(c.cap_rate_stated), "stated"];
  if (c.noi_annual && c.price) return [(100 * c.noi_annual) / c.price, "stated NOI"];
  if (c.gross_rent_monthly && c.price) {
    const er = c.expense_ratio ?? ((c.units ?? 0) <= 4 ? 0.425 : 0.475);
    return [(100 * c.gross_rent_monthly * 12 * (1 - er)) / c.price, `est. ${Math.round(er * 100)}% expenses on ${c.rent_source ?? "?"} rents`];
  }
  return [null, "unknown"];
}

// Hard gates are only the non-negotiables. DOM is NOT a gate: it is a quality signal (see score/route).
function hardGates(c: Candidate): string[] {
  const fails: string[] = [];
  const u = c.units ?? 0;
  if (u < 2) fails.push("G1 units");
  if ((c.market_tier ?? "").toLowerCase() === "primary") fails.push("G2 primary market");
  if ((c.price ?? 0) < 400_000) fails.push("G3 price < $400K");
  const [cap] = capRateOf(c);
  if (cap === null || cap < 6) fails.push("G7 cap < 6%");
  return fails;
}

// ---------- signals ----------
function signals(c: Candidate, a: Answers) {
  const d = domOf(c);
  // Gate on P(open to seller financing at all) = sum over qualifying tiers, so a split between
  // "explicit" and "will consider" never blocks a lead; the tier only affects points.
  const sfClear = SF_QUALIFYING.includes(a.sf_signal.choice) && sfOpenProb(a) >= 0.6 && a.seller_is_lender >= 0.7;
  const motivated = a.motivation >= 1.5 || (c.price_reductions ?? 0) >= 2;
  const longDom = d !== null && d >= 60;
  return { sfClear, motivated, longDom, dom: d, count: [sfClear, motivated, longDom].filter(Boolean).length };
}

// ---------- scoring (weights live in code, so re-weighting is a code change) ----------
const SF_POINTS: Record<string, number> = { explicit_with_terms: 30, explicit_no_terms: 26, open_to_consider: 22, assumable_only: 8 };
const r1 = (n: number) => Math.round(n * 10) / 10;

function score(c: Candidate, a: Answers) {
  const s = signals(c, a);
  // 1) Seller-finance openness (30)
  const sf = SF_POINTS[a.sf_signal.choice] ?? 0;
  // 2) Seller motivation (20): Jev motivation score (0–3) + price-reduction evidence
  const mot = Math.min(20, (a.motivation / 3) * 16 + Math.min(c.price_reductions ?? 0, 2) * 2);
  // 3) Time on market (20)
  const d = s.dom ?? 0;
  const dom = s.dom === null ? 0 : d < 30 ? 0 : d < 60 ? 4 : d < 90 ? 10 : d < 180 ? 15 : 20;
  // Cash flow (15)
  const [cap, method] = capRateOf(c);
  let cf = cap === null ? 0 : cap < 7 ? 6 : cap < 8 ? 11 : 15;
  if (method.startsWith("est.") && c.rent_source !== "rent_roll") cf = Math.max(cf - 3, 0);
  // Equity / carry capacity (5)
  let eq = 5 * a.free_and_clear;
  if (a.sf_signal.choice === "assumable_only" || (c.financing_fields ?? "").toLowerCase().includes("assum")) eq = Math.max(eq, 3);
  // Asset quality (5)
  const aq = Math.min(5, Math.max(0, 5 * (1 - a.condition / 4) * (0.5 + a.occupancy / 6) - 2.5 * a.red_flags));
  // Data confidence (5)
  const verified = new Set(c.verified_fields ?? []);
  const hits = ["price", "units", "dom", "rent", "status"].filter((f) => verified.has(f)).length;
  const dc = hits === 5 ? 5 : hits >= 3 ? 2 : 0;
  // Combination bonus: all three quality signals together
  const combo = s.count === 3 ? 5 : 0;

  const total = Math.min(100, r1(sf + mot + dom + cf + eq + aq + dc + combo));
  return {
    total, signals: s,
    breakdown: { seller_finance: sf, motivation: r1(mot), time_on_market: dom, cash_flow: cf, equity_carry: r1(eq), asset_quality: r1(aq), data_confidence: dc, triple_signal_bonus: combo },
    cap: cap === null ? null : Math.round(cap * 100) / 100, method,
  };
}

// ---------- routing with per-decision confidence thresholds ----------
function route(c: Candidate, a: Answers, total: number): [string, string[]] {
  const reasons: string[] = [];
  if (a.listing_active < 0.8) reasons.push(`not clearly active (p=${a.listing_active.toFixed(2)})`);
  if (a.distressed_sale > 0.3) reasons.push("distressed sale");
  if (a.new_construction > 0.5) reasons.push("new construction");
  if (a.commercial_majority > 0.5) reasons.push("commercial-majority mixed use");
  if (a.condition > 3) reasons.push("heavy rehab");
  if (a.sf_signal.choice === "refused" && a.sf_signal.confidence >= 0.6) reasons.push("seller financing explicitly refused");
  if (reasons.length) return ["reject", reasons];

  const s = signals(c, a);
  const sf = a.sf_signal;
  const qualifying = SF_QUALIFYING.includes(sf.choice);

  if (s.sfClear) {
    // Open to seller financing. Needs at least one more quality signal (motivation or 60+ DOM) to be a lead.
    // Qualifies = open to seller financing + motivation and/or 60+ DOM. Never demoted for a low score.
    if (!s.motivated && !s.longDom) return ["watchlist", ["open to seller financing, but fresh listing with no motivation signals yet"]];
    if (s.count === 3 || total >= 70) return ["top", []];
    return ["secondary", []];
  }
  if (qualifying || sfOpenProb(a) >= 0.35 || (a.seller_is_lender >= 0.35 && a.seller_is_lender < 0.7) || sf.confidence < 0.5)
    return ["claude_review", [`ambiguous SF signal: ${sf.choice}, P(open to SF)=${sfOpenProb(a).toFixed(2)}, seller_is_lender=${a.seller_is_lender.toFixed(2)}`]];
  // No seller-finance language: keep motivated / long-DOM listings for a "would you carry paper?" call.
  if (s.motivated || s.longDom) return ["watchlist", [`no seller-finance language yet (${sf.choice}); ${[s.motivated && "motivated", s.longDom && `${s.dom} DOM`].filter(Boolean).join(", ")}`]];
  return ["reject", [`no seller-finance language and no motivation/DOM signals (${sf.choice})`]];
}

async function askJev(c: Candidate): Promise<[Answers, string]> {
  const state = JSON.stringify({
    address: c.address, units: c.units, status_on_page: c.status_on_page,
    description: c.description, financing_fields: c.financing_fields, year_built: c.year_built,
  });
  const res = await evaluate({ model: MODEL, state, questions: QUESTIONS });
  const x = res.answers as any;
  const probs: Record<string, number> = x.sf_signal.probabilities ?? { [x.sf_signal.choice]: 1 };
  const p = (k: string) => x[k].probability as number;
  const a: Answers = {
    // AI SDK returns the full distribution; confidence = probability of the chosen option
    sf_signal: { choice: x.sf_signal.choice, probabilities: probs, confidence: probs[x.sf_signal.choice] ?? 0 },
    motivation: x.motivation.score, condition: x.condition.score, occupancy: x.occupancy.score,
    seller_is_lender: p("seller_is_lender"), cash_or_conventional_welcome: p("cash_or_conventional_welcome"),
    listing_active: p("listing_active"), distressed_sale: p("distressed_sale"), new_construction: p("new_construction"),
    commercial_majority: p("commercial_majority"), free_and_clear: p("free_and_clear"), red_flags: p("red_flags"),
  };
  return [a, res.response.modelId];
}

function mockAnswers(c: Candidate): Answers {
  const t = `${c.description ?? ""} ${c.financing_fields ?? ""}`.toLowerCase();
  const explicit = ["owner will carry", "seller financing available", "owc", "seller will carry"].some((s) => t.includes(s));
  const open = ["consider", "creative", "entertain"].some((s) => t.includes(s));
  const choice = explicit ? "explicit_no_terms" : open ? "open_to_consider" : "none";
  return {
    sf_signal: { choice, confidence: 0.86, probabilities: { [choice]: 0.86 } },
    seller_is_lender: choice === "none" ? 0.1 : 0.9, cash_or_conventional_welcome: t.includes("cash") ? 0.9 : 0.1,
    listing_active: 0.95, distressed_sale: 0.02, new_construction: 0.01, commercial_majority: 0.02,
    motivation: t.includes("retir") ? 2.6 : t.includes("reduced") || t.includes("motivated") ? 1.8 : 0.3,
    condition: 1.2, occupancy: 2.6, free_and_clear: t.includes("free and clear") ? 0.7 : 0.1, red_flags: 0.05,
  };
}

async function main() {
  const [src, dst] = process.argv.slice(2).filter((s) => !s.startsWith("--"));
  const mock = process.argv.includes("--mock");
  const cands: Candidate[] = JSON.parse(readFileSync(src, "utf8"));
  let modelUsed = mock ? "mock" : "";
  const results: any[] = [];

  for (const c of cands) {
    const r: any = { id: c.id, address: c.address, url: c.url };
    const fails = hardGates(c);
    if (fails.length) { results.push({ ...r, bucket: "reject", reasons: fails }); continue; }
    let a: Answers;
    try {
      if (mock) a = mockAnswers(c);
      else [a, modelUsed] = await askJev(c);
    } catch (e: any) {
      results.push({ ...r, bucket: "claude_review", reasons: [`Jev error: ${e?.name}: ${String(e?.message ?? e).split("\n")[0]}`] });
      continue;
    }
    const s = score(c, a);
    const [bucket, reasons] = route(c, a, s.total);
    const sig = s.signals;
    results.push({
      ...r, bucket, reasons, fit_score: s.total, breakdown: s.breakdown,
      p_open_to_seller_finance: Math.round(sfOpenProb(a) * 100) / 100,
      quality_signals: { seller_finance_clear: sig.sfClear, motivated: sig.motivated, dom_60_plus: sig.longDom, count: sig.count },
      cash_or_conventional_also_welcome: a.cash_or_conventional_welcome >= 0.5,
      cap_rate: s.cap, cap_method: s.method, dom: sig.dom, jev: a,
    });
  }

  const order: Record<string, number> = { top: 0, secondary: 1, claude_review: 2, watchlist: 3, reject: 4 };
  results.sort((x, y) =>
    order[x.bucket] - order[y.bucket] ||
    (y.quality_signals?.count ?? 0) - (x.quality_signals?.count ?? 0) ||
    (y.fit_score ?? 0) - (x.fit_score ?? 0));
  const funnel = Object.fromEntries(Object.keys(order).map((b) => [b, results.filter((x) => x.bucket === b).length]));
  writeFileSync(dst, JSON.stringify({ run_date: today.toISOString().slice(0, 10), model: modelUsed, funnel, results }, null, 2));
  console.log(JSON.stringify({ model: modelUsed, funnel }, null, 2));
  for (const x of results) {
    const q = x.quality_signals ? `${x.quality_signals.count}/3 signals` : "";
    console.log(`[${x.bucket.padStart(13)}] ${String(x.fit_score ?? "-").padStart(5)} ${q.padStart(12)}  ${x.address}  ${(x.reasons ?? []).join("; ")}`);
  }
}

await main();
