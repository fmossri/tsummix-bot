/**
 * In-process metrics for observability. Updated alongside log calls; no Prometheus yet.
 * Names and types match docs/OBSERVABILITY-PLAN.md § Metrics sketch (v0.3).
 * A future Prometheus milestone can read this state and expose /metrics.
 */

const counters = {};
const gauges = {};
const histogramBuckets = {
  stt_latency_ms: [0, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity],
  stt_queue_wait_ms: [0, 50, 100, 250, 500, 1000, 2500, 5000, 15000, 60000, 120000, 300000, 600000, Infinity],
  chunk_duration_ms: [0, 1000, 2000, 5000, 10000, 15000, 20000, 25000, 30000, Infinity],
  meeting_duration_ms: [0, 60e3, 300e3, 600e3, 1800e3, 3600e3, Infinity],
};
const histograms = {};
/** @type {Record<string, number>} */
const histogramSums = {};
/** @type {Record<string, number>} */
const histogramCounts = {};

function increment(name, n = 1) {
  counters[name] = (counters[name] || 0) + n;
}

function set(name, value) {
  gauges[name] = value;
}

function incrementGauge(name, delta) {
  gauges[name] = (gauges[name] || 0) + delta;
}

function observe(name, value) {
  const buckets = histogramBuckets[name];
  if (!buckets) return;
  if (!histograms[name]) {
    histograms[name] = new Array(buckets.length).fill(0);
  }
  let i = 0;
  while (i < buckets.length && value > buckets[i]) i++;
  if (i < buckets.length) histograms[name][i]++;
  histogramSums[name] = (histogramSums[name] || 0) + value;
  histogramCounts[name] = (histogramCounts[name] || 0) + 1;
}

/** Returns a snapshot of all metrics (for tests or future /metrics endpoint). */
function getSnapshot() {
  return {
    counters: { ...counters },
    gauges: { ...gauges },
    histograms: Object.fromEntries(
      Object.entries(histograms).map(([name, bins]) => [
        name,
        {
          bucketUpperBounds: histogramBuckets[name],
          binCounts: [...bins],
          sum: histogramSums[name] ?? 0,
          count: histogramCounts[name] ?? 0,
        },
      ])
    ),
  };
}

/** Reset all metrics (for tests). */
function reset() {
  Object.keys(counters).forEach((k) => delete counters[k]);
  Object.keys(gauges).forEach((k) => delete gauges[k]);
  Object.keys(histograms).forEach((k) => delete histograms[k]);
  Object.keys(histogramSums).forEach((k) => delete histogramSums[k]);
  Object.keys(histogramCounts).forEach((k) => delete histogramCounts[k]);
}

module.exports = {
  increment,
  set,
  incrementGauge,
  observe,
  getSnapshot,
  reset,
};
