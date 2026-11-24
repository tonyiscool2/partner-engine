/**
 * Capital Partner Engine: Jev sorting, partner to LOI matching, and post compliance (via Vercel AI Gateway).
 * An agent or script gathers inquiries -> this script (Jev judgment + deterministic scoring) -> results are written back to your CRM.
 * Jev handles the fuzzy reads of messages and posts; code handles all arithmetic, dates, and thresholds.
 *
 * Usage:
 *   node --env-file=.env.local partner-engine.ts sort  <in.json> <out.json> [--mock]
 *   node --env-file=.env.local partner-engine.ts posts <in.json> <out.json> [--mock]
 *   in.json (sort):  { "deals": Deal[], "partners": Partner[] }
 *   in.json (posts): { "posts": Post[] }
 * Confidence routing: above 0.9 auto filed, 0.5 to 0.9 one click confirm, below 0.5 you decide.
 * Auth: AI_GATEWAY_API_KEY in .env.local (never printed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { experimental_evaluate as evaluate } from "ai";

const MODEL = "typesafe-ai/jev";
const AUTO = 0.9;
const CONFIRM = 0.5;

type Deal = {
  id: string; name: string; shape?: string; industry?: string; city?: string; state?: string;
  price?: number; real_estate_value?: number; check_min?: number; check_max?: number;
  target_close?: string | null; seeking?: string[]; structures?: string[]; risk?: string;
  equity_track?: string; summary?: string;
};
type Partner = {
  id: string; name?: string; firm?: string; source?: string; text: string;
  form?: { interested_in?: string; capital?: string; timeline?: string; accredited?: string; deal_id?: string };
};
type Post = { id: string; channel?: string; copy: string; equity_track?: string };

const bool = (instructions: string) => ({ type: "boolean" as const, instructions });
const r2 = (n: number) => Math.round(n * 100) / 100;
const boolConf = (p: number) => Math.max(p, 1 - p);
const lane = (c: number) => (c > AUTO ? "Auto filed" : c >= CONFIRM ? "Confirm (one click)" : "You decide");

// ---------- deterministic lookups ----------
const CHECK: Record<string, [number, number] | null> = {
  under_50k: [0, 50_000], "50_150k": [50_000, 150_000], "150_500k": [150_000, 500_000],
  "500k_1m": [500_000, 1_000_000], over_1m: [1_000_000, 100_000_000], not_stated: null,
};
const FORM_CAPITAL: Record<string, string> = {
  "Under $50K": "under_50k", "$50K to $150K": "50_150k", "$150K to $500K": "150_500k",
  "$500K to $1M": "500k_1m", "Over $1M": "over_1m", "Prefer to discuss": "not_stated",
};
const SPEED_DAYS: Record<string, number | null> = { ready_now: 30, within_3m: 90, "3_6m": 180, exploring: 365, not_stated: null };
const FORM_TIMELINE: Record<string, string> = {
  "Ready now": "ready_now", "Within 3 months": "within_3m", "3 to 6 months": "3_6m", "Just exploring": "exploring",
};
const RISK_IDX: Record<string, number> = { Conservative: 0, Moderate: 1, Aggressive: 2 };
const ROLE_LABEL: Record<string, string> = {
  buyer: "Buyer or assignee", lender: "Credit sponsor (lender)", guarantor: "Key principal or guarantor",
  operator: "Operating partner", equity: "Equity partner (506c track)", broker: "Broker or referral source", unclear: "Unclear",
};
const ROLE_SEEKING: Record<string, string[]> = {
  buyer: ["Buyer of the business", "Buyer of the real estate"],
  lender: ["Credit sponsor", "EMD or pursuit capital partner"],
  guarantor: ["Credit sponsor"],
  operator: ["Owner operator partner", "JV or co GP partner"],
  equity: ["JV or co GP partner"],
};

// ---------- Jev questions ----------
function sortQuestions(deals: Deal[]) {
  const dealCriteria: Record<string, string> = { general: "Not about one specific deal, or the deal cannot be identified" };
  deals.forEach((d, i) => {
    const bits = [d.industry, d.city && d.state ? `${d.city}, ${d.state}` : d.state, d.price ? `about $${Math.round(d.price / 1000)}K` : ""];
    dealCriteria[`d${i}`] = `${d.name}: ${bits.filter(Boolean).join(", ")}`;
  });
  return {
    real_interest: bool("This is a genuine inquiry from a person or firm who could plausibly buy, lend on, fund the EMD for, guarantee, invest in, or operate one of our business or real estate deals. Lenders or private money offering to fund our deal count as genuine. It is NOT spam, a marketing or software pitch, a bot, a recruiter, or an unrelated message."),
    vendor_pitch: bool("The sender is mainly selling us a service unrelated to funding or buying the deal (marketing, SEO, leads, software, coaching, virtual assistants). Offering a loan, EMD, or capital for the deal itself is NOT a vendor pitch."),
    partner_type: {
      type: "choice" as const,
      instructions: "Which role does this person most want to play in a deal?",
      criteria: {
        buyer: "Buy or take over the business, property, or purchase contract outright (cash, SBA, bank loan, or assuming seller financing)",
        lender: "Lend money: a commercial loan, private money, bridge, gap, or EMD funding repaid with interest",
        guarantor: "Lend their balance sheet, credit, or personal guaranty as key principal, in exchange for a fee",
        operator: "Actively run or manage the business or property day to day as a partner",
        equity: "Invest money passively for a share of profits or ownership without running anything",
        broker: "A broker, wholesaler, or intermediary bringing buyers or deals rather than acting as a principal",
        unclear: "The role cannot be determined",
      },
    },
    deal_ref: { type: "choice" as const, instructions: "Which of our open deals is this message responding to?", criteria: dealCriteria },
    accredited: {
      type: "choice" as const,
      instructions: "What does the person say about being an accredited investor?",
      criteria: {
        yes: "They state or clearly indicate they are an accredited investor, or they represent a family office, fund, bank, or institution",
        no: "They state they are not accredited",
        not_stated: "Accreditation is not mentioned",
      },
    },
    check_size: {
      type: "choice" as const,
      instructions: "How much cash, credit, or financing capacity do they say they can bring to a single deal?",
      criteria: {
        under_50k: "Under $50,000", "50_150k": "$50,000 to $150,000", "150_500k": "$150,000 to $500,000",
        "500k_1m": "$500,000 to $1,000,000", over_1m: "Over $1,000,000", not_stated: "No amount stated or implied",
      },
    },
    speed: {
      type: "choice" as const,
      instructions: "How soon are they ready to act on a deal?",
      criteria: {
        ready_now: "Ready now: funds, approval, or capacity in place, or wants to move immediately",
        within_3m: "Within about 3 months", "3_6m": "3 to 6 months out",
        exploring: "Just exploring or learning", not_stated: "No timing signal",
      },
    },
    risk: {
      type: "score" as const,
      instructions: "Risk appetite shown in the message",
      criteria: [
        "Conservative: wants stabilized cash flow, low leverage, bank style deals",
        "Moderate: open to some leverage, creative terms, or a light turnaround",
        "Aggressive: seeks creative finance, high leverage, turnarounds, or distressed deals",
      ],
    },
    open_seller_finance: bool("They are open to or seeking seller financing, subject to, or other creative financing structures"),
    needs_bank_or_sba: bool("They plan to rely on SBA or conventional bank financing"),
    experienced: bool("They describe relevant experience: owning or operating businesses, closing acquisitions, lending, or investing in real estate"),
  };
}

const POST_QUESTIONS = {
  promises_returns: bool("The post promises, projects, or advertises investor returns, yields, IRR, equity multiples, or profit percentages to readers"),
  guarantee_language: bool("The post uses words like guaranteed, risk free, can't lose, or safe investment"),
  solicits_passive: bool("The post invites readers to invest money passively (as a limited partner, silent partner, or for a share of profits) rather than to buy, lend, guarantee, or operate"),
  claims_ownership: bool("The post states or implies the poster already owns the business or property, rather than having it under contract or LOI"),
  reveals_identity: bool("The post reveals the business's exact name, street address, or other details that would identify it to its employees, customers, or competitors"),
  pressure: bool("The post uses high pressure tactics such as tight deadlines or first come first served language"),
};

// ---------- Jev calls ----------
async function ask(state: string, questions: any): Promise<any> {
  const res = await evaluate({ model: MODEL, state, questions });
  return { answers: res.answers as any, model: res.response.modelId };
}
const choiceOf = (x: any) => {
  const probs: Record<string, number> = x.probabilities ?? { [x.choice]: 1 };
  return { choice: x.choice as string, conf: probs[x.choice] ?? 0, probs };
};

function mockSort(p: Partner, deals: Deal[]) {
  const t = p.text.toLowerCase();
  const role = t.includes("lend") ? "lender" : t.includes("operat") || t.includes("run it") ? "operator"
    : t.includes("guarant") ? "guarantor" : t.includes("buy") || t.includes("acquire") ? "buyer" : "unclear";
  const di = deals.findIndex((d) => t.includes(d.name.toLowerCase().split(" ")[0]));
  const spam = t.includes("seo") || t.includes("our agency") || t.length < 20;
  return {
    real_interest: { probability: spam ? 0.05 : 0.93 }, vendor_pitch: { probability: spam ? 0.9 : 0.04 },
    partner_type: { choice: role, probabilities: { [role]: role === "unclear" ? 0.4 : 0.92 } },
    deal_ref: { choice: di >= 0 ? `d${di}` : "general", probabilities: { [di >= 0 ? `d${di}` : "general"]: di >= 0 ? 0.95 : 0.6 } },
    accredited: { choice: t.includes("accredited") ? "yes" : "not_stated", probabilities: { yes: 0.9, not_stated: 0.9 } },
    check_size: { choice: t.includes("million") ? "over_1m" : t.includes("250") ? "150_500k" : "not_stated", probabilities: { over_1m: 0.9, "150_500k": 0.9, not_stated: 0.9 } },
    speed: { choice: t.includes("now") || t.includes("ready") ? "ready_now" : "not_stated", probabilities: { ready_now: 0.9, not_stated: 0.9 } },
    risk: { score: t.includes("creative") || t.includes("seller financ") ? 1.6 : 0.8 },
    open_seller_finance: { probability: t.includes("seller financ") || t.includes("creative") ? 0.9 : 0.3 },
    needs_bank_or_sba: { probability: t.includes("sba") || t.includes("bank") ? 0.9 : 0.1 },
    experienced: { probability: t.includes("years") || t.includes("owned") || t.includes("closed") ? 0.9 : 0.3 },
  };
}

// ---------- partner sorting + matching ----------
function daysUntil(date?: string | null): number | null {
  if (!date) return null;
  const d = new Date(date);
  return isNaN(d.getTime()) ? null : Math.round((d.getTime() - Date.now()) / 86_400_000);
}

function matchOne(p: any, d: Deal, isReferenced: boolean) {
  // Check size fit
  const range = CHECK[p.check_size];
  let check = 0.5;
  if (range && (d.check_min || d.check_max)) {
    const lo = d.check_min ?? 0, hi = d.check_max ?? Number.MAX_SAFE_INTEGER;
    check = range[1] >= lo && range[0] <= hi ? 1 : range[1] >= lo * 0.5 ? 0.5 : 0;
  }
  // Speed fit
  const pd = SPEED_DAYS[p.speed], dd = daysUntil(d.target_close);
  const speed = pd === null ? 0.5 : dd === null ? 0.6 : pd <= Math.max(dd, 14) ? 1 : pd <= Math.max(dd, 14) * 1.5 ? 0.6 : 0.2;
  // Risk fit
  const risk = d.risk && d.risk in RISK_IDX ? 1 - Math.abs(RISK_IDX[d.risk] - p.risk) / 2 : 0.6;
  // Structure fit
  const wanted = ROLE_SEEKING[p.role] ?? [];
  let structure = p.role === "broker" ? 0.3 : p.role === "unclear" ? 0.2 : (d.seeking ?? []).some((s) => wanted.includes(s)) ? 1 : 0.25;
  if (p.role === "equity" && d.equity_track !== "506(c) cleared by counsel") structure = 0;
  const creativeDeal = (d.structures ?? []).some((s) => ["Assume seller financing", "Subject to"].includes(s));
  const bankOk = (d.structures ?? []).some((s) => ["SBA", "Conventional"].includes(s));
  if (p.role === "buyer" && p.needs_bank_or_sba >= 0.6 && !bankOk && creativeDeal) structure *= 0.6;
  if (p.role === "buyer" && creativeDeal && p.open_seller_finance >= 0.6) structure = Math.min(1, structure + 0.1);

  let score = 100 * (0.3 * check + 0.15 * speed + 0.15 * risk + 0.4 * structure);
  if (isReferenced) score += 5;
  score = Math.min(100, Math.round(score));
  let conf = p.confidence * (p.check_size === "not_stated" ? 0.85 : 1) * (isReferenced ? 1 : 0.95);
  conf = r2(conf);
  const reasons = [
    `check ${r2(check)}${range ? "" : " (not stated)"}`, `speed ${r2(speed)}`, `risk ${r2(risk)}`, `structure ${r2(structure)}`,
    isReferenced ? "asked about this deal" : "",
    p.role === "equity" && structure === 0 ? "equity partner but deal has no cleared 506(c) track" : "",
  ].filter(Boolean);
  return { deal_id: d.id, deal_name: d.name, match_score: score, check_fit: r2(check), speed_fit: r2(speed), risk_fit: r2(risk), structure_fit: r2(structure), confidence: conf, review: lane(conf), reasons: reasons.join("; ") };
}

async function runSort(input: { deals: Deal[]; partners: Partner[] }, mock: boolean) {
  const deals = input.deals ?? [];
  const Q = sortQuestions(deals);
  let modelUsed = mock ? "mock" : "";
  const out: any[] = [];
  for (const p of input.partners ?? []) {
    let x: any;
    try {
      if (mock) x = mockSort(p, deals);
      else { const r = await ask(JSON.stringify({ name: p.name, firm: p.firm, source: p.source, message: p.text, form: p.form }), Q); x = r.answers; modelUsed = r.model; }
    } catch (e: any) {
      out.push({ id: p.id, review: "You decide", error: `Jev error: ${e?.name}: ${String(e?.message ?? e).split("\n")[0]}` });
      continue;
    }
    const role = choiceOf(x.partner_type), ref = choiceOf(x.deal_ref), acc = choiceOf(x.accredited);
    let chk = choiceOf(x.check_size), spd = choiceOf(x.speed);
    // Form answers are facts: they override Jev with full confidence
    if (p.form?.capital && FORM_CAPITAL[p.form.capital]) chk = { choice: FORM_CAPITAL[p.form.capital], conf: 1, probs: {} };
    if (p.form?.timeline && FORM_TIMELINE[p.form.timeline]) spd = { choice: FORM_TIMELINE[p.form.timeline], conf: 1, probs: {} };
    let refDealId: string | null = ref.choice.startsWith("d") ? deals[Number(ref.choice.slice(1))]?.id ?? null : null;
    let refConf = ref.conf;
    if (p.form?.deal_id) { refDealId = p.form.deal_id; refConf = 1; }
    const accredited = p.form?.accredited ? p.form.accredited : acc.choice === "yes" ? "Yes" : acc.choice === "no" ? "No" : "Not stated";

    const realP = x.real_interest.probability as number, vendorP = x.vendor_pitch.probability as number;
    const confs = [boolConf(realP), role.conf, deals.length > 1 ? refConf : 1];
    if (role.choice === "equity") confs.push(p.form?.accredited ? 1 : acc.conf);
    const noise = realP < 0.3 || vendorP >= 0.7;
    // A noise call only depends on the noise questions, so rate it on those
    const confidence = noise ? r2(Math.max(boolConf(realP), boolConf(vendorP))) : r2(Math.min(...confs));


    const pv = {
      role: role.choice, check_size: chk.choice, speed: spd.choice, risk: x.risk.score as number,
      open_seller_finance: x.open_seller_finance.probability as number, needs_bank_or_sba: x.needs_bank_or_sba.probability as number, confidence,
    };
    const matches = noise ? [] : deals.map((d) => matchOne(pv, d, d.id === refDealId)).filter((m) => m.match_score >= 40 || m.deal_id === refDealId)
      .sort((a, b) => b.match_score - a.match_score);
    const best = matches[0]?.match_score ?? 0;
    const route = noise ? "Not a fit"
      : realP < 0.5 || role.choice === "unclear" ? "Nurture"
      : best >= 70 && ["ready_now", "within_3m"].includes(spd.choice) ? "Call first"
      : best >= 50 ? "Call this week" : "Nurture";
    const structures = [
      pv.open_seller_finance >= 0.6 ? "Assume seller financing" : "", pv.needs_bank_or_sba >= 0.6 ? "SBA" : "",
      role.choice === "lender" ? "Lending" : "", role.choice === "guarantor" ? "Guaranty for fee" : "",
      role.choice === "operator" || role.choice === "equity" ? "JV or split equity" : "",
    ].filter(Boolean);
    out.push({
      id: p.id, name: p.name, route, review: lane(confidence), confidence,
      real_interest: r2(realP), vendor_pitch: r2(vendorP), partner_type: ROLE_LABEL[role.choice], partner_type_conf: r2(role.conf),
      deal_ref: refDealId, deal_ref_conf: r2(refConf), accredited, check_size: chk.choice, speed: spd.choice,
      risk_appetite: pv.risk < 0.67 ? "Conservative" : pv.risk < 1.34 ? "Moderate" : "Aggressive",
      experienced: r2(x.experienced.probability), structures_open_to: structures, matches,
    });
  }
  const order: Record<string, number> = { "Call first": 0, "Call this week": 1, Nurture: 2, "Not a fit": 3 };
  out.sort((a, b) => (order[a.route] ?? 9) - (order[b.route] ?? 9) || (b.matches?.[0]?.match_score ?? 0) - (a.matches?.[0]?.match_score ?? 0));
  const funnel = Object.fromEntries(Object.keys(order).map((k) => [k, out.filter((o) => o.route === k).length]));
  const lanes = Object.fromEntries(["Auto filed", "Confirm (one click)", "You decide"].map((k) => [k, out.filter((o) => o.review === k).length]));
  return { model: modelUsed, funnel, lanes, results: out };
}

// ---------- post compliance gate ----------
const LEGEND_RX = /not an offer to sell|offer to buy (any )?securit/i;
async function runPosts(input: { posts: Post[] }, mock: boolean) {
  let modelUsed = mock ? "mock" : "";
  const out: any[] = [];
  for (const post of input.posts ?? []) {
    let x: any;
    try {
      if (mock) {
        const t = post.copy.toLowerCase();
        x = Object.fromEntries(Object.keys(POST_QUESTIONS).map((k) => [k, { probability: 0.03 }]));
        if (/guarantee|risk free/.test(t)) x.guarantee_language.probability = 0.95;
        if (/% return|irr|cash on cash/.test(t)) x.promises_returns.probability = 0.9;
        if (/silent partner|passive/.test(t)) x.solicits_passive.probability = 0.9;
      } else { const r = await ask(post.copy, POST_QUESTIONS); x = r.answers; modelUsed = r.model; }
    } catch (e: any) {
      out.push({ id: post.id, check: "Pending", review: "You decide", notes: `Jev error: ${e?.name}` });
      continue;
    }
    const flags: string[] = [];
    const p = (k: string) => x[k].probability as number;
    if (p("promises_returns") >= 0.5) flags.push("advertises returns");
    if (p("guarantee_language") >= 0.5) flags.push("guarantee or risk free language");
    if (p("solicits_passive") >= 0.5 && post.equity_track !== "506(c) cleared by counsel") flags.push("solicits passive investors without a cleared 506(c) track");
    if (p("claims_ownership") >= 0.5) flags.push("implies we own it; say under contract or under LOI");
    if (p("reveals_identity") >= 0.5) flags.push("identifies the business; keep teaser blind until NDA");
    if (p("pressure") >= 0.5) flags.push("pressure tactics");
    if (!LEGEND_RX.test(post.copy)) flags.push("missing disclosure legend");
    if (!/\{FORM_LINK\}|https?:\/\/|comment details/i.test(post.copy)) flags.push("missing call to action (form link or Comment DETAILS)");
    if (/[—–]/.test(post.copy)) flags.push("contains em or en dashes (house style)");
    const confidence = r2(Math.min(...Object.keys(POST_QUESTIONS).map((k) => boolConf(p(k)))));
    out.push({ id: post.id, channel: post.channel, check: flags.length ? "Fail" : "Pass", review: lane(confidence), confidence, notes: flags.join("; ") || "clean", jev: Object.fromEntries(Object.keys(POST_QUESTIONS).map((k) => [k, r2(p(k))])) });
  }
  return { model: modelUsed, passed: out.filter((o) => o.check === "Pass").length, failed: out.filter((o) => o.check === "Fail").length, results: out };
}

async function main() {
  const args = process.argv.slice(2).filter((s) => !s.startsWith("--"));
  const [mode, src, dst] = args;
  const mock = process.argv.includes("--mock");
  const input = JSON.parse(readFileSync(src, "utf8"));
  const result = mode === "posts" ? await runPosts(input, mock) : await runSort(input, mock);
  const payload = { run_at: new Date().toISOString(), mode, ...result };
  writeFileSync(dst, JSON.stringify(payload, null, 2));
  const { results, ...summary } = payload as any;
  console.log(JSON.stringify(summary, null, 2));
}

await main();
