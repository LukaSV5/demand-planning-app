/**
 * app.js - Demand Forecasting view controller
 * Renamed from `app` → `ForecastView` to avoid collision with
 * dashboard.html's navigation `app` object.
 */

const ForecastView = (() => {

  let _selectedModel = null;
  let _initialized   = false;

  /* ── Init (lazy — called when Dashboard tab is opened) ── */
  function init() {
    if (_initialized) return;
    _initialized = true;
    ChartManager.init('main-chart');
    renderDataTable();
    updateStatCards();
    refreshChart();
  }

  /* ── Stat cards ── */
  function updateStatCards() {
    var stats  = DemandData.getSummaryStats();
    var labels = DemandData.getLabels();

    _setText('stat-total',     stats.total.toLocaleString());
    _setText('stat-total-sub', 'Last month: ' + stats.last.toLocaleString() + ' units');
    _setText('stat-avg',       Math.round(stats.avg).toLocaleString());
    _setText('stat-avg-sub',   'MoM change: ' + stats.momChange + '%');
    _setText('stat-peak',      stats.max.toLocaleString());
    _setText('stat-peak-sub',  labels[stats.maxIdx] || '');

    if (!_selectedModel) {
      _setText('stat-forecast',     '—');
      _setText('stat-forecast-sub', 'no model selected');
    }
    _setText('last-updated', 'Updated ' + new Date().toLocaleTimeString());
  }

  /* ── Editable data table ── */
  function renderDataTable() {
    var tbody  = document.getElementById('data-table-body');
    if (!tbody) return;
    var vals   = DemandData.getValues();
    var labels = DemandData.getLabels();
    var rows   = [];

    for (var i = 0; i < vals.length; i++) {
      var prev       = i > 0 ? vals[i - 1] : null;
      var delta      = prev != null ? vals[i] - prev : null;
      var pct        = prev != null && prev !== 0 ? ((delta / prev) * 100).toFixed(1) : null;
      var arrow      = delta == null ? '' : delta > 0 ? '▲' : delta < 0 ? '▼' : '—';
      var deltaStr   = delta != null ? arrow + ' ' + Math.abs(delta).toLocaleString() + ' (' + pct + '%)' : '—';
      var deltaColor = delta == null ? '#4b5563' : delta > 0 ? '#22c55e' : delta < 0 ? '#ef4444' : '#4b5563';

      rows.push(
        '<tr>' +
        '<td style="font-family:monospace;font-size:10px;color:var(--text-3);padding:5px 10px;">' +
          String(i + 1).padStart(2, '0') +
        '</td>' +
        '<td style="font-weight:500;color:#9ca3af;padding:5px 10px;white-space:nowrap;">' + labels[i] + '</td>' +
        '<td style="text-align:right;padding:3px 10px;">' +
          '<input type="number" value="' + vals[i] + '" min="0" data-idx="' + i + '"' +
          ' onchange="ForecastView.onCellChange(this)" onblur="ForecastView.onCellChange(this)">' +
        '</td>' +
        '<td style="text-align:right;font-size:10px;color:' + deltaColor + ';padding:5px 10px;white-space:nowrap;">' +
          deltaStr +
        '</td>' +
        '</tr>'
      );
    }

    tbody.innerHTML = rows.join('');
  }

  function onCellChange(input) {
    var idx = parseInt(input.dataset.idx, 10);
    var val = parseFloat(input.value);
    if (!isNaN(val)) {
      DemandData.setValue(idx, val);
      input.value = DemandData.getValues()[idx];
      refreshChart();
      updateStatCards();
    }
  }

  /* ── Model selection ── */
  var MODEL_LABELS = {
    sma:     'Simple Moving Average (SMA)',
    wma:     'Weighted Moving Average (WMA)',
    ema:     'Exponential Smoothing (EMA)',
    sarimax: 'SARIMAX (Seasonal ARIMA)',
    prophet: 'Prophet (JS)',
    xgboost: 'XGBoost (Gradient Boosted Trees)'
  };

  function selectModel(key) {
    _selectedModel = key;
    /* Toggle active pill — pills are identified by data-model attribute, not by id */
    document.querySelectorAll('.fc-mpill').forEach(function(el) {
      el.classList.toggle('active', el.dataset.model === key);
    });
    _setText('selected-model-label', MODEL_LABELS[key] || key);
    refreshChart();
    updateStatCards();
  }

  /* ── Presets / randomize ── */
  function loadPreset(name) {
    DemandData.loadPreset(name);
    renderDataTable();
    updateStatCards();
    refreshChart();
  }

  function randomize() {
    DemandData.randomize();
    renderDataTable();
    updateStatCards();
    refreshChart();
  }

  /* ── Forecast label generator ── */
  function generateForecastLabels(lastLabel, count) {
    var MONTHS = DemandData.MONTH_NAMES;
    var parts  = (lastLabel || '').split(' ');
    var month  = MONTHS.indexOf(parts[0]);
    var year   = parseInt(parts[1]) || 2024;
    var out    = [];
    for (var i = 0; i < count; i++) {
      month++;
      if (month >= 12) { month = 0; year++; }
      out.push(MONTHS[month] + ' ' + year);
    }
    return out;
  }

  /* ── Chart refresh — runs the selected model if one is active ── */
  function refreshChart() {
    var labels = DemandData.getLabels();
    var values = DemandData.getValues();

    if (_selectedModel && typeof Models !== 'undefined') {
      var meta   = Models.getMeta(_selectedModel);
      var params = {};
      if (meta && meta.params) {
        meta.params.forEach(function(p) { params[p.id] = p.default; });
      }
      var result  = Models.run(_selectedModel, values, params, 6);
      var fLabels = generateForecastLabels(labels[labels.length - 1], 6);

      ChartManager.update(labels, values, result.inSample, fLabels, result.forecast);

      /* Update model metrics in stat card */
      var m       = result.metrics;
      var mapeStr = m.mape != null ? m.mape + '%' : '—';
      _setText('stat-forecast',     _selectedModel.toUpperCase());
      _setText('stat-forecast-sub', 'MAPE ' + mapeStr + '  ·  RMSE ' + (m.rmse || '—'));
    } else {
      ChartManager.update(labels, values, null, null, null);
    }
  }

  /* ── Chart controls ── */
  function resetZoom()   { ChartManager.resetZoom(); }
  function exportChart() { ChartManager.exportPNG(); }

  /* ── Utility ── */
  function _setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  return { init, onCellChange, selectModel, loadPreset, randomize, resetZoom, exportChart };

})();
