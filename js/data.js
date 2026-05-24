/**
 * data.js — Mock sales data & preset generators
 * All data is stored in memory; no backend needed.
 */

const DemandData = (() => {

  // ── Month label helpers ─────────────────────────────────────────────────────

  const MONTH_NAMES = [
    'Jan','Feb','Mar','Apr','May','Jun',
    'Jul','Aug','Sep','Oct','Nov','Dec'
  ];

  function generateLabels(startYear = 2023, count = 24) {
    const labels = [];
    let year = startYear;
    let month = 0; // 0-indexed
    for (let i = 0; i < count; i++) {
      labels.push(`${MONTH_NAMES[month]} ${year}`);
      month++;
      if (month === 12) { month = 0; year++; }
    }
    return labels;
  }

  // ── Preset data patterns ────────────────────────────────────────────────────

  /**
   * Seasonal pattern — peaks in summer & winter holiday season.
   * Mimics a consumer goods product.
   */
  const SEASONAL = [
    820, 740, 890, 970, 1050, 1320,   // Jan–Jun 2023
    1480, 1390, 1100, 980,  1240, 1680, // Jul–Dec 2023
    850, 770, 910, 1010, 1090, 1360,   // Jan–Jun 2024
    1520, 1430, 1140, 1010, 1280, 1720  // Jul–Dec 2024
  ];

  /**
   * Upward trend with slight noise — like a growing SaaS product.
   */
  const TREND = [
    500, 530, 555, 580, 610, 640,
    670, 700, 735, 760, 800, 840,
    880, 920, 960, 1005, 1050, 1100,
    1155, 1210, 1270, 1335, 1400, 1470
  ];

  /**
   * Flat / stable demand with small random noise — commodity product.
   */
  const FLAT = [
    1000, 1015, 985, 1020, 995, 1010,
    990, 1025, 1005, 980, 1015, 1000,
    1010, 990, 1005, 1020, 980, 1010,
    995, 1015, 985, 1000, 1020, 995
  ];

  // ── State ───────────────────────────────────────────────────────────────────

  let _data = [...SEASONAL];
  let _labels = generateLabels(2023, 24);

  // ── Public API ──────────────────────────────────────────────────────────────

  function getValues() { return [..._data]; }
  function getLabels() { return [..._labels]; }
  function getCount()  { return _data.length; }

  function setValue(index, value) {
    if (index >= 0 && index < _data.length) {
      _data[index] = Math.max(0, Math.round(value));
    }
  }

  function loadPreset(name) {
    const presets = { seasonal: SEASONAL, trend: TREND, flat: FLAT };
    if (presets[name]) {
      _data = [...presets[name]];
      return true;
    }
    return false;
  }

  function randomize() {
    // Random walk with mean reversion
    const base = 900 + Math.random() * 400;
    _data = [];
    let current = base;
    for (let i = 0; i < 24; i++) {
      const seasonalFactor = 1 + 0.25 * Math.sin((i / 12) * 2 * Math.PI - Math.PI / 2);
      const noise = (Math.random() - 0.5) * base * 0.15;
      const meanReversion = (base - current) * 0.1;
      current = Math.max(100, Math.round(current * seasonalFactor + noise + meanReversion));
      _data.push(current);
      // reset current for next step to avoid drift
      current = base + (Math.random() - 0.5) * base * 0.2;
    }
  }

  function getSummaryStats() {
    const vals = getValues();
    const total = vals.reduce((a, b) => a + b, 0);
    const avg   = total / vals.length;
    const max   = Math.max(...vals);
    const maxIdx = vals.indexOf(max);
    const min   = Math.min(...vals);
    const last  = vals[vals.length - 1];
    const prev  = vals[vals.length - 2];
    const momChange = prev > 0 ? ((last - prev) / prev * 100).toFixed(1) : '—';

    return { total, avg, max, maxIdx, min, last, momChange };
  }

  return {
    getValues, getLabels, getCount,
    setValue, loadPreset, randomize,
    getSummaryStats, generateLabels,
    MONTH_NAMES
  };

})();
