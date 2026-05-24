/**
 * charts.js - Chart.js wrapper, dark theme
 */

const ChartManager = (() => {

  let _chart = null;

  const C = {
    historical  : { line: '#8b5cf6', fill: 'rgba(139,92,246,0.10)' },
    inSample    : { line: '#22c55e' },
    forecast    : { line: '#a78bfa', point: '#a78bfa' },
    forecastFill: 'rgba(167,139,250,0.07)',
    grid        : 'rgba(255,255,255,0.05)',
    tick        : '#4b5563'
  };

  function init(canvasId) {
    const ctx = document.getElementById(canvasId).getContext('2d');

    _chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels  : [],
        datasets: [
          {
            label           : 'Historical Sales',
            data            : [],
            borderColor     : C.historical.line,
            backgroundColor : C.historical.fill,
            borderWidth     : 2.5,
            pointRadius     : 4,
            pointHoverRadius: 6,
            fill            : true,
            tension         : 0.3,
            order           : 3
          },
          {
            label      : 'Moving Avg (in-sample)',
            data       : [],
            borderColor: C.inSample.line,
            borderWidth: 2,
            borderDash : [],
            pointRadius: 0,
            fill       : false,
            tension    : 0.3,
            order      : 2
          },
          {
            label               : 'Forecast',
            data                : [],
            borderColor         : C.forecast.line,
            backgroundColor     : C.forecastFill,
            borderWidth         : 2,
            borderDash          : [6, 3],
            pointRadius         : 5,
            pointBackgroundColor: C.forecast.point,
            fill                : true,
            tension             : 0.2,
            order               : 1
          }
        ]
      },
      options: {
        responsive         : true,
        maintainAspectRatio: false,
        interaction        : { mode: 'index', intersect: false },
        animation          : { duration: 500, easing: 'easeInOutQuart' },

        plugins: {
          legend : { display: false },
          tooltip: {
            backgroundColor: '#1a1a1a',
            titleColor     : '#6b7280',
            bodyColor      : '#f0f0f0',
            borderColor    : 'rgba(255,255,255,0.07)',
            borderWidth    : 1,
            padding        : 14,
            cornerRadius   : 12,
            callbacks: {
              label: function(ctx) {
                var v = ctx.raw;
                if (v == null) return null;
                return ' ' + ctx.dataset.label + ': ' + Number(v).toLocaleString() + ' units';
              }
            }
          }
        },

        scales: {
          x: {
            grid : { display: false },
            ticks: {
              color        : C.tick,
              font         : { size: 11 },
              maxRotation  : 45,
              maxTicksLimit: 12
            }
          },
          y: {
            grid : { color: C.grid },
            ticks: {
              color   : C.tick,
              font    : { size: 11 },
              callback: function(v) { return v.toLocaleString(); }
            },
            beginAtZero: false
          }
        }
      }
    });
  }

  function update(histLabels, histValues, inSample, forecastLabels, forecastValues) {
    if (!_chart) return;

    var allLabels = histLabels.concat(forecastLabels || []);

    var histDataPadded = histValues.concat(
      new Array(forecastLabels ? forecastLabels.length : 0).fill(null)
    );

    var inSamplePadded = inSample
      ? inSample.concat(new Array(forecastLabels ? forecastLabels.length : 0).fill(null))
      : new Array(allLabels.length).fill(null);

    var forecastPadded = forecastValues
      ? new Array(histValues.length - 1).fill(null)
          .concat([histValues[histValues.length - 1]])
          .concat(forecastValues)
      : new Array(allLabels.length).fill(null);

    _chart.data.labels           = allLabels;
    _chart.data.datasets[0].data = histDataPadded;
    _chart.data.datasets[1].data = inSamplePadded;
    _chart.data.datasets[2].data = forecastPadded;

    _chart.update();
  }

  function resetZoom() { if (_chart) _chart.update('active'); }

  function exportPNG() {
    if (!_chart) return;
    var a = document.createElement('a');
    a.href     = _chart.toBase64Image('image/png', 1.0);
    a.download = 'demand-forecast.png';
    a.click();
  }

  return { init, update, resetZoom, exportPNG };

})();
