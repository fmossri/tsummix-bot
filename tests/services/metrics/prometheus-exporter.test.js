const { formatPrometheusText } = require('../../../services/metrics/prometheus-exporter.js');

describe('formatPrometheusText', () => {
	it('emits cumulative histogram buckets and sum/count', () => {
		const text = formatPrometheusText({
			counters: { meetings_started_total: 2 },
			gauges: { meetings_active: 1 },
			histograms: {
				stt_latency_ms: {
					bucketUpperBounds: [10, 50, Infinity],
					binCounts: [1, 1, 0],
					sum: 35,
					count: 2,
				},
			},
		});

		expect(text).toContain('meetings_started_total 2');
		expect(text).toContain('meetings_active 1');
		expect(text).toContain('stt_latency_ms_bucket{le="10"} 1');
		expect(text).toContain('stt_latency_ms_bucket{le="50"} 2');
		expect(text).toContain('stt_latency_ms_bucket{le="+Inf"} 2');
		expect(text).toContain('stt_latency_ms_sum 35');
		expect(text).toContain('stt_latency_ms_count 2');
	});
});
