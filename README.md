# Partner Engine

A small toolkit for people who buy businesses and income property and need to sort a flood of inbound interest quickly.

It does three jobs:

1. **Sort and match partners** (`partner-engine.ts sort`). Reads inbound inquiries, decides whether each one is real, works out the role the person wants to play (buyer, lender, guarantor, operator, equity partner, broker), and scores the fit against each of your open deals.
2. **Check deal posts** (`partner-engine.ts posts`). Flags marketing copy that advertises returns, uses guarantee language, solicits passive investors, implies you own a deal that is only under contract, reveals the identity of the business, or is missing a disclosure legend.
3. **Screen property leads** (`jev-screen.ts`, with `lead_dedup.py` and `pop_lookup.py`). Screens multifamily listings for seller financing signals, removes leads you have already seen, and checks city population.

A language model handles the fuzzy reading of messages and listings. Plain code handles every number, date, and threshold, so scores are repeatable and explainable.

## Quick start (no API key needed)

Requires Node 22.6 or newer.

```
npm install
npm run sort:mock
npm run posts:mock
```

Mock mode uses simple keyword rules in place of the model, so you can see the input and output shapes right away. Results are written to `out.json`.

## Running with the real model

The scripts call the `typesafe-ai/jev` evaluation model through the Vercel AI Gateway.

```
cp .env.example .env.local      # then add your key
node --env-file=.env.local partner-engine.ts sort  examples/sort-in.json  out.json
node --env-file=.env.local partner-engine.ts posts examples/posts-in.json out.json
```

## Input

`sort` takes `{ "deals": [...], "partners": [...] }`. `posts` takes `{ "posts": [...] }`. See the `examples` folder. All example data is fictional.

## How results are routed

Every result carries a confidence value and a review lane:

| Confidence | Lane |
| --- | --- |
| above 0.9 | Auto filed |
| 0.5 to 0.9 | Confirm (one click) |
| below 0.5 | You decide |

Partners are also given a route: Call first, Call this week, Nurture, or Not a fit.

## Match score

`match score = 100 x (0.30 check size fit + 0.15 speed fit + 0.15 risk fit + 0.40 structure fit)`, plus 5 points when the person asked about that specific deal.

## Population lookup data

`pop_lookup.py` expects `census-places-pop.csv` in the same folder. This is the public U.S. Census Bureau Vintage 2024 subcounty population estimates file, which you can download from census.gov. It is not included here because of its size.

## Important

The post checker is a drafting aid, not legal advice. Have counsel review anything that touches securities rules before you publish it.

Never commit real lead, partner, or deal data. The `.gitignore` excludes the usual run folders.

## License

MIT
