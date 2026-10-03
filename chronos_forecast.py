"""
chronos_forecast.py - Chronos-2 helpers shared by chronos_server.py.

The dashboard gets Chronos forecasts live from chronos_server.py (which
imports load_pipeline / predict_batch from this file), so you normally do
NOT need to run this script.

One-time setup (on a machine with internet access):
    py -m pip install torch pandas "chronos-forecasting>=2.0"

Optional offline batch mode: forecast every SKU in a sales CSV and write the
results to a JS file. The current dashboard does not load that file; it is
kept only for experiments.
    py chronos_forecast.py --check            (count series, no model)
    py chronos_forecast.py --out chronos_batch.js

Options:
    --csv    sales history file      (default sales_history.csv)
    --out    output JS file          (default chronos_batch.js)
    --model  Hugging Face model id   (default amazon/chronos-2)
    --device cpu | cuda | auto       (default cpu)
"""

import argparse
import json
import math
import sys
import time
from collections import defaultdict

import pandas as pd

HORIZON = 12                 # dashboard offers 3 / 6 / 12 months
TAILS = [0, 24, 12]          # "Full history" / "Last 24" / "Last 12" in the UI
QUANTILES = [0.1, 0.5, 0.9]


# ── Same logic as the dashboard / Models.backtest ───────────────────────────

def holdout_for(n):
    """Mirror of Models.backtest(): returns None when no backtest is run."""
    if n < 12:
        return None
    h = min(6, max(3, math.floor(n * 0.2)))
    return h if n - h >= 8 else None


def fmt(v):
    """Mirror of JS String(Math.round(v*100)/100): round half UP (JS), not
    half-to-even (Python's round), so 0.125 -> "0.13" in both."""
    v = math.floor(float(v) * 100 + 0.5) / 100 + 0.0
    return str(int(v)) if v == int(v) else repr(v)


def fingerprint(values):
    s = ",".join(fmt(v) for v in values)
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{len(values)}:{h:08x}"


def monthly_series(csv_path):
    """Units per SKU per month, exactly like the dashboard's CSV loader."""
    df = pd.read_csv(csv_path, usecols=["StockCode", "Quantity", "InvoiceDate"],
                     dtype={"StockCode": str, "InvoiceDate": str})
    df["Quantity"] = pd.to_numeric(df["Quantity"], errors="coerce").fillna(0)
    df = df[df["Quantity"] > 0]
    df["month"] = df["InvoiceDate"].str.strip().str[:7]
    df = df[df["month"].str.match(r"^\d{4}-\d{2}$", na=False)]
    grouped = df.groupby(["StockCode", "month"], sort=True)["Quantity"].sum()
    if grouped.empty:
        return {}
    # Like the dashboard: each SKU runs from its first sale to the dataset's
    # last month, with months without sales filled with 0.
    last = grouped.index.get_level_values(1).max()
    by_sku = defaultdict(dict)
    for (sku, month), qty in grouped.items():
        by_sku[sku][month] = float(qty)
    out = {}
    for sku, months in by_sku.items():
        rng = pd.period_range(min(months), last, freq="M").strftime("%Y-%m")
        out[sku] = [months.get(m, 0.0) for m in rng]
    return out


def collect_jobs(series_by_sku):
    """All distinct series that need a forecast, keyed by fingerprint."""
    jobs = {}
    for values in series_by_sku.values():
        for tail in TAILS:
            window = values[-tail:] if tail and len(values) > tail else values
            if len(window) >= 3:
                jobs.setdefault(fingerprint(window), window)
            h = holdout_for(len(window))
            if h:
                train = window[:-h]
                jobs.setdefault(fingerprint(train), train)
    return jobs


# ── Chronos-2 inference ─────────────────────────────────────────────────────

def load_pipeline(model_id, device):
    from chronos import Chronos2Pipeline
    print(f"Loading {model_id} on {device} ...")
    return Chronos2Pipeline.from_pretrained(model_id, device_map=device)


def predict_batch(pipeline, series_list):
    """Forecast a list of number-lists. Returns [{p10, p50, p90}, ...] in order."""
    import numpy as np
    import torch

    inputs = [torch.tensor(s, dtype=torch.float32) for s in series_list]
    quantiles, _mean = pipeline.predict_quantiles(
        inputs, prediction_length=HORIZON, quantile_levels=QUANTILES)
    out = []
    for q in quantiles:
        arr = np.asarray(q.detach().cpu() if hasattr(q, "detach") else q)
        arr = np.squeeze(arr)
        if arr.shape == (len(QUANTILES), HORIZON):
            arr = arr.T                          # -> (horizon, quantiles)
        if arr.shape != (HORIZON, len(QUANTILES)):
            raise RuntimeError(f"Unexpected output shape {arr.shape}")
        arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)  # never send NaN/inf
        arr = np.maximum(arr, 0)                 # demand cannot be negative
        out.append({
            "p10": [round(float(x), 2) for x in arr[:, 0]],
            "p50": [round(float(x), 2) for x in arr[:, 1]],
            "p90": [round(float(x), 2) for x in arr[:, 2]],
        })
    return out


def run_chronos(jobs, model_id, device, batch_size=64):
    pipeline = load_pipeline(model_id, device)
    keys = list(jobs.keys())
    results = {}
    t0 = time.time()
    for i in range(0, len(keys), batch_size):
        chunk = keys[i:i + batch_size]
        for k, rec in zip(chunk, predict_batch(pipeline, [jobs[k] for k in chunk])):
            results[k] = rec
        print(f"  {min(i + batch_size, len(keys))}/{len(keys)} series "
              f"({time.time() - t0:.0f}s)")
    return results


def write_js(path, forecasts, model_id, n_skus):
    payload = {
        "meta": {
            "model": model_id,
            "generated": time.strftime("%Y-%m-%d %H:%M:%S"),
            "horizon": HORIZON,
            "skus": n_skus,
            "series": len(forecasts),
        },
        "f": forecasts,
    }
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("/* Auto-generated by chronos_forecast.py - do not edit. */\n")
        fh.write("window.ChronosForecasts = ")
        json.dump(payload, fh, separators=(",", ":"))
        fh.write(";\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default="sales_history.csv")
    ap.add_argument("--out", default="chronos_batch.js")
    ap.add_argument("--model", default="amazon/chronos-2")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--check", action="store_true",
                    help="only count the series to forecast; do not load the model")
    args = ap.parse_args()

    series = monthly_series(args.csv)
    jobs = collect_jobs(series)
    print(f"{len(series)} SKUs -> {len(jobs)} distinct series to forecast")
    if args.check:
        return 0

    forecasts = run_chronos(jobs, args.model, args.device)
    write_js(args.out, forecasts, args.model, len(series))
    print(f"Wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
