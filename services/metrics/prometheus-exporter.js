/**
 * Prometheus text exposition 
 * Serializes a snapshot from the current process’s `metrics.js`; histogram bins → cumulative *_bucket lines.
 */

const http = require('node:http');
const appMetrics = require('./metrics.js');

function escapeHelpLine(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
}

/**
 * @param {ReturnType<typeof appMetrics.getSnapshot>} snapshot
 * @returns {string}
 */
function formatPrometheusText(snapshot) {
  const lines = [];

  for (const [name, value] of Object.entries(snapshot.counters)) {
    lines.push(`# HELP ${name} ${escapeHelpLine(`Counter ${name}`)}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  }

  for (const [name, value] of Object.entries(snapshot.gauges)) {
    lines.push(`# HELP ${name} ${escapeHelpLine(`Gauge ${name}`)}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  }

  for (const [baseName, h] of Object.entries(snapshot.histograms)) {
    const { bucketUpperBounds, binCounts, sum, count } = h;
    lines.push(`# HELP ${baseName} ${escapeHelpLine(`Histogram ${baseName}`)}`);
    lines.push(`# TYPE ${baseName} histogram`);
    let cumulative = 0;
    for (let k = 0; k < bucketUpperBounds.length; k++) {
      cumulative += binCounts[k] || 0;
      const le = bucketUpperBounds[k] === Infinity ? '+Inf' : String(bucketUpperBounds[k]);
      lines.push(`${baseName}_bucket{le="${le}"} ${cumulative}`);
    }
    lines.push(`${baseName}_sum ${sum}`);
    lines.push(`${baseName}_count ${count}`);
  }

  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * @param {{ port: number | null; host: string }} options
 */
function startBotMetricsServerIfConfigured({ port, host }) {
  if (port == null) {
    return null;
  }

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url.split('?')[0] !== '/metrics') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found\n');
      return;
    }
    try {
      const body = formatPrometheusText(appMetrics.getSnapshot());
      res.writeHead(200, {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`${err.message}\n`);
    }
  });

  server.listen(port, host, () => {
    console.log(`[metrics] Prometheus scrape: http://${host}:${port}/metrics`);
  });

  server.on('error', (err) => {
    console.error('[metrics] HTTP server error:', err.message);
  });

  return server;
}

module.exports = {
  formatPrometheusText,
  startBotMetricsServerIfConfigured,
};
