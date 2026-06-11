/**
 * forecast-worker.js — off-main-thread per-SKU model routing.
 *
 * Protocol (postMessage):
 *   in : { type:'init', bySKU }          — store data, feed the global XGBoost pool
 *   in : { type:'route', skus: [...] }   — autoSelect + best-model run per SKU
 *   out: { type:'ready' }
 *   out: { type:'routed', sku, sel, best, name, tag, tagColor,
 *          wape, mase, forecast, lower, upper, horizon }   — one per SKU
 *   out: { type:'done', count }
 *   out: { type:'skuError', sku, message }
 */
importScripts('models.js');

var _bySKU = null;

onmessage = function (e) {
  var msg = e.data || {};

  if (msg.type === 'init') {
    _bySKU = msg.bySKU || {};
    Models.setGlobalSales(_bySKU);
    postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'route') {
    var skus = msg.skus || Object.keys(_bySKU || {});
    var count = 0;
    for (var i = 0; i < skus.length; i++) {
      var sku = skus[i];
      try {
        var series = _bySKU[sku];
        if (!series || !series.values || series.values.length < 12) {
          postMessage({ type: 'skuError', sku: sku, message: 'insufficient history' });
          continue;
        }
        var sel = Models.autoSelect(series.values);
        if (!sel || !sel.best) {
          postMessage({ type: 'skuError', sku: sku, message: 'no model could be validated' });
          continue;
        }
        // Walk-forward results are memoized inside Models, so re-running the
        // winner here for its forecast + intervals costs only the final fit.
        var run  = Models.run(sel.best, series.values, {}, sel.horizon || 6);
        var meta = Models.getMeta(sel.best) || {};
        var top  = sel.results[0] || {};
        postMessage({
          type: 'routed', sku: sku, sel: sel,
          best: sel.best, name: meta.name || sel.best,
          tag: meta.tag || sel.best, tagColor: meta.tagColor || '#a78bfa',
          wape: top.wape, mase: top.mase,
          forecast: run.forecast, lower: run.lower, upper: run.upper,
          horizon: sel.horizon || 6
        });
        count++;
      } catch (err) {
        postMessage({ type: 'skuError', sku: sku, message: String(err && err.message || err) });
      }
    }
    postMessage({ type: 'done', count: count });
  }
};
