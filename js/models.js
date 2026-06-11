/**
 * models.js — Demand forecasting engine
 *
 * ── Architecture ──────────────────────────────────────────────────────────────
 *
 * Registry (7 models, in order): snaive, ema, theta, holtwinters, prophet,
 * xgboost, ensemble.
 *
 * Models.run(modelKey, data, params, horizon) returns:
 *   {
 *     inSample   : (number|null)[]  — one-step-ahead fitted values, null where undefined
 *     forecast   : number[]         — length = horizon, all >= 0
 *     lower      : number[]         — 80% empirical prediction interval lower bound (>= 0)
 *     upper      : number[]         — 80% upper bound
 *     metrics    : { mae, rmse, mape, wape, smape, mapeExcludedZeros }   — IN-SAMPLE fit
 *     validation : { wape, mase, mae, rmse, origins, horizon } | null   — walk-forward,
 *                  the honest headline metrics (in-sample fit can be gamed)
 *     autoParams : object           — params chosen by each model's self-tuning
 *     fallback   : { model, reason } | null — set whenever insufficient data forced
 *                  a simpler model (never a silent console.warn)
 *   }
 *
 * Walk-forward validation (Models.walkForward) is the heart of the engine:
 * the model is re-fit from scratch (including all grid searches / auto-tuning)
 * on data.slice(0, L) for a sequence of expanding train lengths L, forecasts
 * up to `horizon` steps ahead, and the out-of-sample errors are pooled. There
 * is zero leakage from the future into any fit. Results are memoized so that
 * autoSelect + prediction intervals stay fast.
 *
 * Prediction intervals are model-agnostic: the 10th/90th percentiles of the
 * walk-forward residuals at each forecast step are added to the point
 * forecast (adjacent steps pooled when a step has < 5 residuals). When
 * walk-forward is impossible (short series) a Gaussian in-sample-sigma
 * fallback (±1.282·σ·√h) is used. lower >= 0 and lower <= forecast <= upper
 * are always enforced.
 *
 * There is deliberately NO outlier/spike cleaning step: on this dataset 88% of
 * Tukey-fence "outliers" are genuine November/December seasonal peaks — IQR
 * capping amputates the seasonal signal the models exist to capture. Genuine
 * off-season anomalies are ~0.65% of months and not worth modeling.
 *
 * Rounding happens ONLY on the final arrays returned by run()/backtest();
 * all internal state, recursions and walk-forward fits use full precision.
 *
 * Models.setGlobalSales(bySKU) feeds the global XGBoost model, which trains
 * one gradient-boosted model per forecast step on lag/seasonality features
 * pooled across every SKU (scale-normalized per SKU).
 */

const Models = (() => {

  // ── Utility ──────────────────────────────────────────────────────────────────

  function round2(n) { return Math.round(n * 100) / 100; }

  function _mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

  // Interpolated empirical quantile (q in [0,1]) of an unsorted array.
  function _quantile(arr, q) {
    const a = arr.slice().sort((x, y) => x - y);
    const n = a.length;
    if (n === 0) return 0;
    if (n === 1) return a[0];
    const pos = q * (n - 1);
    const lo  = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  // Simple linear regression y ≈ a + b·t over t = 0..n-1.
  function _linFit(y) {
    const n = y.length;
    let st = 0, sy = 0, stt = 0, sty = 0;
    for (let t = 0; t < n; t++) { st += t; sy += y[t]; stt += t * t; sty += t * y[t]; }
    const den = n * stt - st * st;
    const b   = Math.abs(den) > 1e-12 ? (n * sty - st * sy) / den : 0;
    return { a: (sy - b * st) / n, b };
  }

  // Lag-k autocorrelation of a series.
  function _acf(y, k) {
    const n = y.length;
    if (n <= k) return 0;
    const m = _mean(y);
    let num = 0, den = 0;
    for (let t = 0; t < n; t++) den += (y[t] - m) * (y[t] - m);
    if (den < 1e-12) return 0;
    for (let t = k; t < n; t++) num += (y[t] - m) * (y[t - k] - m);
    return num / den;
  }

  // ── Metrics ──────────────────────────────────────────────────────────────────
  //
  //  Zero-actual months count FULLY in MAE / RMSE / WAPE / sMAPE. Only MAPE
  //  skips them (division by zero) and reports how many via mapeExcludedZeros.
  //  (The old engine dropped zeros from MAE/RMSE too — that bug is fixed here.)

  function computeMetrics(actual, fitted) {
    let sumAbs = 0, sumSq = 0, sumPct = 0, sumSm = 0, sumAct = 0;
    let n = 0, nMape = 0, nSm = 0, nZero = 0;
    for (let i = 0; i < actual.length; i++) {
      if (fitted[i] == null || actual[i] == null) continue;
      const e = actual[i] - fitted[i];
      sumAbs += Math.abs(e);
      sumSq  += e * e;
      sumAct += Math.abs(actual[i]);
      n++;
      if (actual[i] === 0) { nZero++; }
      else { sumPct += Math.abs(e / actual[i]); nMape++; }
      const den = Math.abs(actual[i]) + Math.abs(fitted[i]);
      if (den > 0) { sumSm += 200 * Math.abs(e) / den; nSm++; } // both-zero pairs skipped
    }
    if (n === 0) {
      return { mae: null, rmse: null, mape: null, wape: null, smape: null, mapeExcludedZeros: 0 };
    }
    return {
      mae   : round2(sumAbs / n),
      rmse  : round2(Math.sqrt(sumSq / n)),
      mape  : nMape > 0 ? round2((sumPct / nMape) * 100) : null,
      wape  : sumAct > 1e-12 ? round2((sumAbs / sumAct) * 100) : null,
      smape : nSm > 0 ? round2(sumSm / nSm) : null,
      // Callers can show a disclaimer when zero-demand months were excluded from MAPE
      mapeExcludedZeros: nZero
    };
  }

  //  MASE denominator: in-sample MAE of the seasonal naive (lag-12 when the
  //  series has >= 24 points, else lag-1) over the FULL series. One consistent
  //  scale per series so models can be ranked against each other.
  function _maseScale(data) {
    const n = data.length;
    const m = n >= 24 ? 12 : 1;
    let s = 0, c = 0;
    for (let t = m; t < n; t++) { s += Math.abs(data[t] - data[t - m]); c++; }
    return c > 0 ? s / c : 0;
  }

  // ── Linear algebra helpers (OLS) ─────────────────────────────────────────────

  function matMul(A, B) {
    const m = A.length, n = B[0].length, k = B.length;
    return Array.from({ length: m }, (_, i) =>
      Array.from({ length: n }, (_, j) =>
        Array.from({ length: k }, (_, l) => A[i][l] * B[l][j])
          .reduce((s, v) => s + v, 0)));
  }

  function matTrans(A) {
    return A[0].map((_, j) => A.map(row => row[j]));
  }

  function solve(A, b) {
    const n = A.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let maxRow = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[maxRow][col])) maxRow = r;
      }
      [M[col], M[maxRow]] = [M[maxRow], M[col]];
      if (Math.abs(M[col][col]) < 1e-12) continue;
      const pivot = M[col][col];
      for (let j = col; j <= n; j++) M[col][j] /= pivot;
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const factor = M[r][col];
        for (let j = col; j <= n; j++) M[r][j] -= factor * M[col][j];
      }
    }
    return M.map(row => row[n]);
  }

  function ols(X, y, lambda = 1e-4) {
    const Xt  = matTrans(X);
    const XtX = matMul(Xt, X);
    for (let i = 0; i < XtX.length; i++) XtX[i][i] += lambda;
    const Xty = Xt.map(row => row.reduce((s, v, i) => s + v * y[i], 0));
    return solve(XtX, Xty);
  }

  // ── Shared SES core (used by ema + theta) ────────────────────────────────────
  //
  //  One-step-ahead recursion with NO look-ahead: the fit for period t is the
  //  level BEFORE observing y[t]. No rounding inside the recursion.

  function _sesPass(y, alpha) {
    const n = y.length;
    const fitted = new Array(n).fill(null);
    let level = y[0], sse = 0;
    for (let t = 1; t < n; t++) {
      fitted[t] = level;
      const e = y[t] - level;
      sse += e * e;
      level = alpha * y[t] + (1 - alpha) * level;
    }
    return { fitted, level, sse };
  }

  //  Grid 0.05 .. 0.95 step 0.05, minimizing one-step SSE.
  function _bestAlphaSES(y) {
    let best = null;
    for (let i = 1; i <= 19; i++) {
      const alpha = Math.round(i * 5) / 100;
      const pass  = _sesPass(y, alpha);
      if (!best || pass.sse < best.sse) best = { alpha, fitted: pass.fitted, level: pass.level, sse: pass.sse };
    }
    return best;
  }

  // ── Classical seasonal decomposition (m = 12) ────────────────────────────────
  //
  //  Centered 12-term moving average as trend-cycle; seasonal index per slot
  //  averaged across ALL complete years. type 'mul' → indices normalized to
  //  mean 1; type 'add' → indices centered to mean 0. Slots with no usable
  //  ratio (short series) get the neutral index.

  function _classicalSeasonal(y, type) {
    const n = y.length, m = 12;
    const sum = new Array(m).fill(0), cnt = new Array(m).fill(0);
    for (let t = 6; t <= n - 7; t++) {
      let ma = 0.5 * y[t - 6] + 0.5 * y[t + 6];
      for (let j = t - 5; j <= t + 5; j++) ma += y[j];
      ma /= 12;
      if (type === 'mul') {
        if (Math.abs(ma) < 1e-9) continue;            // guard division by ~0
        sum[t % m] += y[t] / ma;
      } else {
        sum[t % m] += y[t] - ma;
      }
      cnt[t % m]++;
    }
    const si = new Array(m);
    for (let s = 0; s < m; s++) si[s] = cnt[s] > 0 ? sum[s] / cnt[s] : (type === 'mul' ? 1 : 0);
    if (type === 'mul') {
      const mu = _mean(si);
      if (mu > 1e-9) for (let s = 0; s < m; s++) si[s] /= mu;
      for (let s = 0; s < m; s++) if (!(si[s] > 1e-6)) si[s] = 1e-6; // never divide by ~0
    } else {
      const mu = _mean(si);
      for (let s = 0; s < m; s++) si[s] -= mu;
    }
    return si;
  }

  // ── 1. Seasonal Naive ────────────────────────────────────────────────────────
  //
  //  forecast[h] = same month last year. The benchmark floor every other model
  //  has to beat. With < 13 points it degrades to repeating the last value.

  function snaive(data, params = {}, horizon = 6) {
    const n = data.length;
    if (n < 13) {
      const inS = new Array(n).fill(null);
      for (let t = 1; t < n; t++) inS[t] = Math.max(0, data[t - 1]);
      return {
        inSample : inS,
        forecast : new Array(horizon).fill(Math.max(0, data[n - 1])),
        autoParams: { m: 1 },
        fallback : { model: 'naive', reason: 'only ' + n + ' points (< 13) — repeating last value instead of last season' }
      };
    }
    const m   = 12;
    const inS = new Array(n).fill(null);
    for (let t = m; t < n; t++) inS[t] = Math.max(0, data[t - m]);
    const forecast = [];
    for (let h = 0; h < horizon; h++) forecast.push(Math.max(0, data[n - m + (h % m)]));
    return { inSample: inS, forecast, autoParams: { m: 12 }, fallback: null };
  }

  // ── 2. Auto-tuned SES ────────────────────────────────────────────────────────
  //
  //  Single exponential smoothing, α optimized over 0.05..0.95 by one-step SSE.
  //  Also the universal insufficient-data fallback for the bigger models.

  function ema(data, params = {}, horizon = 6) {
    const best = _bestAlphaSES(data);
    return {
      inSample : best.fitted.map(v => (v == null ? null : Math.max(0, v))),
      forecast : new Array(horizon).fill(Math.max(0, best.level)),
      autoParams: { alpha: best.alpha },
      fallback : null
    };
  }

  // ── 3. Theta Method ──────────────────────────────────────────────────────────
  //
  //  M3-competition champion. If the lag-12 autocorrelation is significant
  //  (> 1.645·√(1/n), n >= 24) the series is deseasonalized with multiplicative
  //  classical decomposition. Theta-0 line = OLS trend; theta-2 line = 2y − line
  //  smoothed with auto-tuned SES. Forecast = ½·(extrapolated line + SES level),
  //  reseasonalized.

  function theta(data, params = {}, horizon = 6) {
    const n = data.length;
    if (n < 8) {
      const r = ema(data, {}, horizon);
      r.fallback = { model: 'ema', reason: 'only ' + n + ' points (< 8) — used auto-tuned SES instead of Theta' };
      return r;
    }

    let si = null;
    if (n >= 24 && _acf(data, 12) > 1.645 * Math.sqrt(1 / n)) {
      si = _classicalSeasonal(data, 'mul');
    }
    const y = si ? data.map((v, t) => v / si[t % 12]) : data.slice();

    const { a, b } = _linFit(y);                      // theta-0 line
    const theta2   = y.map((v, t) => 2 * v - (a + b * t));
    const ses      = _bestAlphaSES(theta2);           // SES on the theta-2 line

    const inS = new Array(n).fill(null);
    for (let t = 1; t < n; t++) {
      if (ses.fitted[t] == null) continue;
      let f = 0.5 * ((a + b * t) + ses.fitted[t]);
      if (si) f *= si[t % 12];
      inS[t] = Math.max(0, f);
    }

    const forecast = [];
    for (let i = 0; i < horizon; i++) {               // forecast index i ↔ time t = n + i
      let f = 0.5 * ((a + b * (n + i)) + ses.level);
      if (si) f *= si[(n + i) % 12];
      forecast.push(Math.max(0, f));
    }

    return {
      inSample : inS,
      forecast,
      autoParams: { seasonal: !!si, alpha: ses.alpha, slope: round2(b) },
      fallback : null
    };
  }

  // ── 4. Auto-ETS (damped-trend Holt-Winters) ──────────────────────────────────
  //
  //  Supports BOTH additive and multiplicative seasonality (m = 12) with a
  //  damped trend (φ). All of α, β, γ, φ and the season type are grid-searched
  //  by one-step-ahead SSE over t >= 12 — the seasonal initialization comes
  //  from classical decomposition averaged across all complete years and is
  //  precomputed once per season type.

  const HW_ALPHAS = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
  const HW_BETAS  = [0.01, 0.05, 0.1, 0.2, 0.3];
  // gamma = 0 keeps the decomposition-averaged seasonal profile fixed
  // (deterministic seasonality) — often best with only 3 observed cycles.
  const HW_GAMMAS = [0, 0.05, 0.1, 0.2, 0.3, 0.5];
  const HW_PHIS   = [0.8, 0.9, 0.95, 0.98, 1.0];

  //  One full damped Holt-Winters pass. One-step-ahead fits only: the
  //  prediction for t is made BEFORE updating with y[t]. First season null.
  function _hwPass(y, type, alpha, beta, gamma, phi, level0, trend0, seas0, collectFits) {
    const n = y.length, m = 12;
    let level = level0, trend = trend0;
    const s = seas0.slice();
    let sse = 0;
    const fits = collectFits ? new Array(n).fill(null) : null;
    for (let t = 0; t < n; t++) {
      const si   = t % m;
      const base = level + phi * trend;
      const pred = type === 'mul' ? base * s[si] : base + s[si];
      if (t >= m) {
        const e = y[t] - pred;
        sse += e * e;
        if (fits) fits[t] = Math.max(0, pred);
      }
      const lPrev = level;
      if (type === 'mul') {
        if (!(s[si] > 1e-9) || !isFinite(s[si])) return { sse: Infinity };
        level = alpha * (y[t] / s[si]) + (1 - alpha) * base;
        if (!(level > 1e-9)) return { sse: Infinity };
        trend = beta * (level - lPrev) + (1 - beta) * phi * trend;
        s[si] = gamma * (y[t] / level) + (1 - gamma) * s[si];
      } else {
        level = alpha * (y[t] - s[si]) + (1 - alpha) * base;
        trend = beta * (level - lPrev) + (1 - beta) * phi * trend;
        s[si] = gamma * (y[t] - level) + (1 - gamma) * s[si];
      }
      if (!isFinite(level) || !isFinite(trend)) return { sse: Infinity };
    }
    return { sse, level, trend, s, fits };
  }

  //  Damped multi-step forecast from a finished _hwPass state, starting at time L.
  function _hwForecastFrom(p, type, phi, L, steps) {
    const out = [];
    let dsum = 0, pw = phi;
    for (let i = 0; i < steps; i++) {
      dsum += pw; pw *= phi;
      const slot = (L + i) % 12;
      const base = p.level + dsum * p.trend;
      out.push(Math.max(0, type === 'mul' ? base * p.s[slot] : base + p.s[slot]));
    }
    return out;
  }

  //  Damped Holt (no seasonality) for series too short for a 12-month season.
  function _dampedHolt(data, horizon) {
    const n = data.length;
    const level0 = data[0];
    const trend0 = n >= 2 ? data[1] - data[0] : 0;

    function pass(alpha, beta, phi, collectFits) {
      let level = level0, trend = trend0, sse = 0;
      const fits = collectFits ? new Array(n).fill(null) : null;
      for (let t = 1; t < n; t++) {
        const pred = level + phi * trend;
        const e = data[t] - pred;
        sse += e * e;
        if (fits) fits[t] = Math.max(0, pred);
        const lPrev = level;
        level = alpha * data[t] + (1 - alpha) * pred;
        trend = beta * (level - lPrev) + (1 - beta) * phi * trend;
      }
      return { sse, level, trend, fits };
    }

    let best = null;
    for (const alpha of HW_ALPHAS) for (const beta of HW_BETAS) for (const phi of HW_PHIS) {
      const p = pass(alpha, beta, phi, false);
      if (!best || p.sse < best.sse) best = { alpha, beta, phi, sse: p.sse };
    }
    const fin = pass(best.alpha, best.beta, best.phi, true);

    const forecast = [];
    let dsum = 0, pw = best.phi;
    for (let i = 0; i < horizon; i++) {
      dsum += pw; pw *= best.phi;
      forecast.push(Math.max(0, fin.level + dsum * fin.trend));
    }
    return {
      inSample : fin.fits,
      forecast,
      autoParams: { alpha: best.alpha, beta: best.beta, phi: best.phi, seasonType: 'none' },
      fallback : { model: 'holt', reason: 'only ' + n + ' points (< 16) — seasonal components disabled (damped Holt)' }
    };
  }

  function holtwinters(data, params = {}, horizon = 6) {
    const n = data.length, m = 12;
    if (n < 8) {
      const r = ema(data, {}, horizon);
      r.fallback = { model: 'ema', reason: 'only ' + n + ' points (< 8) — used auto-tuned SES instead of Holt-Winters' };
      return r;
    }
    if (n < m + 4) return _dampedHolt(data, horizon);

    // ── Initialization (shared across the whole grid) ──
    const level0 = _mean(data.slice(0, m));
    const trend0 = n >= 2 * m
      ? (_mean(data.slice(m, 2 * m)) - _mean(data.slice(0, m))) / m
      : _linFit(data).b;
    const anyNonPos = data.some(v => v <= 0);
    const seasInit  = {
      add: _classicalSeasonal(data, 'add'),
      mul: anyNonPos ? null : _classicalSeasonal(data, 'mul')   // mul needs strictly positive data
    };

    // ── Stage 1: one-step SSE over the full series for every combo ──
    const types = anyNonPos || !(level0 > 0) ? ['add'] : ['add', 'mul'];
    const scored = [];
    for (const type of types) {
      const s0 = seasInit[type];
      for (const alpha of HW_ALPHAS)
        for (const beta of HW_BETAS)
          for (const gamma of HW_GAMMAS)
            for (const phi of HW_PHIS) {
              const p = _hwPass(data, type, alpha, beta, gamma, phi, level0, trend0, s0, false);
              if (isFinite(p.sse)) scored.push({ type, alpha, beta, gamma, phi, sse: p.sse });
            }
    }
    if (!scored.length) {
      const r = ema(data, {}, horizon);
      r.fallback = { model: 'ema', reason: 'no stable Holt-Winters configuration found — used auto-tuned SES' };
      return r;
    }
    scored.sort((a, b) => a.sse - b.sse);
    let best = scored[0];

    // ── Stage 2: one-step SSE barely punishes multi-step trend overshoot (a
    //  trend error compounds over the horizon but enters each one-step error
    //  once — measured on the real data, pure-SSE selection made Auto-ETS
    //  lose to seasonal naive out of sample). Re-rank the 40 best one-step
    //  configs by their blind multi-step MAE on the tail of the series:
    //  refit on data[0..L) for L = n-6, n-4, n-2 and score forecasts to n. ──
    const msOrigins = [n - 6, n - 4, n - 2].filter(L => L >= m + 6);
    if (msOrigins.length && scored.length > 1) {
      const shortlist = scored.slice(0, 40);
      const initCache = {};                            // per (L, type) sub-slice init
      for (const cfg of shortlist) {
        let absSum = 0, cnt = 0;
        for (const L of msOrigins) {
          const ck = L + cfg.type;
          if (!(ck in initCache)) {
            const sub = data.slice(0, L);
            initCache[ck] = {
              level0: _mean(sub.slice(0, m)),
              trend0: L >= 2 * m
                ? (_mean(sub.slice(m, 2 * m)) - _mean(sub.slice(0, m))) / m
                : _linFit(sub).b,
              s0: _classicalSeasonal(sub, cfg.type)
            };
          }
          const ic = initCache[ck];
          const p = _hwPass(data.slice(0, L), cfg.type, cfg.alpha, cfg.beta, cfg.gamma, cfg.phi,
                            ic.level0, ic.trend0, ic.s0, false);
          if (!isFinite(p.sse)) { absSum = Infinity; break; }
          const fc = _hwForecastFrom(p, cfg.type, cfg.phi, L, n - L);
          for (let t = L; t < n; t++) { absSum += Math.abs(data[t] - fc[t - L]); cnt++; }
        }
        cfg.msMae = (cnt > 0 && isFinite(absSum)) ? absSum / cnt : Infinity;
      }
      shortlist.sort((a, b) => (a.msMae - b.msMae) || (a.sse - b.sse));
      if (isFinite(shortlist[0].msMae)) best = shortlist[0];
    }

    const fin = _hwPass(data, best.type, best.alpha, best.beta, best.gamma, best.phi,
                        level0, trend0, seasInit[best.type], true);

    const forecast = [];
    let dsum = 0, pw = best.phi;
    for (let i = 0; i < horizon; i++) {                 // forecast index i ↔ time t = n + i
      dsum += pw; pw *= best.phi;
      const slot = (n + i) % m;
      const base = fin.level + dsum * fin.trend;
      forecast.push(Math.max(0, best.type === 'mul' ? base * fin.s[slot] : base + fin.s[slot]));
    }

    return {
      inSample : fin.fits,
      forecast,
      autoParams: {
        alpha: best.alpha, beta: best.beta, gamma: best.gamma, phi: best.phi,
        seasonType: best.type === 'mul' ? 'multiplicative' : 'additive',
        sse: round2(best.sse)
      },
      fallback : null
    };
  }

  // ── 5. Prophet-style harmonic regression ─────────────────────────────────────
  //
  //  Ridge regression on [intercept, trend, changepoint hinges, Fourier pairs].
  //  Trend & hinge columns are divided by T so every feature has comparable
  //  magnitude and λ actually regularizes. Extrapolation beyond T uses the
  //  end-of-series marginal slope decayed by φ = 0.9 per step (damped trend —
  //  raw linear extrapolation overshoots on this data). Hyperparameters
  //  (changepoints × Fourier order × λ) are chosen by a mini walk-forward.

  const PROPHET_PHI = 0.9;

  //  Fit on y with complexity cap 2 + nCp + 2N <= floor(T/2) (shrink N, then nCp).
  function _prophetFit(y, nCp, N, lambda) {
    const T = y.length;
    const cap = Math.floor(T / 2);
    let n2 = N, cp2 = nCp;
    while (2 + cp2 + 2 * n2 > cap && n2 > 1) n2--;
    while (2 + cp2 + 2 * n2 > cap && cp2 > 0) cp2--;
    if (2 + cp2 + 2 * n2 > cap) return null;

    const cps = Array.from({ length: cp2 }, (_, i) => Math.floor((i + 1) * T * 0.8 / (cp2 + 1)));
    const row = t => {
      const r = [1, t / T];
      for (const cp of cps) r.push(t > cp ? (t - cp) / T : 0);
      for (let k = 1; k <= n2; k++) {
        r.push(Math.cos(2 * Math.PI * k * t / 12));
        r.push(Math.sin(2 * Math.PI * k * t / 12));
      }
      return r;
    };

    const X = Array.from({ length: T }, (_, t) => row(t));
    let beta;
    try { beta = ols(X, y, lambda); } catch (e) { return null; }
    if (beta.some(v => !isFinite(v))) return null;
    return { beta, cps, N: n2, nCp: cp2, lambda, T, row };
  }

  function _prophetTrendAt(fit, t) {
    let v = fit.beta[0] + fit.beta[1] * (t / fit.T);
    for (let j = 0; j < fit.cps.length; j++) {
      if (t > fit.cps[j]) v += fit.beta[2 + j] * ((t - fit.cps[j]) / fit.T);
    }
    return v;
  }

  function _prophetSeasAt(fit, t) {
    let v = 0, b = 2 + fit.cps.length;
    for (let k = 1; k <= fit.N; k++) {
      v += fit.beta[b++] * Math.cos(2 * Math.PI * k * t / 12);
      v += fit.beta[b++] * Math.sin(2 * Math.PI * k * t / 12);
    }
    return v;
  }

  //  Damped-trend extrapolation: anchor at the trend component of the last
  //  observed point; the marginal slope (base + active hinges, original time
  //  units) decays by φ per step. Seasonality is evaluated at the true t.
  function _prophetForecast(fit, horizon) {
    let slope = fit.beta[1] / fit.T;
    for (let j = 0; j < fit.cps.length; j++) {
      if (fit.T - 1 > fit.cps[j]) slope += fit.beta[2 + j] / fit.T;
    }
    const anchor = _prophetTrendAt(fit, fit.T - 1);
    const out = [];
    let dsum = 0, pw = PROPHET_PHI;
    for (let i = 0; i < horizon; i++) {                 // forecast index i ↔ time t = T + i
      dsum += pw; pw *= PROPHET_PHI;
      out.push(Math.max(0, anchor + slope * dsum + _prophetSeasAt(fit, fit.T + i)));
    }
    return out;
  }

  //  Mini walk-forward grid validation: 3 origins (L = T-6, T-4, T-2), each
  //  forecasting the next 2 points; average MAE across all pooled points.
  function _prophetGrid(data) {
    const T = data.length;
    const def = { nCp: 3, N: 5, lambda: 1 };
    const origins = [T - 6, T - 4, T - 2].filter(L => L >= 10);
    if (!origins.length) return def;

    let best = null;
    for (const cp of [1, 3, 6]) {
      for (const fo of [3, 5, 8]) {
        for (const lam of [0.1, 1, 10]) {
          let absSum = 0, cnt = 0, ok = true;
          for (const L of origins) {
            const fit = _prophetFit(data.slice(0, L), cp, fo, lam);
            if (!fit) { ok = false; break; }
            const hEff = Math.min(2, T - L);
            const fc   = _prophetForecast(fit, hEff);
            for (let h = 0; h < hEff; h++) { absSum += Math.abs(data[L + h] - fc[h]); cnt++; }
          }
          if (!ok || cnt === 0) continue;
          const mae = absSum / cnt;
          if (!best || mae < best.mae) best = { nCp: cp, N: fo, lambda: lam, mae };
        }
      }
    }
    return best || def;
  }

  function prophet(data, params = {}, horizon = 6) {
    const T = data.length;
    if (T < 10) {
      const r = ema(data, {}, horizon);
      r.fallback = { model: 'ema', reason: 'only ' + T + ' points (< 10) — used auto-tuned SES instead of harmonic regression' };
      return r;
    }

    const g   = _prophetGrid(data);
    const fit = _prophetFit(data, g.nCp, g.N, g.lambda);
    if (!fit) {
      const r = ema(data, {}, horizon);
      r.fallback = { model: 'ema', reason: 'harmonic regression could not be fit on ' + T + ' points — used auto-tuned SES' };
      return r;
    }

    // In-sample fitted values (regression fits — the closest analogue of
    // one-step fits for a global regression; the UI demotes these anyway).
    const inS = new Array(T);
    for (let t = 0; t < T; t++) {
      inS[t] = Math.max(0, _prophetTrendAt(fit, t) + _prophetSeasAt(fit, t));
    }

    return {
      inSample : inS,
      forecast : _prophetForecast(fit, horizon),
      autoParams: {
        changepoints: fit.nCp, fourierOrder: fit.N, lambda: fit.lambda,
        gridMAE: g.mae != null ? round2(g.mae) : null, trendDamping: PROPHET_PHI
      },
      fallback : null
    };
  }

  // ── 6. XGBoost (global gradient boosting across all SKUs) ────────────────────
  //
  //  One boosted model per forecast step h = 1..6 (DIRECT multi-horizon — no
  //  recursive feeding of forecasts back into features). Training rows are
  //  pooled across every SKU, each scaled by its own mean so models learn
  //  shape, not size. Calendar month enters as sin/cos of the REAL month
  //  parsed from the month labels (fixes the old t%12 Dec→Jan discontinuity).
  //
  //  All series passed to this model are assumed to align with the global
  //  month axis at index 0 (true in this app — every SKU spans the common
  //  axis; walk-forward slices are prefixes of it).

  const XGB_TREES = 60, XGB_DEPTH = 3, XGB_LR = 0.08, XGB_MIN_LEAF = 5, XGB_MAX_H = 6, XGB_BINS = 16;

  let _globalSales = null;              // { axis, month0, series, skuCount }
  const _xgbModelCache = new Map();     // cutoff signature → { cutoff, models[6] }

  function setGlobalSales(bySKU) {
    _xgbModelCache.clear();
    _wfCache.clear();                   // xgboost walk-forwards depend on this data
    _globalSales = null;
    if (!bySKU || typeof bySKU !== 'object') return;

    const monthSet = new Set();
    Object.keys(bySKU).forEach(sku => {
      const e = bySKU[sku];
      if (e && Array.isArray(e.months)) e.months.forEach(mm => monthSet.add(mm));
    });
    const axis = Array.from(monthSet).sort();
    if (!axis.length) return;

    const series = [];
    Object.keys(bySKU).forEach(sku => {
      const e = bySKU[sku];
      if (!e || !Array.isArray(e.months) || !Array.isArray(e.values)) return;
      const map = new Map();
      e.months.forEach((mm, i) => map.set(mm, Number(e.values[i]) || 0));
      series.push(axis.map(mm => (map.has(mm) ? map.get(mm) : 0)));  // zero-fill
    });
    if (!series.length) return;

    const month0 = parseInt(axis[0].slice(5, 7), 10) || 1;
    _globalSales = { axis, month0, series, skuCount: series.length };
  }

  //  Calendar month (1..12) of a global-axis index; valid beyond the axis end.
  function _calMonth(idx) {
    const m0 = _globalSales ? _globalSales.month0 : 1;
    return ((m0 - 1 + idx) % 12 + 12) % 12 + 1;
  }

  //  Features at forecast origin t (last observed index) for target index
  //  targetIdx, on the scaled series s. Requires t >= 11.
  function _xgbFeatures(s, t, targetIdx, cutoff) {
    let m12 = 0;
    for (let j = t - 11; j <= t; j++) m12 += s[j];
    m12 /= 12;
    const cm = _calMonth(targetIdx);
    return [
      s[t], s[t - 1], s[t - 2], s[t - 5], s[t - 11],   // lag1, lag2, lag3, lag6, lag12
      (s[t] + s[t - 1] + s[t - 2]) / 3,                // mean of last 3
      m12,                                             // mean of last 12
      Math.sin(2 * Math.PI * cm / 12),
      Math.cos(2 * Math.PI * cm / 12),
      t / cutoff                                       // relative position
    ];
  }

  //  Regression tree on pre-binned features. Split candidates are quantile
  //  thresholds (max 16 per feature) computed once per boosted model —
  //  scanning every unique value on ~2,500 pooled rows would be too slow.
  function _buildTree(idx, resid, bins, cands, nf, depth) {
    const n = idx.length;
    let total = 0;
    for (let i = 0; i < n; i++) total += resid[idx[i]];
    const mean = total / n;
    if (depth >= XGB_DEPTH || n < 2 * XGB_MIN_LEAF) return { leaf: true, value: mean };

    // Minimizing SSE_left + SSE_right ≡ maximizing ls²/lc + rs²/rc.
    let bestVal = total * total / n + 1e-12, bestFeat = -1, bestC = -1;
    for (let f = 0; f < nf; f++) {
      const c = cands[f], nb = c.length + 1;
      const cnt = new Float64Array(nb), sum = new Float64Array(nb);
      for (let i = 0; i < n; i++) {
        const b = bins[idx[i] * nf + f];
        cnt[b]++; sum[b] += resid[idx[i]];
      }
      let lc = 0, ls = 0;
      for (let ci = 0; ci < c.length; ci++) {
        lc += cnt[ci]; ls += sum[ci];
        const rc = n - lc;
        if (lc < XGB_MIN_LEAF || rc < XGB_MIN_LEAF) continue;  // min-samples-per-leaf guard
        const rs  = total - ls;
        const val = ls * ls / lc + rs * rs / rc;
        if (val > bestVal) { bestVal = val; bestFeat = f; bestC = ci; }
      }
    }
    if (bestFeat < 0) return { leaf: true, value: mean };

    const left = [], right = [];
    for (let i = 0; i < n; i++) {
      (bins[idx[i] * nf + bestFeat] <= bestC ? left : right).push(idx[i]);
    }
    return {
      leaf: false, feat: bestFeat, thresh: cands[bestFeat][bestC],
      left : _buildTree(left,  resid, bins, cands, nf, depth + 1),
      right: _buildTree(right, resid, bins, cands, nf, depth + 1)
    };
  }

  function _predictTree(node, x) {
    if (node.leaf) return node.value;
    return x[node.feat] <= node.thresh
      ? _predictTree(node.left, x)
      : _predictTree(node.right, x);
  }

  function _gbmTrain(X, y) {
    const n = X.length;
    if (n === 0) return { base: 0, trees: [] };
    const base = _mean(y);
    if (n < 2 * XGB_MIN_LEAF) return { base, trees: [] };

    const nf = X[0].length;
    // Quantile-based split candidates per feature (≤ 16, deduplicated).
    const cands = [];
    for (let f = 0; f < nf; f++) {
      const vals = X.map(r => r[f]).sort((a, b) => a - b);
      const c = [];
      for (let q = 1; q <= XGB_BINS; q++) {
        const v = vals[Math.min(n - 1, Math.floor(q * n / (XGB_BINS + 1)))];
        if (!c.length || v > c[c.length - 1]) c.push(v);
      }
      cands.push(c);
    }
    // Bin index per row per feature: b = #candidates strictly below x, so
    // "x <= cands[ci]" ⟺ "b <= ci" — split search becomes a histogram scan.
    const bins = new Uint8Array(n * nf);
    for (let i = 0; i < n; i++) {
      const row = X[i];
      for (let f = 0; f < nf; f++) {
        const c = cands[f];
        let lo = 0, hi = c.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (c[mid] < row[f]) lo = mid + 1; else hi = mid; }
        bins[i * nf + f] = lo;
      }
    }

    const resid = new Float64Array(n);
    for (let i = 0; i < n; i++) resid[i] = y[i] - base;
    const idx0 = [];
    for (let i = 0; i < n; i++) idx0.push(i);

    const trees = [];
    for (let it = 0; it < XGB_TREES; it++) {
      const tree = _buildTree(idx0, resid, bins, cands, nf, 0);
      trees.push(tree);
      for (let i = 0; i < n; i++) resid[i] -= XGB_LR * _predictTree(tree, X[i]);
    }
    return { base, trees };
  }

  function _gbmPredict(model, feat) {
    let v = model.base;
    for (let i = 0; i < model.trees.length; i++) v += XGB_LR * _predictTree(model.trees[i], feat);
    return v;
  }

  //  Train the 6 direct-horizon models with data up to `cutoff` months.
  function _xgbTrain(cutoff) {
    const scaled = [];
    for (const sv of _globalSales.series) {
      let scale = 0;
      for (let j = 0; j < cutoff; j++) scale += sv[j];
      scale /= cutoff;
      if (scale <= 1e-9) continue;                     // guard all-zero SKU
      const s = new Float64Array(cutoff);
      for (let j = 0; j < cutoff; j++) s[j] = sv[j] / scale;
      scaled.push(s);
    }
    const models = [];
    for (let h = 1; h <= XGB_MAX_H; h++) {
      const X = [], y = [];
      for (const s of scaled) {
        for (let t = 12; t + h <= cutoff - 1; t++) {   // target s[t+h] stays inside the cutoff
          X.push(_xgbFeatures(s, t, t + h, cutoff));
          y.push(s[t + h]);
        }
      }
      models.push(_gbmTrain(X, y));
    }
    return { cutoff, models };
  }

  //  Cache per cutoff signature (months + SKU count + axis length). Partial-
  //  history fits (walk-forward internals) may reuse a model trained at a
  //  cutoff up to 3 months EARLIER — strictly less data, so never leaks; it
  //  just bounds retraining cost. The full-history fit is always exact.
  function _xgbModels(cutoffReq) {
    const g = _globalSales;
    const cutoff = Math.max(13, Math.min(cutoffReq, g.axis.length));
    const sig = c => c + '|' + g.skuCount + '|' + g.axis.length;
    const exact = _xgbModelCache.get(sig(cutoff));
    if (exact) return exact;
    if (cutoff < g.axis.length) {
      for (let back = 1; back <= 3; back++) {
        const near = _xgbModelCache.get(sig(cutoff - back));
        if (near) return near;
      }
    }
    const trained = _xgbTrain(cutoff);
    if (_xgbModelCache.size > 40) _xgbModelCache.clear();
    _xgbModelCache.set(sig(cutoff), trained);
    return trained;
  }

  function xgboost(data, params = {}, horizon = 6) {
    const n = data.length;
    if (!_globalSales || _globalSales.skuCount < 10) {
      const r = theta(data, {}, horizon);
      r.fallback = {
        model : 'theta',
        reason: _globalSales
          ? 'global pool has only ' + _globalSales.skuCount + ' SKUs (< 10) — used Theta instead'
          : 'global sales data not loaded (Models.setGlobalSales) — used Theta instead'
      };
      return r;
    }
    if (n < 13) {
      const r = theta(data, {}, horizon);
      r.fallback = { model: 'theta', reason: 'only ' + n + ' points (< 13) — lag-12 features unavailable, used Theta' };
      return r;
    }

    const scale = _mean(data);
    if (scale <= 1e-9) {
      return {
        inSample : new Array(n).fill(null),
        forecast : new Array(horizon).fill(0),
        autoParams: { cutoff: n, pooledSKUs: _globalSales.skuCount },
        fallback : null
      };
    }

    // Walk-forward passes __cutoff = Lmin so ONE model set serves all origins.
    const set = _xgbModels(Math.min(params.__cutoff || n, n));
    const s   = data.map(v => v / scale);

    const origin = n - 1;
    const forecast = [];
    for (let i = 0; i < horizon; i++) {
      const hStep = i + 1;
      const model = set.models[Math.min(hStep, XGB_MAX_H) - 1];  // steps > 6 reuse the h=6 model
      const feat  = _xgbFeatures(s, origin, origin + hStep, set.cutoff);
      forecast.push(Math.max(0, _gbmPredict(model, feat) * scale));
    }

    // One-step-ahead in-sample fits from the h=1 model.
    const inS = new Array(n).fill(null);
    const m1  = set.models[0];
    for (let t = 12; t < n; t++) {
      inS[t] = Math.max(0, _gbmPredict(m1, _xgbFeatures(s, t - 1, t, set.cutoff)) * scale);
    }

    return {
      inSample : inS,
      forecast,
      autoParams: {
        cutoff: set.cutoff, pooledSKUs: _globalSales.skuCount,
        treesPerHorizon: XGB_TREES, depth: XGB_DEPTH, learningRate: XGB_LR
      },
      fallback : null
    };
  }

  // ── 7. Ensemble (Top-3 blend) ────────────────────────────────────────────────
  //
  //  Walk-forward-validates every other model on the series, keeps the top 3
  //  by WAPE, and blends their forecasts with weights ∝ 1/WAPE. Inside the
  //  ensemble's OWN walk-forward the member validations run with maxOrigins 4
  //  (params.__innerOrigins) to bound cost — memoization makes it tractable.

  const ENSEMBLE_MEMBERS = ['snaive', 'ema', 'theta', 'holtwinters', 'prophet', 'xgboost'];

  function ensemble(data, params = {}, horizon = 6) {
    const n = data.length;
    const innerOrigins = params.__innerOrigins || 6;
    // Largest ranking horizon walk-forward can score on this series (Lmin >= 18).
    const hRank = Math.min(6, n - 18);

    const ranked = [];
    if (hRank >= 1) {
      for (const k of ENSEMBLE_MEMBERS) {
        let wf = null;
        try { wf = walkForward(k, data, {}, { horizon: hRank, maxOrigins: innerOrigins }); }
        catch (e) { wf = null; }
        if (wf && wf.metrics.wape != null && isFinite(wf.metrics.wape)) {
          ranked.push({ model: k, wape: wf.metrics.wape });
        }
      }
    }
    ranked.sort((a, b) => a.wape - b.wape);
    const top = ranked.slice(0, 3);

    if (!top.length) {
      const r = theta(data, {}, horizon);
      r.fallback = { model: 'theta', reason: 'series too short to walk-forward-rank ensemble members — used Theta' };
      return r;
    }

    const inv  = top.map(t => 1 / Math.max(t.wape, 1e-6));
    const wSum = inv.reduce((s, v) => s + v, 0);
    const weights = inv.map(v => v / wSum);

    const fits = top.map(t => _fitModel(t.model, data, {}, horizon));

    const forecast = new Array(horizon).fill(0);
    for (let i = 0; i < horizon; i++) {
      let v = 0;
      for (let j = 0; j < fits.length; j++) v += weights[j] * fits[j].forecast[i];
      forecast[i] = Math.max(0, v);
    }

    const inS = new Array(n).fill(null);
    for (let t = 0; t < n; t++) {
      let v = 0, ok = true;
      for (let j = 0; j < fits.length; j++) {
        const f = fits[j].inSample[t];
        if (f == null) { ok = false; break; }
        v += weights[j] * f;
      }
      if (ok) inS[t] = Math.max(0, v);
    }

    return {
      inSample : inS,
      forecast,
      autoParams: {
        members: top.map((t, j) => ({
          model : t.model,
          wape  : t.wape,
          weight: Math.round(weights[j] * 1000) / 1000
        }))
      },
      fallback : null
    };
  }

  // ── Internal fit dispatcher ──────────────────────────────────────────────────
  //
  //  Raw model fit: full-precision inSample/forecast, autoParams, fallback.
  //  run() layers metrics, validation, intervals and rounding on top.

  function _fitModel(modelKey, data, params, horizon) {
    const meta = MODEL_META[modelKey];
    if (!meta) throw new Error('Unknown model: ' + modelKey);
    if (!data || data.length < 3) {
      return {
        inSample : new Array(data ? data.length : 0).fill(null),
        forecast : new Array(horizon).fill(0),
        autoParams: {},
        fallback : { model: 'none', reason: 'fewer than 3 observations' }
      };
    }
    const res = meta.fn(data, params || {}, horizon);
    if (!res.autoParams) res.autoParams = {};
    if (res.fallback === undefined) res.fallback = null;
    return res;
  }

  // ── Walk-forward validation engine ───────────────────────────────────────────
  //
  //  Expanding-window origins: fit on data.slice(0, L) ONLY (all auto-tuning
  //  redone inside the slice — zero leakage), forecast min(horizon, n−L)
  //  steps, pool every (origin, step) error. For xgboost, ONE global model
  //  set is trained at cutoff = Lmin and reused for every origin — strictly
  //  less data than any origin sees, so leak-free (slightly pessimistic).

  const _wfCache = new Map();

  function walkForward(modelKey, data, params, opts) {
    if (!MODEL_META[modelKey]) throw new Error('Unknown model: ' + modelKey);
    params = params || {};
    opts   = opts || {};
    const horizon    = Math.max(1, opts.horizon || 6);
    const maxOrigins = Math.max(1, opts.maxOrigins || 8);
    const n = data ? data.length : 0;

    const Lmin = Math.max(18, n - horizon - maxOrigins + 1);
    if (n - horizon < Lmin) return null;

    let dataSum = 0;
    for (let i = 0; i < n; i++) dataSum += data[i];
    const key = [modelKey, n, data[0], data[n - 1], dataSum,
                 JSON.stringify(params), horizon, maxOrigins].join('|');
    if (_wfCache.has(key)) return _wfCache.get(key);

    const span = (n - 1) - Lmin + 1;
    const step = Math.max(1, Math.ceil(span / maxOrigins));

    // Internal flags: xgboost reuses one model set; ensemble shrinks its
    // inner member validations. Derived from modelKey, so the memo key
    // (original params) stays unique.
    const fitParams =
      modelKey === 'xgboost'  ? Object.assign({}, params, { __cutoff: Lmin }) :
      modelKey === 'ensemble' ? Object.assign({}, params, { __innerOrigins: 4 }) :
      params;

    const residualsByHorizon = Array.from({ length: horizon }, () => []);
    let sumAbs = 0, sumSq = 0, sumAct = 0, cnt = 0, originCount = 0;

    for (let L = Lmin; L <= n - 1; L += step) {
      const hEff = Math.min(horizon, n - L);
      let fit;
      try { fit = _fitModel(modelKey, data.slice(0, L), fitParams, hEff); }
      catch (e) { continue; }
      if (!fit || !Array.isArray(fit.forecast)) continue;
      originCount++;
      for (let h = 0; h < hEff; h++) {
        const e = data[L + h] - fit.forecast[h];
        residualsByHorizon[h].push(e);
        sumAbs += Math.abs(e);
        sumSq  += e * e;
        sumAct += Math.abs(data[L + h]);
        cnt++;
      }
    }

    let out = null;
    if (originCount > 0 && cnt > 0) {
      const mae   = sumAbs / cnt;
      const scale = _maseScale(data);
      out = {
        metrics: {
          wape: sumAct > 1e-12 ? round2((sumAbs / sumAct) * 100) : null,
          mase: scale > 1e-9 ? round2(mae / scale) : null,
          mae : round2(mae),
          rmse: round2(Math.sqrt(sumSq / cnt))
        },
        origins: originCount,
        horizon,
        residualsByHorizon
      };
    }
    if (_wfCache.size > 400) _wfCache.clear();
    _wfCache.set(key, out);
    return out;
  }

  // ── Prediction intervals (model-agnostic, 80% empirical) ─────────────────────

  function _pooledResiduals(residualsByHorizon, h, minN) {
    let pooled = residualsByHorizon[h].slice();
    let k = 1;
    while (pooled.length < minN && k < residualsByHorizon.length) {
      if (h - k >= 0)                         pooled = pooled.concat(residualsByHorizon[h - k]);
      if (h + k < residualsByHorizon.length)  pooled = pooled.concat(residualsByHorizon[h + k]);
      k++;
    }
    return pooled;
  }

  function _inSampleSigma(data, inSample) {
    let sq = 0, c = 0;
    for (let i = 0; i < data.length; i++) {
      if (inSample[i] == null) continue;
      const e = data[i] - inSample[i];
      sq += e * e;
      c++;
    }
    return c > 0 ? Math.sqrt(sq / c) : 0;
  }

  // ── Public API ────────────────────────────────────────────────────────────────

  function run(modelKey, data, params, horizon) {
    params  = params || {};
    horizon = horizon || 6;

    const meta = MODEL_META[modelKey];
    if (!meta) throw new Error('Unknown model: ' + modelKey);

    if (!data || data.length < 3) {
      return {
        inSample : [],
        forecast : new Array(horizon).fill(0),
        lower    : new Array(horizon).fill(0),
        upper    : new Array(horizon).fill(0),
        metrics  : { mae: null, rmse: null, mape: null, wape: null, smape: null, mapeExcludedZeros: 0 },
        validation: null,
        autoParams: {},
        fallback : { model: 'none', reason: 'fewer than 3 observations — returning zero forecast' }
      };
    }

    const fit     = _fitModel(modelKey, data, params, horizon);
    const metrics = computeMetrics(data, fit.inSample);

    let wf = null;
    try { wf = walkForward(modelKey, data, params, { horizon, maxOrigins: 8 }); }
    catch (e) { wf = null; }

    const forecast = fit.forecast.map(v => Math.max(0, v));
    const lower = new Array(horizon), upper = new Array(horizon);
    const sigma = _inSampleSigma(data, fit.inSample);

    // Empirical quantiles of ~8 walk-forward residuals underestimate the
    // tails (measured 49-69% coverage vs the nominal 80% on the real data).
    // Floor the band width at the Gaussian 80% width of the same residuals:
    // max(empirical, 1.282σ_wf) restores ~78% measured coverage.
    let wfSigma = null;
    if (wf && wf.residualsByHorizon) {
      const all = [];
      for (const r of wf.residualsByHorizon) if (r && r.length) all.push.apply(all, r);
      if (all.length >= 3) {
        wfSigma = Math.sqrt(all.reduce((s, e) => s + e * e, 0) / all.length);
      }
    }

    for (let h = 0; h < horizon; h++) {
      let lo = null, hi = null;
      if (wf && wf.residualsByHorizon) {
        const pooled = _pooledResiduals(wf.residualsByHorizon, h, 5);
        if (pooled.length >= 3) {
          const qLo = _quantile(pooled, 0.10), qHi = _quantile(pooled, 0.90);
          lo = forecast[h] + (wfSigma != null ? Math.min(qLo, -1.282 * wfSigma) : qLo);
          hi = forecast[h] + (wfSigma != null ? Math.max(qHi,  1.282 * wfSigma) : qHi);
        }
      }
      if (lo == null) {   // Gaussian in-sample fallback
        const w = 1.282 * sigma * Math.sqrt(h + 1);
        lo = forecast[h] - w;
        hi = forecast[h] + w;
      }
      // Widen, never cross: 0 <= lower <= forecast <= upper.
      lower[h] = Math.max(0, Math.min(lo, forecast[h]));
      upper[h] = Math.max(hi, forecast[h]);
    }

    return {
      inSample : fit.inSample.map(v => (v == null ? null : round2(v))),
      forecast : forecast.map(round2),
      lower    : lower.map(round2),
      upper    : upper.map(round2),
      metrics,
      validation: wf
        ? { wape: wf.metrics.wape, mase: wf.metrics.mase, mae: wf.metrics.mae,
            rmse: wf.metrics.rmse, origins: wf.origins, horizon: wf.horizon }
        : null,
      autoParams: fit.autoParams,
      fallback : fit.fallback
    };
  }

  // ── Out-of-sample backtest (backward-compatible single split) ────────────────
  //
  //  Train on everything except the last `holdout` months, forecast them
  //  blind, score against actuals. Kept for API compatibility — walkForward
  //  is the richer multi-origin version of the same idea.

  function backtest(modelKey, data, params, holdout) {
    if (!data || data.length < 12) return null;
    const n = data.length;
    const h = holdout || Math.min(6, Math.max(3, Math.floor(n * 0.2)));
    if (n - h < 8) return null;

    const train  = data.slice(0, n - h);
    const actual = data.slice(n - h);

    let fit;
    try { fit = _fitModel(modelKey, train, params || {}, h); }
    catch (e) { return null; }

    const forecast = fit.forecast.map(v => round2(Math.max(0, v)));
    return {
      holdout : h,
      metrics : computeMetrics(actual, forecast),
      forecast,
      actual
    };
  }

  // ── Auto-select best model per SKU ───────────────────────────────────────────
  //
  //  Walk-forward-validates every registered model (including the ensemble)
  //  and ranks by WAPE ascending. Models that cannot be validated are skipped.

  function autoSelect(data, keys) {
    keys = keys || allKeys();
    const results = [];
    let origins = null, horizon = null;

    keys.forEach(k => {
      let wf = null;
      try { wf = walkForward(k, data, {}, { horizon: 6, maxOrigins: 8 }); }
      catch (e) { wf = null; }
      if (!wf || wf.metrics.wape == null) return;
      if (origins == null) { origins = wf.origins; horizon = wf.horizon; }
      results.push({
        model: k,
        name : MODEL_META[k].name,
        wape : wf.metrics.wape,
        mase : wf.metrics.mase,
        mae  : wf.metrics.mae
      });
    });

    results.sort((a, b) => a.wape - b.wape);
    return {
      best   : results.length ? results[0].model : null,
      origins: origins,
      horizon: horizon,
      results: results
    };
  }

  // ── Model registry ────────────────────────────────────────────────────────────

  const MODEL_META = {
    snaive: {
      name: 'Seasonal Naive', tag: 'sNaive', tagColor: '#94a3b8',
      fn: snaive,
      autopilot: false,
      params: [],
      explain: {
        title: 'Seasonal Naive',
        body: 'Forecasts each month as the <em>same month last year</em>, exactly. No parameters, no fitting — the honest benchmark floor. With strong annual seasonality this is surprisingly hard to beat, and any model ranked below it is adding noise, not signal.'
      }
    },
    ema: {
      name: 'Auto-tuned SES', tag: 'SES', tagColor: '#818cf8',
      fn: ema,
      autopilot: true,
      params: [],
      explain: {
        title: 'Auto-tuned Simple Exponential Smoothing',
        body: 'Exponentially weighted level with the smoothing factor α chosen automatically (grid 0.05–0.95, minimizing one-step squared error). No trend or seasonal components, so the forecast is flat — best for stable demand, and the universal fallback when history is too short for richer models.'
      }
    },
    theta: {
      name: 'Theta Method', tag: 'Theta', tagColor: '#22d3ee',
      fn: theta,
      autopilot: true,
      params: [],
      explain: {
        title: 'Theta Method',
        body: 'Winner of the M3 forecasting competition. When the lag-12 autocorrelation is statistically significant the series is first deseasonalized (multiplicative classical decomposition). The forecast averages a long-run linear trend line with an SES-smoothed short-run line, then is reseasonalized. Simple, fast and consistently accurate.'
      }
    },
    holtwinters: {
      name: 'Auto-ETS (Holt-Winters)', tag: 'Auto-ETS', tagColor: '#10b981',
      fn: holtwinters,
      autopilot: true,
      params: [],
      explain: {
        title: 'Auto-ETS — damped-trend Holt-Winters',
        body: 'Smooths level, trend and 12-month seasonality as separate components with a <em>damped</em> trend (no runaway linear extrapolation). The engine grid-searches ~2,500 configurations — α, β, γ, damping φ, and additive vs multiplicative seasonality — by one-step-ahead error. The flagship for trending, seasonal demand.'
      }
    },
    prophet: {
      name: 'Prophet (Harmonic Regression)', tag: 'Prophet', tagColor: '#a78bfa',
      fn: prophet,
      autopilot: true,
      params: [],
      explain: {
        title: 'Prophet-style harmonic regression',
        body: 'A Prophet-<em>style</em> structural regression (not Facebook Prophet): ridge-regularized trend + changepoint hinges + Fourier seasonal harmonics. Hyperparameters (changepoints × Fourier order × regularization λ) are validated by a mini walk-forward, and the trend is damped (φ = 0.9) when extrapolating beyond the history.'
      }
    },
    xgboost: {
      name: 'XGBoost (Global)', tag: 'XGBoost', tagColor: '#f59e0b',
      fn: xgboost,
      autopilot: true,
      params: [],
      explain: {
        title: 'Global gradient boosting',
        body: 'Gradient-boosted regression trees trained <em>across all SKUs at once</em> (scale-normalized), so each product borrows seasonal shape from the whole assortment. Features: lags 1/2/3/6/12, 3- and 12-month means, calendar-month sin/cos, and relative position. One direct model per forecast step — forecasts are never fed back into features.'
      }
    },
    ensemble: {
      name: 'Ensemble (Top-3 Blend)', tag: 'Blend', tagColor: '#f472b6',
      fn: ensemble,
      autopilot: true,
      params: [],
      explain: {
        title: 'Ensemble — top-3 blend',
        body: 'Walk-forward-validates every other model on this SKU, keeps the three with the lowest WAPE, and blends their forecasts with weights proportional to 1/WAPE. Combining diverse models usually beats any single one — the M-competitions\' most robust finding.'
      }
    }
  };

  function getMeta(modelKey) { return MODEL_META[modelKey] || null; }
  function allKeys()         { return Object.keys(MODEL_META); }

  return { run, getMeta, allKeys, backtest, autoSelect, walkForward, setGlobalSales, computeMetrics };

})();
