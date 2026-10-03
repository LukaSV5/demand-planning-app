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
        if (!series || !series.values || series.values.length < 3) {
          postMessage({ type: 'skuError', sku: sku, message: 'insufficient history' });
          continue;
        }
        // Models.route picks the model (walk-forward), runs it, and falls back
        // to Theta / seasonal naive when the series is too short to validate.
        var out = Models.route(series.values, series.months);
        out.type = 'routed';
        out.sku  = sku;
        postMessage(out);
        count++;
      } catch (err) {
        postMessage({ type: 'skuError', sku: sku, message: String(err && err.message || err) });
      }
    }
    postMessage({ type: 'done', count: count });
  }
};
