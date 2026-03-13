const { createSessionManager } = require('../../../services/session-manager/session-manager.js');

const TARGET_CHUNK_SECONDS = 30;
const SAMPLE_RATE = 16000;
const TARGET_BYTES = TARGET_CHUNK_SECONDS * SAMPLE_RATE * 2;

function createMockSessionStore(session = null) {
	return {
		getSessionById: jest.fn().mockReturnValue(session),
	};
}

function createMockTranscriptWorker(overrides = {}) {
	return {
		startTranscript: jest.fn().mockResolvedValue('/tmp/test-transcript.jsonl'),
		enqueueChunk: jest.fn().mockResolvedValue(undefined),
		closeTranscript: jest.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function createMockReportGenerator(reportPath = '/tmp/test-report.md') {
	return {
		generateReport: jest.fn().mockResolvedValue(reportPath),
		insertSummary: jest.fn().mockResolvedValue(undefined),
	};
}

function createMockSummaryGenerator(summaryText = 'Test summary.') {
	return {
		generateSummary: jest.fn().mockResolvedValue(summaryText),
	};
}

function createSessionWithParticipantStates(participantStates = new Map()) {
	return {
		voiceChannelId: 'voice-123',
		participantStates,
	};
}

describe('Session Manager', () => {
	describe('startSession', () => {
		it('returns false and does not call transcriptWorker.startTranscript when session is not in store', async () => {
			const sessionStore = createMockSessionStore(undefined);
			const transcriptWorker = createMockTranscriptWorker();
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});

			const result = await sessionManager.startSession('session-1');

			expect(result).toBe(false);
			expect(transcriptWorker.startTranscript).not.toHaveBeenCalled();
		});

		it('calls transcriptWorker.startTranscript and returns true when session is in store', async () => {
			const session = createSessionWithParticipantStates();
			const sessionStore = createMockSessionStore(session);
			const transcriptWorker = createMockTranscriptWorker();
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});

			const result = await sessionManager.startSession('session-1');

			expect(result).toBe(true);
			expect(transcriptWorker.startTranscript).toHaveBeenCalledTimes(1);
			expect(transcriptWorker.startTranscript).toHaveBeenCalledWith('session-1', expect.any(Number));
		});

		it('returns false when transcriptWorker.startTranscript throws', async () => {
			const session = createSessionWithParticipantStates();
			const sessionStore = createMockSessionStore(session);
			const transcriptWorker = createMockTranscriptWorker({
				startTranscript: jest.fn().mockRejectedValue(new Error('start failed')),
			});
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});

			const result = await sessionManager.startSession('session-1');

			expect(result).toBe(false);
		});
	});

	describe('closeSession', () => {
		it('returns false when session was never started', async () => {
			const sessionStore = createMockSessionStore(createSessionWithParticipantStates());
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker: createMockTranscriptWorker(),
			});

			const result = await sessionManager.closeSession('session-1');
			expect(result).toBe(false);
		});

		it('awaits processing, calls closeTranscript and generators, deletes session, and returns reportPath and summary', async () => {
			const session = createSessionWithParticipantStates(new Map([['u1', { displayName: 'Alice' }]]));
			const sessionStore = createMockSessionStore(session);
			const transcriptWorker = createMockTranscriptWorker();
			const mockReportPath = '/tmp/report.md';
			const mockSummaryText = 'Summary text.';
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(mockReportPath),
				createSummaryGenerator: () => createMockSummaryGenerator(mockSummaryText),
				transcriptWorker,
			});

			await sessionManager.startSession('session-1');
			const result = await sessionManager.closeSession('session-1');

			expect(transcriptWorker.closeTranscript).toHaveBeenCalledWith('session-1', {
				channelId: 'voice-123',
				participantDisplayNames: ['Alice'],
				closure: null,
			});
			expect(result).toEqual({ reportPath: mockReportPath, summary: mockSummaryText });
			const secondClose = await sessionManager.closeSession('session-1');
			expect(secondClose).toBe(false);
		});

		it('throws when transcriptWorker.closeTranscript throws', async () => {
			const session = createSessionWithParticipantStates();
			const sessionStore = createMockSessionStore(session);
			const transcriptWorker = createMockTranscriptWorker({
				closeTranscript: jest.fn().mockRejectedValue(new Error('close failed')),
			});
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});

			await sessionManager.startSession('session-1');

			await expect(sessionManager.closeSession('session-1')).rejects.toThrow('close failed');
		});

		it('throws when reportGenerator.generateReport throws (e.g. empty transcript)', async () => {
			const session = createSessionWithParticipantStates(new Map([['u1', { displayName: 'Alice' }]]));
			const sessionStore = createMockSessionStore(session);
			const transcriptWorker = createMockTranscriptWorker();
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => ({
					generateReport: jest.fn().mockRejectedValue(new Error('Transcript has no segments; cannot generate report.')),
					insertSummary: jest.fn().mockResolvedValue(undefined),
				}),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});

			await sessionManager.startSession('session-1');

			await expect(sessionManager.closeSession('session-1')).rejects.toThrow('Transcript has no segments');
		});
	});

	describe('chunkStream', () => {
		it('returns false when session is not in sessionStates', () => {
			const session = createSessionWithParticipantStates(new Map([['u1', { displayName: 'A', pcmStream: { on: jest.fn() }, chunkerState: {} }]]));
			const sessionStore = createMockSessionStore(session);
			const transcriptWorker = createMockTranscriptWorker();
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});

			const result = sessionManager.chunkStream('session-1', 'u1');

			expect(result).toBe(false);
			expect(transcriptWorker.enqueueChunk).not.toHaveBeenCalled();
		});

		it('returns false when participant is not in participantStates', async () => {
			const participantStates = new Map();
			const session = createSessionWithParticipantStates(participantStates);
			const sessionStore = createMockSessionStore(session);
			const transcriptWorker = createMockTranscriptWorker();
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});

			await sessionManager.startSession('session-1');
			const result = sessionManager.chunkStream('session-1', 'nonexistent');

			expect(result).toBe(false);
			expect(transcriptWorker.enqueueChunk).not.toHaveBeenCalled();
		});

		it('calls transcriptWorker.enqueueChunk when stream emits enough PCM data', async () => {
			const { EventEmitter } = require('events');
			const pcmStream = new EventEmitter();
			const participantStates = new Map([
				[
					'u1',
					{
						displayName: 'Alice',
						pcmStream,
						chunkerState: {
							samplesBuffer: Buffer.alloc(0),
							samplesInBuffer: 0,
							totalSamplesEmitted: 0,
						},
					},
				],
			]);
			const session = createSessionWithParticipantStates(participantStates);
			const sessionStore = createMockSessionStore(session);
			const transcriptWorker = createMockTranscriptWorker();
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});

			await sessionManager.startSession('session-1');
			sessionManager.chunkStream('session-1', 'u1');

			pcmStream.emit('data', Buffer.alloc(TARGET_BYTES));

			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			expect(transcriptWorker.enqueueChunk).toHaveBeenCalled();
			expect(transcriptWorker.enqueueChunk).toHaveBeenCalledWith('session-1', expect.objectContaining({
				participantData: { participantId: 'u1', displayName: 'Alice' },
				chunkStartTimeMs: 0,
				chunkClockTimeMs: expect.any(Number),
				audio: expect.any(Buffer),
			}));
		});

		it('sets chunkClockTimeMs on each chunk and updates it after each cut', async () => {
			const { EventEmitter } = require('events');
			const pcmStream = new EventEmitter();
			const participantStates = new Map([
				[
					'u1',
					{
						displayName: 'Alice',
						pcmStream,
						chunkerState: {
							samplesBuffer: Buffer.alloc(0),
							samplesInBuffer: 0,
							totalSamplesEmitted: 0,
						},
					},
				],
			]);
			const session = createSessionWithParticipantStates(participantStates);
			const sessionStore = createMockSessionStore(session);
			const transcriptWorker = createMockTranscriptWorker();
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});

			await sessionManager.startSession('session-1');
			sessionManager.chunkStream('session-1', 'u1');

			pcmStream.emit('data', Buffer.alloc(TARGET_BYTES));
			await new Promise((r) => setImmediate(r));
			const firstChunk = transcriptWorker.enqueueChunk.mock.calls[0][1];
			expect(firstChunk.chunkClockTimeMs).toBeDefined();
			expect(typeof firstChunk.chunkClockTimeMs).toBe('number');

			pcmStream.emit('data', Buffer.alloc(TARGET_BYTES));
			await new Promise((r) => setImmediate(r));
			const secondChunk = transcriptWorker.enqueueChunk.mock.calls[1][1];
			expect(secondChunk.chunkClockTimeMs).toBeDefined();
			expect(typeof secondChunk.chunkClockTimeMs).toBe('number');
		});

		it('cutChunk: chunkStartTimeMs reflects totalSamplesEmitted', async () => {
			const { EventEmitter } = require('events');
			const pcmStream = new EventEmitter();
			const participantState = {
				displayName: 'Alice',
				pcmStream,
				chunkerState: {
					samplesBuffer: Buffer.alloc(0),
					samplesInBuffer: 0,
					totalSamplesEmitted: 16000, // 1s at 16kHz
					chunkClockTimeMs: null,
				},
			};
			const participantStates = new Map([['u1', participantState]]);
			const session = createSessionWithParticipantStates(participantStates);
			const sessionStore = createMockSessionStore(session);
			const transcriptWorker = createMockTranscriptWorker();
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});

			await sessionManager.startSession('session-1');
			sessionManager.chunkStream('session-1', 'u1');

			pcmStream.emit('data', Buffer.alloc(TARGET_BYTES));
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			const chunk = transcriptWorker.enqueueChunk.mock.calls[0][1];
			expect(chunk.chunkStartTimeMs).toBe(1000);
		});

		it('cutChunk: updates chunkerState chunkClockTimeMs after cut (chunk keeps previous value)', async () => {
			const { EventEmitter } = require('events');
			const pcmStream = new EventEmitter();
			const participantState = {
				displayName: 'Alice',
				pcmStream,
				chunkerState: {
					samplesBuffer: Buffer.alloc(0),
					samplesInBuffer: 0,
					totalSamplesEmitted: 0,
					chunkClockTimeMs: null,
				},
			};
			const participantStates = new Map([['u1', participantState]]);
			const session = createSessionWithParticipantStates(participantStates);
			const sessionStore = createMockSessionStore(session);
			const transcriptWorker = createMockTranscriptWorker();
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});
			await sessionManager.startSession('session-1');
			sessionManager.chunkStream('session-1', 'u1');

			const nowSpy = jest.spyOn(Date, 'now')
				.mockReturnValueOnce(111) // chunk start clock time
				.mockReturnValueOnce(222); // next chunk clock time after cut

			pcmStream.emit('data', Buffer.alloc(TARGET_BYTES));
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			const chunk = transcriptWorker.enqueueChunk.mock.calls[0][1];
			expect(chunk.chunkClockTimeMs).toBe(111);
			expect(participantState.chunkerState.chunkClockTimeMs).toBe(222);

			nowSpy.mockRestore();
		});

		describe('sendChunks retry logic', () => {
			it('requeues chunk and retries when enqueueChunk fails then succeeds (transient failure)', async () => {
				const { EventEmitter } = require('events');
				const pcmStream = new EventEmitter();
				const participantStates = new Map([
					[
						'u1',
						{
							displayName: 'Alice',
							pcmStream,
							chunkerState: {
								samplesBuffer: Buffer.alloc(0),
								samplesInBuffer: 0,
								totalSamplesEmitted: 0,
							},
						},
					],
				]);
				const session = createSessionWithParticipantStates(participantStates);
				const sessionStore = createMockSessionStore(session);
				const transcriptWorker = createMockTranscriptWorker({
					enqueueChunk: jest.fn()
						.mockRejectedValueOnce(new Error('worker busy'))
						.mockRejectedValueOnce(new Error('worker busy'))
						.mockResolvedValueOnce(undefined),
				});
				const sessionManager = createSessionManager({
					sessionStore,
					createReportGenerator: () => createMockReportGenerator(),
					createSummaryGenerator: () => createMockSummaryGenerator(),
					transcriptWorker,
				});

				await sessionManager.startSession('session-1');
				sessionManager.chunkStream('session-1', 'u1');
				pcmStream.emit('data', Buffer.alloc(TARGET_BYTES));

				await new Promise((r) => setImmediate(r));
				await new Promise((r) => setImmediate(r));
				await new Promise((r) => setImmediate(r));

				expect(transcriptWorker.enqueueChunk).toHaveBeenCalledTimes(3);
				expect(transcriptWorker.enqueueChunk).toHaveBeenCalledWith('session-1', expect.objectContaining({
					participantData: { participantId: 'u1', displayName: 'Alice' },
					chunkId: expect.any(Number),
				}));
			});

			it('drops chunk and logs chunk_send_failed after MAX_SEND_RETRIES (permanent failure)', async () => {
				const logger = require('../../../services/logger/logger');
				const errorSpy = jest.spyOn(logger, 'error');

				const { EventEmitter } = require('events');
				const pcmStream = new EventEmitter();
				const participantStates = new Map([
					[
						'u1',
						{
							displayName: 'Alice',
							pcmStream,
							chunkerState: {
								samplesBuffer: Buffer.alloc(0),
								samplesInBuffer: 0,
								totalSamplesEmitted: 0,
							},
						},
					],
				]);
				const session = createSessionWithParticipantStates(participantStates);
				const sessionStore = createMockSessionStore(session);
				const transcriptWorker = createMockTranscriptWorker({
					enqueueChunk: jest.fn().mockRejectedValue(new Error('worker down')),
				});
				const sessionManager = createSessionManager({
					sessionStore,
					createReportGenerator: () => createMockReportGenerator(),
					createSummaryGenerator: () => createMockSummaryGenerator(),
					transcriptWorker,
				});

				await sessionManager.startSession('session-1');
				sessionManager.chunkStream('session-1', 'u1');
				pcmStream.emit('data', Buffer.alloc(TARGET_BYTES));

				await new Promise((r) => setImmediate(r));
				await new Promise((r) => setImmediate(r));
				await new Promise((r) => setImmediate(r));
				await new Promise((r) => setImmediate(r));

				expect(transcriptWorker.enqueueChunk).toHaveBeenCalledTimes(3);
				expect(errorSpy).toHaveBeenCalledWith(
					'session-manager',
					'chunk_send_failed',
					'Worker enqueueChunk failed',
					expect.objectContaining({
						sessionId: 'session-1',
						transcriptId: 'session-1',
						sendRetryCount: 3,
						errorClass: 'Error',
						message: 'worker down',
					})
				);

				errorSpy.mockRestore();
			});
		});

		it('cutChunk: two consecutive cuts in one buffer update start times and state', async () => {
			const { EventEmitter } = require('events');
			const pcmStream = new EventEmitter();
			const participantState = {
				displayName: 'Alice',
				pcmStream,
				chunkerState: {
					samplesBuffer: Buffer.alloc(0),
					samplesInBuffer: 0,
					totalSamplesEmitted: 0,
					chunkClockTimeMs: null,
				},
			};
			const participantStates = new Map([['u1', participantState]]);
			const session = createSessionWithParticipantStates(participantStates);
			const sessionStore = createMockSessionStore(session);
			const transcriptWorker = createMockTranscriptWorker();
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});

			await sessionManager.startSession('session-1');
			sessionManager.chunkStream('session-1', 'u1');

			// Provide enough PCM for two full chunks in a single data event
			pcmStream.emit('data', Buffer.alloc(TARGET_BYTES * 2));
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			expect(transcriptWorker.enqueueChunk).toHaveBeenCalledTimes(2);
			const first = transcriptWorker.enqueueChunk.mock.calls[0][1];
			const second = transcriptWorker.enqueueChunk.mock.calls[1][1];
			expect(first.chunkStartTimeMs).toBe(0);
			expect(second.chunkStartTimeMs).toBe(TARGET_CHUNK_SECONDS * 1000);
			expect(participantState.chunkerState.samplesInBuffer).toBe(0);
			expect(participantState.chunkerState.samplesBuffer.length).toBe(0);
			expect(participantState.chunkerState.totalSamplesEmitted).toBe(TARGET_CHUNK_SECONDS * SAMPLE_RATE * 2);
		});
	});

	describe('pauseSession', () => {
		function createRunningSessionManager({
			storeSessionPaused = true,
			participantStates = new Map(),
			transcriptWorkerOverrides = {},
		} = {}) {
			const storeSession = {
				voiceChannelId: 'voice-123',
				participantStates,
				paused: storeSessionPaused,
			};
			const sessionStore = createMockSessionStore(storeSession);
			const transcriptWorker = createMockTranscriptWorker(transcriptWorkerOverrides);
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});
			return { sessionManager, transcriptWorker, sessionStore };
		}

		it('returns false when session was never started (no session state found)', async () => {
			const sessionStore = createMockSessionStore(createSessionWithParticipantStates());
			const transcriptWorker = createMockTranscriptWorker();
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => createMockReportGenerator(),
				createSummaryGenerator: () => createMockSummaryGenerator(),
				transcriptWorker,
			});

			const result = await sessionManager.pauseSession('session-1');

			expect(result).toBe(false);
		});

		it('returns false when store session is not paused', async () => {
			const { sessionManager, transcriptWorker } = createRunningSessionManager({
				storeSessionPaused: false,
				participantStates: new Map([['u1', { displayName: 'Alice', chunkerState: {} }]]),
			});
			await sessionManager.startSession('session-1');

			const result = await sessionManager.pauseSession('session-1');

			expect(result).toBe(false);
			expect(transcriptWorker.enqueueChunk).not.toHaveBeenCalled();
		});

		it('continues when participantState has no chunkerState', async () => {
			const participantStates = new Map([
				['u1', { displayName: 'Alice' }],
			]);
			const { sessionManager, transcriptWorker } = createRunningSessionManager({
				storeSessionPaused: true,
				participantStates,
			});
			await sessionManager.startSession('session-1');

			const result = await sessionManager.pauseSession('session-1');

			expect(result).toBe(true);
			expect(transcriptWorker.enqueueChunk).not.toHaveBeenCalled();
		});

		it('flushes when samplesInBuffer > 0: enqueues chunk and resets samplesInBuffer to 0', async () => {
			const flushSamples = 16000; // 1 second at 16kHz
			const participantState = {
				displayName: 'Alice',
				chunkerState: {
					chunkClockTimeMs: 123,
					samplesBuffer: Buffer.alloc(flushSamples * 2),
					samplesInBuffer: flushSamples,
					totalSamplesEmitted: 0,
				},
			};
			const participantStates = new Map([['u1', participantState]]);
			const { sessionManager, transcriptWorker } = createRunningSessionManager({
				storeSessionPaused: true,
				participantStates,
			});
			await sessionManager.startSession('session-1');

			const result = await sessionManager.pauseSession('session-1');
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			expect(result).toBe(true);
			expect(transcriptWorker.enqueueChunk).toHaveBeenCalledTimes(1);
			expect(transcriptWorker.enqueueChunk).toHaveBeenCalledWith(
				'session-1',
				expect.objectContaining({
					participantData: { participantId: 'u1', displayName: 'Alice' },
					chunkStartTimeMs: 0,
					chunkClockTimeMs: 123,
					audio: expect.any(Buffer),
				})
			);
			expect(participantState.chunkerState.samplesInBuffer).toBe(0);
			expect(participantState.chunkerState.samplesBuffer.length).toBe(0);
			expect(participantState.chunkerState.totalSamplesEmitted).toBe(flushSamples);
		});

		it('does not flush when samplesInBuffer === 0', async () => {
			const participantState = {
				displayName: 'Alice',
				chunkerState: {
					chunkClockTimeMs: 123,
					samplesBuffer: Buffer.alloc(0),
					samplesInBuffer: 0,
					totalSamplesEmitted: 0,
				},
			};
			const participantStates = new Map([['u1', participantState]]);
			const { sessionManager, transcriptWorker } = createRunningSessionManager({
				storeSessionPaused: true,
				participantStates,
			});
			await sessionManager.startSession('session-1');

			const result = await sessionManager.pauseSession('session-1');
			await new Promise((r) => setImmediate(r));

			expect(result).toBe(true);
			expect(transcriptWorker.enqueueChunk).not.toHaveBeenCalled();
			expect(participantState.chunkerState.samplesInBuffer).toBe(0);
			expect(participantState.chunkerState.totalSamplesEmitted).toBe(0);
		});

		it('sets chunkClockTimeMs on chunk when present; null when absent', async () => {
			const flushSamples = 8000;
			const participantStateWithClock = {
				displayName: 'Alice',
				chunkerState: {
					chunkClockTimeMs: 777,
					samplesBuffer: Buffer.alloc(flushSamples * 2),
					samplesInBuffer: flushSamples,
					totalSamplesEmitted: 0,
				},
			};
			const participantStateNoClock = {
				displayName: 'Bob',
				chunkerState: {
					chunkClockTimeMs: null,
					samplesBuffer: Buffer.alloc(flushSamples * 2),
					samplesInBuffer: flushSamples,
					totalSamplesEmitted: 0,
				},
			};
			const participantStates = new Map([
				['u1', participantStateWithClock],
				['u2', participantStateNoClock],
			]);
			const { sessionManager, transcriptWorker } = createRunningSessionManager({
				storeSessionPaused: true,
				participantStates,
			});
			await sessionManager.startSession('session-1');

			await sessionManager.pauseSession('session-1');
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			const chunk1 = transcriptWorker.enqueueChunk.mock.calls[0][1];
			const chunk2 = transcriptWorker.enqueueChunk.mock.calls[1][1];
			expect(chunk1.chunkClockTimeMs).toBe(777);
			expect(chunk2.chunkClockTimeMs).toBeNull();
		});

		it('multiple participants: flush - not flush - flush', async () => {
			const flushSamples = 4000;
			const p1 = {
				displayName: 'A',
				chunkerState: {
					chunkClockTimeMs: 1,
					samplesBuffer: Buffer.alloc(flushSamples * 2),
					samplesInBuffer: flushSamples,
					totalSamplesEmitted: 0,
				},
			};
			const p2 = { displayName: 'B' }; // no chunkerState => skipped
			const p3 = {
				displayName: 'C',
				chunkerState: {
					chunkClockTimeMs: 3,
					samplesBuffer: Buffer.alloc(flushSamples * 2),
					samplesInBuffer: flushSamples,
					totalSamplesEmitted: 0,
				},
			};
			const participantStates = new Map([
				['u1', p1],
				['u2', p2],
				['u3', p3],
			]);
			const { sessionManager, transcriptWorker } = createRunningSessionManager({
				storeSessionPaused: true,
				participantStates,
			});
			await sessionManager.startSession('session-1');

			const result = await sessionManager.pauseSession('session-1');
			await new Promise((r) => setImmediate(r));
			await new Promise((r) => setImmediate(r));

			expect(result).toBe(true);
			expect(transcriptWorker.enqueueChunk).toHaveBeenCalledTimes(2);
			expect(transcriptWorker.enqueueChunk.mock.calls[0][1]).toEqual(expect.objectContaining({
				participantData: { participantId: 'u1', displayName: 'A' },
			}));
			expect(transcriptWorker.enqueueChunk.mock.calls[1][1]).toEqual(expect.objectContaining({
				participantData: { participantId: 'u3', displayName: 'C' },
			}));
		});

		it('returns true when participantStates is empty', async () => {
			const participantStates = new Map();
			const { sessionManager, transcriptWorker } = createRunningSessionManager({
				storeSessionPaused: true,
				participantStates,
			});
			await sessionManager.startSession('session-1');

			const result = await sessionManager.pauseSession('session-1');

			expect(result).toBe(true);
			expect(transcriptWorker.enqueueChunk).not.toHaveBeenCalled();
		});

		it('throws when cutChunk throws', async () => {
			const participantState = {
				displayName: 'Alice',
				chunkerState: {
					chunkClockTimeMs: 1,
					samplesBuffer: null, // will throw when calling subarray
					samplesInBuffer: 1,
					totalSamplesEmitted: 0,
				},
			};
			const participantStates = new Map([['u1', participantState]]);
			const { sessionManager } = createRunningSessionManager({
				storeSessionPaused: true,
				participantStates,
			});
			await sessionManager.startSession('session-1');

			await expect(sessionManager.pauseSession('session-1')).rejects.toThrow();
		});
	});
});
