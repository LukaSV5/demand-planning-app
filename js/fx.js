/* fx.js — one currency table for the whole site (dashboard + warehouse).
   Supplier prices and PO values come in EUR / GBP / USD; every total is
   shown in USD. Rates: ECB euro reference rates, 2 Oct 2026
   (EUR/USD 1.1225, EUR/GBP 0.85033 → GBP/USD 1.3201). Edit to update. */
window.FX = (function () {
  var TO_USD = { USD: 1, EUR: 1.1225, GBP: 1.3201 };
  var unknown = {};
  function toUSD(v, cur) {
    cur = String(cur || 'USD').trim().toUpperCase();
    if (TO_USD[cur] == null) { unknown[cur] = 1; return v; }   /* unknown: left unconverted, flagged */
    return v * TO_USD[cur];
  }
  return { TO_USD: TO_USD, toUSD: toUSD, unknown: unknown, asOf: '2 Oct 2026', note: 'EUR/GBP converted at ECB rates of 2 Oct 2026' };
})();
