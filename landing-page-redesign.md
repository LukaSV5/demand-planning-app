# THE GLASS BOX — Landing Page Redesign Spec

**Positioning:** *the forecasting tool that shows you when it's wrong.*
**Scope:** hero and everything below on index.html. Header/nav untouched.
**Status:** design final (won a 3-concept judge panel 2026-06-11); NOT yet implemented.
**Implementation estimate:** ~30–60 min for Claude (static sections first, then the Backtest Theater), 2–4 days for a human dev.

The page is built like an audit report, not an ad: every claim paired with checkable evidence, every number either computed live in the visitor's browser or traceable to a printed formula. Trust through verifiability — no fake logos, no fake testimonials (it's a portfolio product; that constraint is the brand).

## Name candidates
1. **Holdout** (recommended) — the name IS the methodology; tagline "Forecasts scored on data they never saw."
2. **CoverCast** — most legible to non-technical buyers (stock cover + forecast).
3. **TrueHorizon** — planner vocabulary + honesty flag; safe but generic.

## Palette & typography
Keep dark `#0c0c0e` canvas and existing tokens. Add semantic channels (print as a legend in the Proof Ledger; color = meaning, never decoration):
- `--verify: #22c55e` — ONLY walk-forward-validated numbers (mirrors app's MASE green)
- `--caution: #f59e0b` — uncertainty: interval bands, "optimistic by construction" labels
- `--actual: #9ca3af` — actuals lines; ground truth is humble gray
- `--error-stick: rgba(244,63,94,.65)` — forecast-miss whiskers
- `--purple #7c3aed` stays ACTION-ONLY (buttons/links, never data)

Typography: self-host Inter-Variable woff2 (currently named but never loaded — Windows gets Segoe UI), `font-display:swap`. ALL numbers monospace (`ui-monospace, Cascadia Code, Consolas`) — audit-trail signature, no reflow when counters tick. Keep existing type scale; add `.metric-xl` = clamp(28px,3.5vw,44px)/700/mono for ledger counters.

## Hero
- Badge pill: `⚖ Every number on this page is checkable in your browser` ("checkable", NOT "computed" — hero chart is static SVG; judges flagged the overclaim)
- H1: **"Most forecasting tools show you their best fit."** / em-italic line 2: **"This one shows you its mistakes."**
- Sub: "Seven statistical models, audited by walk-forward validation on *your* data — honest WAPE and MASE scores, 80% prediction intervals on every forecast, and replenishment quantities you can defend in a Monday meeting. Built end-to-end by Luka Abazadze, supply chain analyst. The whole engine runs in your browser; nothing hides behind a server."
- Primary CTA: `Open the Live Workspace — no signup →` → dashboard.html; microcopy beneath (11px mono): `Free · no signup · one click loads a 140-SKU demo portfolio`
- Ghost CTA: `Watch a model get audited ↓` → #backtest (replaces the mislabeled "View My Professional CV" button)
- **Hero visual "The Honest Chart"**: ONE wide evidence card (existing glass + tilt recipe, tilt flattens on hover 0.45s). Inline SVG: gray actuals full width; dashed divider `TRAINING ▸ │ ◂ HELD OUT`; purple forecast right of divider VISIBLY MISSING 2 of 6 points, rose whiskers to truth with signed errors (-38, +12); amber 80% band (fill 14% opacity — 8% invisible on office monitors) annotated *"your uncertainty budget — safety stock lives here"*; forecast line self-draws on load (stroke-dashoffset 1.6s). Caption: "6 held-out months. 4 hits, 2 misses, all 6 inside the band. **WAPE 9.6% · MASE 0.71** — that's the score we lead with." Flanking mini-cards: ~~In-sample 4.1%~~ struck amber "✗ optimistic by construction" | "Walk-forward: 9.6% ✓ the number you can plan on" (green).

## Proof Ledger (replaces social proof; directly under hero)
Micro-label: `NO CUSTOMER LOGOS. NO TESTIMONIALS. JUST THINGS YOU CAN CHECK.`
Cells (mono .metric-xl + 12px captions; repo-verified figures only):
1. `140 SKUs · 109,275 rows` — "the demo portfolio: three years of real-shaped retail history, one click."
2. `MASE < 1.0` — "beat copy-last-year or get benched. Failing scores show red in the app — we don't hide them."
3. `80%` — "10th/90th percentiles of real walk-forward residuals, not a decorative cone."
4. `0 servers` — "Right-click → View Source. The methodology isn't a whitepaper; it's the page you're on."
5. LIVE cell: `Validation fits run in this tab: 0` — wired to count REAL Backtest Theater fits (counted, not claimed).
Ledger footer (verbatim): *"This is a portfolio build by one analyst, not a venture-backed vendor. Which is exactly why nothing here is taken on faith — your browser just verified it."*
Link-row: `Read the validation methodology` · `We don't delete the storm →` (details: "88% of textbook 'outliers' in this data are real November–December peaks. Capping them would amputate the very signal you're forecasting. So we don't. **Your spikes are data, not dirt.**") · `Prefer a guided tour? Email the analyst →` (mailto:abazadzeluka@outlook.com with prefilled subject — early booking path)

Ticker: keep; update "MAE · RMSE · MAPE" pill → "WAPE · MASE · MAE · RMSE".

## Evidence Bento (features)
H2: **"Features are claims. Here's the evidence for ours."** Sub: "Everything below is shipped and running one click away — nothing on a roadmap."
6 cells, 4-col CSS grid (→2-col @1000px, 1-col @640px), 18px-radius cards, each ends in a **PROOF strip** (1px-bordered mono bar; slides open on hover, always open on touch):
1. (2×2) Walk-Forward Validation — `HONEST ACCURACY` — **"Re-fit from scratch. Score blind. Repeat."** Proof: `validation: {wape, mase, origins × horizon} — zero future leakage`
2. (2×1) Best Fit Auto-Routing — `7 MODELS, 1 WINNER PER SKU` — **"Your slow movers and your bestsellers don't deserve the same model."** Proof: `★ 140/140 SKUs routed · click any leaderboard row to override`
3. (2×1) 80% Intervals — `UNCERTAINTY, QUANTIFIED` — **"A forecast without a range is a guess with good posture."** Proof: `lower ≤ forecast ≤ upper, always`
4. (1×1) Global XGBoost — `PORTFOLIO LEARNING` — **"Sparse SKUs borrow strength."**
5. (1×1) Benchmark Floor — `THE BAR TO CLEAR` — **"Beat the naive forecast, or say so."** Proof: `MASE 0.71 ✓` green / `MASE 1.18 ✗` red side by side
6. (2×1) Forecast-Driven Replenishment — `FROM PREDICTION TO PURCHASE ORDER` — **"The forecast isn't the deliverable. The order quantity is."** Proof: `SKU-1061 · FOAM ROLLER 60CM · To Order: 200 (rounded to MOQ) · 23d cover` (real SKU)

## How It Works — "The Audit Trail"
H2: **"From CSV to defensible order quantity in four steps."**
4 glass cards on a connecting line that IS the story: solid gray steps 1–2 → green-dashed "verified" after step 2 → purple arrowhead. Line draws on scroll (stroke-dashoffset 1.4s); cards stagger fade-up.
01 CONNECT "Drop in your CSVs." (auto-mapped, or Load Demo Dataset) · 02 AUDIT "Watch every SKU get backtested." (worker + progress chip) · 03 DECIDE "Open the drawer. Interrogate the forecast." (routed model pre-selected, band, PNG export) · 04 REPLENISH "Turn the forecast into a PO." (To-Order @ MOQ, reorder points, cover days, Create PO)
Keep existing Models section below; align footnote copy to WAPE/MASE.

## Backtest Theater (wow element, id="backtest")
H2: **"Don't take the score's word for it. Watch it being earned."** Sub: "Real SKU from the demo dataset, real engine from the workspace — js/models.js, the same file. Press play."
Glass panel: model pills **Seasonal Naive · Theta · Auto-ETS · Prophet** (XGBoost/Ensemble excluded + footnote saying why) · `▶ Run the audit` · Chart.js canvas 16:7 · mono scoreboard (Origins · Forecasts scored · WAPE · MASE).
Show: training-window overlay grows; model ACTUALLY re-fit per origin (~900ms apart); forecast draws past cutoff; rose whiskers snap misses to truth; WAPE/MASE counters wobble as errors land; old forecasts persist at 25%→12% opacity (walk-forward spaghetti). Finale: amber band sweeps in; verdict types out (~28 chars/s):
- ✓ "Auto-ETS beat the seasonal-naive benchmark on 42 held-out forecasts. WAPE 11.2% · MASE 0.78. This is the number the workspace would route on."
- ✗ "On this SKU, Theta did not beat copy-last-year (MASE 1.07). The workspace would bench it — that's what Best Fit is for." (model losing on stage = the page's most persuasive moment)
Then: ranked leaderboard fades in worst-to-first, winner last under `★ ROUTED`; **rows clickable** (re-run audit per model — visitor rehearses the real drawer UX). Beneath: replenishment readout from the winner: `REORDER POINT 412 · TO ORDER 450 (MOQ) · COVER 23 DAYS`. Exit CTA: `This ran {N} validation fits in your tab just now. Run all 7 models on your own data →`

Build notes (judge-verified against js/models.js):
- Registry keys: `snaive | theta | holtwinters | prophet` (NOT 'ets' — caught in review)
- Scripts at body end: Chart.js 4.4.1 CDN (same as dashboard) + js/models.js + ~200-line inline script; static-SVG fallback on CDN failure
- Data: one real 36-month series INLINED as const (works from file://), SKU id cited in a source comment
- Per origin L: `Models.run(key, SERIES.slice(0,L), {}, min(6, n−L))`; WAPE = 100·Σ|e|/Σ|y|; MASE scale = mean |y[t]−y[t−12]|; cross-check against engine's own validation in a tooltip
- `animation:false` on chart, setInterval(900ms) pacing, cancel/restart-safe; whiskers + training overlay = small afterDatasetsDraw plugins
- Engine calls inside setTimeout(…,50) so spinner paints; prefers-reduced-motion → instant final state; pills = buttons with aria-pressed
- This script also drives the Proof Ledger live-fits counter

## Final CTA
Mirrored radial glow from top (closes the page like a bracket). Micro-label `ONE LAST HONEST QUESTION`.
H2: **"Your current forecast has an error rate. / Do you know what it is?"**
Sub: "The workspace will tell you in about ninety seconds: load the demo data or your own CSVs, let the worker route every SKU to its proven model, and read the WAPE you'd actually be planning on. No signup, no server, no sales call — unless you want one." (+ tooltip: "Don't know your WAPE? 30–45% is typical for monthly SKU-level retail.")
Primary `Open the Live Workspace →`; beneath: `First 90 seconds: press the button · click Load Demo Dataset · open any SKU · press ★ Best Fit`
Secondary: `Or email Luka Abazadze — the analyst who built the engine →`
Signature (11px mono at --text-2, NOT --text-3 — WCAG): `static site · client-side engine · view source anytime`
Charm close: **"Free — it's a portfolio. The price is feedback ✓"**
Footer unchanged.

## Micro-interactions
All 0.15–0.2s ease-out; prefers-reduced-motion → final states. Hero tilt flatten 0.45s · whisker hover thicken + signed-error reveal (CSS) · ledger odometers roll 1.2s once (IntersectionObserver) · bento proof strips slide open on hover · journey line gray→green draw synced to step 2 · theater pill select = nav active recipe; scoreboard blur-unblur 0.2s on reset · verdict type-on with ✓ pop · ghost-CTA arrival pulses theater border purple 0.6s · ticker untouched.

## Page order
Header (untouched) → Hero → Proof Ledger → ticker → Evidence Bento → Audit Trail → existing Models section → Backtest Theater → Final CTA → footer.
