/**
 * models.js — Demand forecasting model implementations
 *
 * Each model returns:
 *   {
 *     inSample   : number[]   — fitted values aligned with historical data
 *     forecast   : number[]   — future predicted values (length = horizon)
 *     metrics    : { mae, rmse, mape }
 *     autoParams : object     — best params found by grid search (autopilot only)
 *     spikeInfo  : object     — spike detection report (autopilot only)
 *   }
 *
 * Autopilot mode (Prophet & XGBoost):
 *   Pass params.__autopilot = true to Models.run().
 *   The engine will:
 *     1. Clean promotional / anomaly spikes via IQR fencing
 *     2. Grid-search optimal hyperparameters on a held-out validation split
 *     3. Re-train on the full cleaned series with the winning config
 */

const Models = (() => {

  // ── Utility ──────────────────────────────────────────────────────────────────

  function round2(n) { return Math.round(n * 100) / 100; }

  function _mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }

  function computeMetrics(actual, fitted) {
    let sumAbs = 0, sumSq = 0, sumPct = 0, n = 0;
    for (let i = 0; i < actual.length; i++) {
      if (fitted[i] == null || actual[i] == null || actual[i] === 0) continue;
      const err = actual[i] - fitted[i];
      sumAbs += Math.abs(err);
      sumSq  += err * err;
      sumPct += Math.abs(err / actual[i]);
      n++;
    }
    if (n === 0) return { mae: null, rmse: null, mape: null };
    return {
      mae  : round2(sumAbs / n),
      rmse : round2(Math.sqrt(sumSq / n)),
      mape : round2((sumPct / n) * 100)
    };
  }

  // ── Spike / anomaly detection & cleaning ─────────────────────────────────────
  //
  //  Uses Tukey's IQR fence: anything above Q3 + 1.5×IQR is capped to that fence.
  //  Returns { cleaned, spikes[], upper, q1, q3, iqr }

  function _cleanSpikes(data) {
    const sorted = data.slice().sort((a, b) => a - b);
    const n      = sorted.length;
    const q1     = sorted[Math.floor(n * 0.25)];
    const q3     = sorted[Math.floor(n * 0.75)];
    const iqr    = q3 - q1;
    const upper  = q3 + 1.5 * iqr;
    const lower  = q1 - 1.5 * iqr;

    const spikes  = [];
    const cleaned = data.map((v, i) => {
      if (iqr > 0 && v > upper) { spikes.push({ idx: i, original: v, capped: round2(upper) }); return upper; }
      if (iqr > 0 && v < lower && v >= 0) { return lower > 0 ? lower : 0; }
      return v;
    });
    return { cleaned, spikes, upper: round2(upper), lower: round2(lower), q1: round2(q1), q3: round2(q3), iqr: round2(iqr) };
  }

  // ── MAE helper for grid search ────────────────────────────────────────────────

  function _mae(actual, predicted) {
    let s = 0, n = 0;
    for (let i = 0; i < actual.length; i++) {
      if (predicted[i] == null) continue;
      s += Math.abs(actual[i] - predicted[i]);
      n++;
    }
    return n > 0 ? s / n : Infinity;
  }

  // ── 1. Simple Moving Average (SMA) ───────────────────────────────────────────

  function sma(data, { window: w = 3 } = {}, horizon = 6) {
    const n   = data.length;
    const inS = new Array(n).fill(null);
    for (let i = w; i < n; i++) {
      inS[i] = round2(data.slice(i - w, i).reduce((a, b) => a + b, 0) / w);
    }
    const buf = data.slice(-w);
    const forecast = [];
    for (let f = 0; f < horizon; f++) {
      const val = round2(buf.reduce((a, b) => a + b, 0) / w);
      forecast.push(val); buf.shift(); buf.push(val);
    }
    return { inSample: inS, forecast, metrics: computeMetrics(data, inS) };
  }

  // ── 2. Weighted Moving Average (WMA) ─────────────────────────────────────────

  function wma(data, { window: w = 3 } = {}, horizon = 6) {
    const n       = data.length;
    const inS     = new Array(n).fill(null);
    const weights = Array.from({ length: w }, (_, i) => i + 1);
    const wSum    = weights.reduce((a, b) => a + b, 0);
    const apply   = slice => round2(slice.reduce((acc, v, i) => acc + v * weights[i], 0) / wSum);
    for (let i = w; i < n; i++) inS[i] = apply(data.slice(i - w, i));
    const buf = data.slice(-w);
    const forecast = [];
    for (let f = 0; f < horizon; f++) {
      const val = apply(buf);
      forecast.push(val); buf.shift(); buf.push(val);
    }
    return { inSample: inS, forecast, metrics: computeMetrics(data, inS) };
  }

  // ── 3. Exponential Smoothing (EMA) ───────────────────────────────────────────

  function ema(data, { alpha = 0.3 } = {}, horizon = 6) {
    const n   = data.length;
    const inS = new Array(n).fill(null);
    let level = data[0];
    inS[0] = round2(level);
    for (let i = 1; i < n; i++) {
      level = round2(alpha * data[i] + (1 - alpha) * level);
      inS[i] = level;
    }
    return {
      inSample: inS,
      forecast: Array(horizon).fill(round2(level)),
      metrics:  computeMetrics(data, inS)
    };
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

  // ── 4. SARIMAX ───────────────────────────────────────────────────────────────

  function sarimax(data, params = {}, horizon = 6) {
    const p = Math.max(1, Math.min(params.ar_order    || 2,  4));
    const s = Math.max(2, Math.min(params.seasonality || 12, 24));
    const n = data.length;
    const start = s + 1;

    const w = [];
    for (let t = start; t < n; t++) {
      w.push(data[t] - data[t - 1] - data[t - s] + data[t - s - 1]);
    }

    const wLen = w.length;
    const X = [], yVec = [];
    for (let t = p; t < wLen; t++) {
      X.push(Array.from({ length: p }, (_, k) => w[t - 1 - k]));
      yVec.push(w[t]);
    }

    let beta;
    try {
      beta = (X.length >= p + 1) ? ols(X, yVec, 1e-4) : new Array(p).fill(0);
    } catch (e) {
      beta = new Array(p).fill(0);
    }

    const inS = new Array(n).fill(null);
    for (let t = start + p; t < n; t++) {
      const wIdx = t - start;
      const wFit = beta.reduce((s, b, k) => s + b * w[wIdx - 1 - k], 0);
      inS[t] = round2(Math.max(0, wFit + data[t - 1] + data[t - s] - data[t - s - 1]));
    }

    const buf = data.slice();
    const wBuf = w.slice();
    const forecast = [];
    for (let h = 0; h < horizon; h++) {
      const t = n + h;
      const wPred = beta.reduce((s, b, k) => {
        const idx = wBuf.length - 1 - k;
        return s + b * (idx >= 0 ? wBuf[idx] : 0);
      }, 0);
      const yPred = Math.max(0, wPred + buf[t - 1] + buf[t - s] - buf[t - s - 1]);
      forecast.push(round2(yPred));
      buf.push(yPred);
      wBuf.push(wPred);
    }

    return { inSample: inS, forecast, metrics: computeMetrics(data, inS) };
  }

  // ── 5. Prophet (JS) ──────────────────────────────────────────────────────────

  function _prophetRow(t, P, N, changepoints) {
    const a = changepoints.map(cp => (t >= cp ? t - cp : 0));
    const fourier = [];
    for (let n = 1; n <= N; n++) {
      fourier.push(Math.cos(2 * Math.PI * n * t / P));
      fourier.push(Math.sin(2 * Math.PI * n * t / P));
    }
    return [1, t, ...a, ...fourier];
  }

  function prophet(data, params = {}, horizon = 6) {
    const P   = Math.max(2, Math.min(params.seasonality_period || 12, 24));
    const N   = Math.max(1, Math.min(params.fourier_order      || 5,  10));
    const nCp = Math.max(0, Math.min(params.changepoints       || 3,   8));
    const T   = data.length;

    const changepoints = Array.from({ length: nCp }, (_, i) =>
      Math.floor((i + 1) * T * 0.8 / (nCp + 1)));

    const X = Array.from({ length: T }, (_, t) => _prophetRow(t, P, N, changepoints));
    let beta;
    try   { beta = ols(X, data, 1e-3); }
    catch (e) { beta = new Array(X[0].length).fill(0); }

    const inS = X.map(row =>
      round2(Math.max(0, row.reduce((s, v, i) => s + v * beta[i], 0))));

    const forecast = [];
    for (let h = 0; h < horizon; h++) {
      const row = _prophetRow(T + h, P, N, changepoints);
      forecast.push(round2(Math.max(0, row.reduce((s, v, i) => s + v * beta[i], 0))));
    }

    return { inSample: inS, forecast, metrics: computeMetrics(data, inS) };
  }

  // ── Prophet grid search ───────────────────────────────────────────────────────
  //
  //  Evaluates 9 combos (3 changepoint × 3 fourier) on a held-out validation
  //  split (last 20% of data, min 2 months). Returns the winning params.

  function _gridSearchProphet(data, horizon) {
    const split = Math.max(6, Math.floor(data.length * 0.8));
    const train = data.slice(0, split);
    const val   = data.slice(split);

    // Not enough data to grid search — return sensible defaults
    if (val.length < 2 || train.length < 8) {
      return { seasonality_period: 12, fourier_order: 5, changepoints: 3,
               _gridMAE: null, _gridWinner: 'default' };
    }

    const cpCandidates = [1, 3, 6];
    const foCandidates = [3, 5, 8];
    let bestMAE = Infinity, bestParams = null;
    const trials = [];

    for (const cp of cpCandidates) {
      for (const fo of foCandidates) {
        try {
          const res = prophet(train, { seasonality_period: 12, fourier_order: fo, changepoints: cp }, val.length);
          const mae = _mae(val, res.forecast);
          trials.push({ cp, fo, mae: round2(mae) });
          if (mae < bestMAE) {
            bestMAE = mae;
            bestParams = { seasonality_period: 12, fourier_order: fo, changepoints: cp };
          }
        } catch (e) { /* skip failed combos */ }
      }
    }

    return {
      ...(bestParams || { seasonality_period: 12, fourier_order: 5, changepoints: 3 }),
      _gridMAE: round2(bestMAE),
      _gridTrials: trials
    };
  }

  // ── 6. XGBoost (gradient boosted regression trees) ───────────────────────────

  function _xgbFeatures(buf, t, lags) {
    const feat = [];
    for (const lag of lags) {
      feat.push(t - lag >= 0 ? buf[t - lag] : _mean(buf.slice(0, Math.max(1, t))));
    }
    feat.push(t % 12);
    feat.push(Math.floor((t % 12) / 3));
    feat.push(Math.floor(t / 12));
    return feat;
  }

  function _buildTree(X, r, maxDepth, depth) {
    const n = X.length;
    const mean = r.reduce((s, v) => s + v, 0) / n;
    if (depth >= maxDepth || n <= 2) return { leaf: true, value: mean };

    let bestScore = Infinity, bestFeat = -1, bestThresh = 0;
    const nFeat = X[0].length;

    for (let f = 0; f < nFeat; f++) {
      const vals = [...new Set(X.map(row => row[f]))].sort((a, b) => a - b);
      for (let v = 0; v < vals.length - 1; v++) {
        const thresh = (vals[v] + vals[v + 1]) / 2;
        const left = [], right = [];
        X.forEach((row, i) => (row[f] <= thresh ? left : right).push(r[i]));
        if (!left.length || !right.length) continue;
        const lM = left.reduce((s, v) => s + v, 0)  / left.length;
        const rM = right.reduce((s, v) => s + v, 0) / right.length;
        const score = left.reduce((s, v) => s + (v - lM) ** 2, 0) +
                      right.reduce((s, v) => s + (v - rM) ** 2, 0);
        if (score < bestScore) { bestScore = score; bestFeat = f; bestThresh = thresh; }
      }
    }

    if (bestFeat < 0) return { leaf: true, value: mean };

    const lX = [], lR = [], rX = [], rR = [];
    X.forEach((row, i) => {
      if (row[bestFeat] <= bestThresh) { lX.push(row); lR.push(r[i]); }
      else                             { rX.push(row); rR.push(r[i]); }
    });

    return {
      leaf: false, feat: bestFeat, thresh: bestThresh,
      left:  _buildTree(lX, lR, maxDepth, depth + 1),
      right: _buildTree(rX, rR, maxDepth, depth + 1)
    };
  }

  function _predictTree(node, x) {
    if (node.leaf) return node.value;
    return x[node.feat] <= node.thresh
      ? _predictTree(node.left, x)
      : _predictTree(node.right, x);
  }

  function xgboost(data, params = {}, horizon = 6) {
    const nTrees   = Math.max(10, Math.min(params.n_estimators  || 50,  200));
    const lr       = Math.max(0.01, Math.min(params.learning_rate || 0.1, 0.5));
    const maxDepth = Math.max(1, Math.min(params.max_depth       || 3,   5));
    const lags     = [1, 2, 3, 6, 12];
    const minLag   = 12;
    const T = data.length;
    if (T <= minLag) {
      console.warn('[XGBoost] Only ' + T + ' data points — minimum is ' + (minLag+1) + '. Falling back to SMA.');
      return sma(data, {}, horizon);
    }

    const X = [], y = [];
    for (let t = minLag; t < T; t++) {
      X.push(_xgbFeatures(data, t, lags));
      y.push(data[t]);
    }

    const basePred = _mean(y);
    const trees = [];
    let residuals = y.map(v => v - basePred);

    for (let iter = 0; iter < nTrees; iter++) {
      const tree = _buildTree(X, residuals, maxDepth, 0);
      trees.push(tree);
      residuals = residuals.map((r, i) => r - lr * _predictTree(tree, X[i]));
    }

    function predict(feat) {
      return Math.max(0, basePred + lr * trees.reduce((s, t) => s + _predictTree(t, feat), 0));
    }

    const inS = new Array(T).fill(null);
    for (let t = minLag; t < T; t++) {
      inS[t] = round2(predict(_xgbFeatures(data, t, lags)));
    }

    const buf = data.slice();
    const forecast = [];
    for (let h = 0; h < horizon; h++) {
      const feat = _xgbFeatures(buf, buf.length, lags);
      const val  = round2(predict(feat));
      forecast.push(val);
      buf.push(val);
    }

    return { inSample: inS, forecast, metrics: computeMetrics(data, inS) };
  }

  // ── XGBoost grid search ───────────────────────────────────────────────────────
  //
  //  Evaluates 6 combos (3 lr × 2 depth) on a held-out validation split.
  //  Uses only 20 trees during search for speed; final run uses 80.

  function _gridSearchXGBoost(data, horizon) {
    const split = Math.max(13, Math.floor(data.length * 0.8));
    const train = data.slice(0, split);
    const val   = data.slice(split);

    if (val.length < 2 || train.length <= 12) {
      return { n_estimators: 80, learning_rate: 0.1, max_depth: 3,
               _gridMAE: null, _gridWinner: 'default' };
    }

    const lrCandidates    = [0.05, 0.1, 0.2];
    const depthCandidates = [2, 3];
    let bestMAE = Infinity, bestParams = null;
    const trials = [];

    for (const lr of lrCandidates) {
      for (const d of depthCandidates) {
        try {
          const res = xgboost(train, { n_estimators: 20, learning_rate: lr, max_depth: d }, val.length);
          const mae = _mae(val, res.forecast);
          trials.push({ lr, depth: d, mae: round2(mae) });
          if (mae < bestMAE) {
            bestMAE = mae;
            bestParams = { n_estimators: 80, learning_rate: lr, max_depth: d };
          }
        } catch (e) { /* skip */ }
      }
    }

    return {
      ...(bestParams || { n_estimators: 80, learning_rate: 0.1, max_depth: 3 }),
      _gridMAE: round2(bestMAE),
      _gridTrials: trials
    };
  }

  // ── Model registry ────────────────────────────────────────────────────────────

  const MODEL_META = {
    sma: {
      name: 'Simple Moving Average', tag: 'SMA', tagColor: '#94a3b8',
      fn: sma,
      autopilot: false,
      params: [
        { id: 'window', label: 'Window (periods)', type: 'number', min: 2, max: 24, default: 3,
          help: 'Number of past periods to average. Larger = smoother but lags trends more.' }
      ],
      explain: {
        title: 'Simple Moving Average (SMA)',
        body: 'Averages the last <em>n</em> periods equally. Best for stable, low-noise demand.'
      }
    },
    wma: {
      name: 'Weighted Moving Average', tag: 'WMA', tagColor: '#a78bfa',
      fn: wma,
      autopilot: false,
      params: [
        { id: 'window', label: 'Window (periods)', type: 'number', min: 2, max: 24, default: 4,
          help: 'More recent periods get higher weight (linear decay). Reacts faster than SMA.' }
      ],
      explain: {
        title: 'Weighted Moving Average (WMA)',
        body: 'Like SMA but assigns <em>linearly increasing weights</em>. Reacts faster to recent demand shifts.'
      }
    },
    ema: {
      name: 'Exponential Smoothing', tag: 'EMA', tagColor: '#818cf8',
      fn: ema,
      autopilot: false,
      params: [
        { id: 'alpha', label: 'Smoothing Factor (α)', type: 'range', min: 0.05, max: 0.95, step: 0.05, default: 0.3,
          leftLabel: 'Stable', rightLabel: 'Reactive',
          help: 'Low α = smooth and slow. High α = reacts instantly to every spike.' }
      ],
      explain: {
        title: 'Exponential Smoothing (EMA)',
        body: 'Exponentially decreasing weights across all past data. α controls the speed of adaptation.'
      }
    },
    sarimax: {
      name: 'SARIMAX', tag: 'SARIMAX', tagColor: '#0ea5e9',
      fn: sarimax,
      autopilot: false,
      params: [
        { id: 'ar_order',    label: 'AR Order (p)',       type: 'number', min: 1, max: 4,  default: 2,
          help: 'Autoregressive lags. 1–3 works for most demand patterns.' },
        { id: 'seasonality', label: 'Seasonal Period (s)', type: 'select', default: 12,
          options: [
            { value: 4,  label: 'Quarterly (4)' },
            { value: 12, label: 'Annual monthly (12)' },
            { value: 6,  label: 'Semi-annual (6)' }
          ],
          help: 'Length of one seasonal cycle. 12 for monthly data with annual seasonality.' }
      ],
      explain: {
        title: 'SARIMAX (Seasonal ARIMA)',
        body: 'Seasonal + non-seasonal differencing removes trend, then AR model fits stationary residuals. Strong for clear annual demand cycles.'
      }
    },
    prophet: {
      name: 'Prophet', tag: 'Prophet', tagColor: '#10b981',
      fn: prophet,
      autopilot: true,
      autopilotLabel: 'Prophet Autopilot',
      autopilotColor: '#10b981',
      params: [],
      explain: {
        title: 'Prophet — AI Autopilot',
        body: 'Grid-searches 9 configurations across changepoint flexibility and Fourier seasonality complexity. Auto-detects and caps promotional spikes before fitting.'
      }
    },
    xgboost: {
      name: 'XGBoost', tag: 'XGBoost', tagColor: '#f59e0b',
      fn: xgboost,
      autopilot: true,
      autopilotLabel: 'XGBoost Autopilot',
      autopilotColor: '#f59e0b',
      params: [],
      explain: {
        title: 'XGBoost — AI Autopilot',
        body: 'Grid-searches 6 configurations across learning rate and tree depth. Auto-detects and caps promotional spikes, then trains on cleaned data with the winning config.'
      }
    }
  };

  // ── Public API ────────────────────────────────────────────────────────────────

  function run(modelKey, data, params, horizon) {
    params  = params  || {};
    horizon = horizon || 6;

    const meta = MODEL_META[modelKey];
    if (!meta) throw new Error('Unknown model: ' + modelKey);
    if (!data || data.length < 3) {
      return { inSample: [], forecast: Array(horizon).fill(0),
               metrics: { mae: null, rmse: null, mape: null } };
    }

    const autopilot = params.__autopilot || meta.autopilot;
    let workingData = data;
    let spikeInfo   = null;
    let autoParams  = params;

    if (autopilot && (modelKey === 'prophet' || modelKey === 'xgboost')) {
      // Step 1 — clean spikes
      const cleaned = _cleanSpikes(data);
      workingData = cleaned.cleaned;
      spikeInfo   = cleaned;

      // Step 2 — grid search best hyperparameters
      autoParams = modelKey === 'xgboost'
        ? _gridSearchXGBoost(workingData, horizon)
        : _gridSearchProphet(workingData, horizon);
    }

    const result = meta.fn(workingData, autoParams, horizon);
    result.autoParams = autoParams;
    result.spikeInfo  = spikeInfo;
    return result;
  }

  function getMeta(modelKey) { return MODEL_META[modelKey] || null; }
  function allKeys()         { return Object.keys(MODEL_META); }

  return { run, getMeta, allKeys };

})();
