const {
	chooseChunkingStrategy,
	calculateRMS,
	checkRecentSilence,
	findLowestEnergyPoint,
} = require('../../../../services/session-manager/chunking/choose-strategy.js');

function createConstantBuffer(numSamples, value = 0) {
	const buffer = Buffer.alloc(numSamples * 2);
	for (let i = 0; i < numSamples; i++) {
		buffer.writeInt16LE(value, i * 2);
	}
	return buffer;
}

describe('choose-strategy', () => {
	describe('calculateRMS', () => {
		it('returns 0 for null buffer', () => {
			expect(calculateRMS(null)).toBe(0);
		});

		it('returns 0 for empty buffer', () => {
			expect(calculateRMS(Buffer.alloc(0))).toBe(0);
		});

		it('returns 0 for single-byte buffer (not enough for one Int16 sample)', () => {
			expect(calculateRMS(Buffer.alloc(1))).toBe(0);
		});

		it('returns 0 for all-zero samples', () => {
			expect(calculateRMS(createConstantBuffer(100, 0))).toBe(0);
		});

		it('returns correct RMS for a constant signal', () => {
			expect(calculateRMS(createConstantBuffer(100, 1000))).toBe(1000);
		});

		it('returns approximately max for full-scale signal', () => {
			expect(calculateRMS(createConstantBuffer(100, 32767))).toBeCloseTo(32767, 0);
		});
	});

	describe('checkRecentSilence', () => {
		it('returns true when the tail is silent', () => {
			const buffer = Buffer.concat([
				createConstantBuffer(100, 10000),
				createConstantBuffer(20, 0),
			]);
			expect(checkRecentSilence(buffer, 20, 500)).toBe(true);
		});

		it('returns false when the tail is loud', () => {
			const buffer = Buffer.concat([
				createConstantBuffer(100, 0),
				createConstantBuffer(20, 10000),
			]);
			expect(checkRecentSilence(buffer, 20, 500)).toBe(false);
		});

		it('ignores loud data before the tail', () => {
			const buffer = Buffer.concat([
				createConstantBuffer(500, 20000),
				createConstantBuffer(10, 0),
			]);
			expect(checkRecentSilence(buffer, 10, 500)).toBe(true);
		});
	});

	describe('findLowestEnergyPoint', () => {
		it('returns 0 for an all-silent buffer', () => {
			const buffer = createConstantBuffer(8000, 0);
			expect(findLowestEnergyPoint(buffer, 8000)).toBe(0);
		});

		it('finds the quiet frame among loud frames', () => {
			const loud = createConstantBuffer(1600, 10000);
			const silent = createConstantBuffer(1600, 0);
			// [loud][loud][loud][silent][loud] — 5 frames, 8000 samples
			// Offsets from end: 0=loud, 1600=silent, 3200+=loud
			const buffer = Buffer.concat([loud, loud, loud, silent, loud]);
			expect(findLowestEnergyPoint(buffer, 8000)).toBe(1600);
		});

		it('does not scan beyond the window size', () => {
			const loud = createConstantBuffer(1600, 10000);
			const silent = createConstantBuffer(1600, 0);
			// [silent][loud][loud] — window=3200 scans only the last 2 loud frames
			const buffer = Buffer.concat([silent, loud, loud]);
			expect(findLowestEnergyPoint(buffer, 3200)).toBe(0);
		});
	});

	describe('fixedSize strategy', () => {
		const fixedSize = chooseChunkingStrategy('fixedSize');
		const config = { fixedSize: 480000 };

		it('returns null when buffer is below target', () => {
			expect(fixedSize({ samplesInBuffer: 479999 }, config)).toBeNull();
		});

		it('returns fixedSize when buffer equals target (>= boundary)', () => {
			expect(fixedSize({ samplesInBuffer: 480000 }, config)).toBe(480000);
		});

		it('returns fixedSize when buffer exceeds target (one cut per call)', () => {
			expect(fixedSize({ samplesInBuffer: 960000 }, config)).toBe(480000);
		});
	});

	describe('silenceBased strategy', () => {
		const silenceBased = chooseChunkingStrategy('silenceBased');
		const config = {
			minSamples: 100,
			maxSamples: 8000,
			holdSamples: 10,
			silenceThreshold: 500,
			tailWindowSamples: 8000,
			idleTimeoutMs: 5000,
		};

		function makeState({ samplesInBuffer, samplesBuffer, chunkClockTimeMs = 0 }) {
			return { samplesInBuffer, samplesBuffer, chunkClockTimeMs };
		}

		describe('Tier 1 — silence-based clean cut', () => {
			it('cuts when buffer > minSamples and tail is silent', () => {
				const buffer = Buffer.concat([
					createConstantBuffer(101, 10000),
					createConstantBuffer(10, 0),
				]);
				const total = 111;
				const state = makeState({ samplesInBuffer: total, samplesBuffer: buffer });
				expect(silenceBased(state, config, 0)).toBe(total);
			});

			it('returns null when buffer > minSamples but tail is loud', () => {
				const buffer = createConstantBuffer(200, 10000);
				const state = makeState({ samplesInBuffer: 200, samplesBuffer: buffer });
				expect(silenceBased(state, config, 0)).toBeNull();
			});

			it('returns null when buffer === minSamples even if silent (strict >)', () => {
				const buffer = createConstantBuffer(100, 0);
				const state = makeState({ samplesInBuffer: 100, samplesBuffer: buffer });
				expect(silenceBased(state, config, 0)).toBeNull();
			});

			it('returns null when buffer < minSamples even if silent', () => {
				const buffer = createConstantBuffer(50, 0);
				const state = makeState({ samplesInBuffer: 50, samplesBuffer: buffer });
				expect(silenceBased(state, config, 0)).toBeNull();
			});
		});

		describe('Tier 2 — forced cut at maxSamples', () => {
			it('cuts when buffer >= maxSamples without silence', () => {
				const buffer = createConstantBuffer(8000, 10000);
				const state = makeState({ samplesInBuffer: 8000, samplesBuffer: buffer });
				const result = silenceBased(state, config, 0);
				expect(result).toBeGreaterThan(0);
				expect(result).toBeLessThanOrEqual(8000);
			});

			it('cuts at the lowest-energy point in the tail window', () => {
				const loud = createConstantBuffer(1600, 10000);
				const silent = createConstantBuffer(1600, 0);
				// [loud][loud][loud][silent][loud] = 8000 samples
				// findLowestEnergyPoint: silent frame at offset 1600 → cut at 8000 - 1600
				const buffer = Buffer.concat([loud, loud, loud, silent, loud]);
				const state = makeState({ samplesInBuffer: 8000, samplesBuffer: buffer });
				expect(silenceBased(state, config, 0)).toBe(8000 - 1600);
			});
		});

		describe('Tier 3 — idle timeout', () => {
			it('cuts when silent gap exceeds idleTimeoutMs', () => {
				const samples = 1600; // 100ms audio, > minSamples but < maxSamples
				const buffer = createConstantBuffer(samples, 10000);
				// audioDuration = 100ms, wallClock = 5200ms → gap = 5100ms > 5000
				const state = makeState({ samplesInBuffer: samples, samplesBuffer: buffer, chunkClockTimeMs: 0 });
				expect(silenceBased(state, config, 5200)).toBe(samples);
			});

			it('returns null when gap equals idleTimeoutMs (strict >)', () => {
				const samples = 1600;
				const buffer = createConstantBuffer(samples, 10000);
				// audioDuration = 100ms, wallClock = 5100ms → gap = 5000ms === idleTimeoutMs
				const state = makeState({ samplesInBuffer: samples, samplesBuffer: buffer, chunkClockTimeMs: 0 });
				expect(silenceBased(state, config, 5100)).toBeNull();
			});

			it('returns null when gap is below idleTimeoutMs', () => {
				const samples = 1600;
				const buffer = createConstantBuffer(samples, 10000);
				// audioDuration = 100ms, wallClock = 4100ms → gap = 4000ms < 5000
				const state = makeState({ samplesInBuffer: samples, samplesBuffer: buffer, chunkClockTimeMs: 0 });
				expect(silenceBased(state, config, 4100)).toBeNull();
			});

			it('returns null when buffer is empty despite timeout', () => {
				const state = makeState({ samplesInBuffer: 0, samplesBuffer: Buffer.alloc(0), chunkClockTimeMs: 0 });
				expect(silenceBased(state, config, 100000)).toBeNull();
			});
		});

		describe('tier priority', () => {
			it('Tier 1 fires before Tier 2 when both conditions are met', () => {
				const loud = createConstantBuffer(1600, 10000);
				const silentFrame = createConstantBuffer(1600, 0);
				const almostLoud = createConstantBuffer(1590, 10000);
				const silentTail = createConstantBuffer(10, 0);
				const lastFrame = Buffer.concat([almostLoud, silentTail]);
				// [loud][silent][loud][loud][loud(1590)+silent(10)] = 8000 samples
				// Tier 1: 8000 > 100, last 10 samples silent → returns 8000
				// Tier 2 would find silent frame at offset 4800 → return 3200
				const buffer = Buffer.concat([loud, silentFrame, loud, loud, lastFrame]);
				const state = makeState({ samplesInBuffer: 8000, samplesBuffer: buffer });
				expect(silenceBased(state, config, 0)).toBe(8000);
			});
		});
	});

	describe('chooseChunkingStrategy', () => {
		it('returns fixedSize for "fixedSize"', () => {
			const strategy = chooseChunkingStrategy('fixedSize');
			expect(typeof strategy).toBe('function');
			expect(strategy({ samplesInBuffer: 100 }, { fixedSize: 50 })).toBe(50);
		});

		it('returns silenceBased for "silenceBased"', () => {
			const strategy = chooseChunkingStrategy('silenceBased');
			expect(typeof strategy).toBe('function');
		});

		it('falls back to fixedSize for unknown strategy name', () => {
			const strategy = chooseChunkingStrategy('unknownStrategy');
			expect(strategy({ samplesInBuffer: 100 }, { fixedSize: 50 })).toBe(50);
		});
	});
});
