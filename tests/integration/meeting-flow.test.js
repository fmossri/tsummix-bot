/**
 * Integration tests: Discord-like trigger → summary (happy path + failure cases).
 * Replaces the former contract test; fully mocked (Discord, STT, LLM).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sessionStore } = require('../../session.js');
const { createSessionManager } = require('../../services/session-manager/session-manager.js');
const { createMeetingController } = require('../../controller/meeting-controller.js');
const { createTranscriptWorker } = require('../../services/transcript-worker/transcript-worker.js');
const { convertPCMToWav } = require('../../utils/convert-pcm-to-wav.js');

const mockJoinVoiceChannel = jest.fn();
const mockReceiverSubscribe = jest.fn();
const mockConnection = {
	destroy: jest.fn(),
	on: jest.fn(), // connectToChannel calls voiceConnection.on('error', ...)
	receiver: {
		subscribe: jest.fn().mockReturnValue({
			on: jest.fn(),
			pipe: jest.fn().mockReturnValue({
				on: jest.fn(),
				removeAllListeners: jest.fn(),
			}),
			destroy: jest.fn(),
		}),
	},
};

jest.mock('@discordjs/voice', () => ({
	joinVoiceChannel: (...args) => mockJoinVoiceChannel(...args),
	EndBehaviorType: { AfterSilence: 0, Manual: 1 },
}));

jest.mock('prism-media', () => ({
	opus: {
		// Controller calls decoder.on('error', ...); mock must expose .on so subscribeToStream does not throw.
		Decoder: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
	},
}));

jest.useFakeTimers();

const transcriptPath = '/tmp/meeting-flow-transcript.jsonl';
const reportPath = '/tmp/meeting-flow-report.md';
const summaryText = 'Meeting flow summary.';

function createMockWorker(overrides = {}) {
	return {
		startTranscript: jest.fn().mockResolvedValue(transcriptPath),
		enqueueChunk: jest.fn().mockResolvedValue(undefined),
		closeTranscript: jest.fn().mockResolvedValue(transcriptPath),
		...overrides,
	};
}

function createMockReportGenerator() {
	return {
		generateReport: jest.fn().mockResolvedValue(reportPath),
		insertSummary: jest.fn().mockResolvedValue(undefined),
	};
}

function createMockSummaryGenerator() {
	return {
		generateSummary: jest.fn().mockResolvedValue(summaryText),
	};
}

function createClientWithMocks({ workerOverrides = {}, sessionManagerOverrides = {} } = {}) {
	const mockWorker = createMockWorker(workerOverrides);
	const mockReportGen = createMockReportGenerator();
	const mockSummaryGen = createMockSummaryGenerator();

	const sessionManager = createSessionManager({
		sessionStore,
		createReportGenerator: () => mockReportGen,
		createSummaryGenerator: () => mockSummaryGen,
		transcriptWorker: mockWorker,
		managerConfig: { maxRetries: 3 },
		...sessionManagerOverrides,
	});

	const controller = createMeetingController({ meetingTimeouts: {
		explicitPauseMs: 30 * 60 * 1000,
		pausedEmptyRoomMs: 15 * 60 * 1000,
		emptyRoomMs: 5 * 60 * 1000,
		uiTimeoutMs: 60 * 1000,
	}}, sessionStore);

	const textChannel = {
		isTextBased: jest.fn().mockReturnValue(true),
		send: jest.fn().mockResolvedValue(undefined),
		messages: {
			fetch: jest.fn().mockResolvedValue({
				edit: jest.fn().mockResolvedValue(undefined),
			}),
		},
	};

	const client = {
		sessionStore,
		sessionManager,
		meetingController: controller,
		channels: {
			fetch: jest.fn().mockResolvedValue(textChannel),
		},
	};

	return { client, controller, sessionManager, mockWorker, mockReportGen, mockSummaryGen, textChannel };
}

function createStartInteraction(client, sessionId = 'session-1') {
	return {
		member: { voice: { channel: { id: 'voice-123' } } },
		user: { id: 'user-1', displayName: 'Alice' },
		channelId: 'text-123',
		guild: { id: 'guild-1', channels: { fetch: jest.fn().mockResolvedValue({ members: [] }) }, voiceAdapterCreator: {} },
		reply: jest.fn().mockResolvedValue({
			fetch: jest.fn().mockResolvedValue({ id: sessionId }),
		}),
		followUp: jest.fn().mockResolvedValue(undefined),
		editReply: jest.fn().mockResolvedValue(undefined),
		client,
	};
}

function createAcceptInteraction(client, sessionId, userId = 'user-1') {
	const acceptInt = {
		message: { id: sessionId },
		user: { id: userId, displayName: 'Alice' },
		reply: jest.fn().mockResolvedValue(undefined),
		deferReply: jest.fn().mockResolvedValue(undefined),
		deferUpdate: jest.fn().mockResolvedValue(undefined),
		editReply: jest.fn().mockResolvedValue(undefined),
		client,
		customId: 'disclaimer-accept',
		deferred: false,
	};
	acceptInt.deferReply = jest.fn().mockImplementation(async () => {
		acceptInt.deferred = true;
	});
	return acceptInt;
}

function createCloseInteraction(client, sessionId) {
	const confirmMsgId = 'confirm-msg-1';
	return {
		editReply: jest.fn().mockResolvedValue({
			id: confirmMsgId,
			delete: jest.fn().mockResolvedValue(undefined),
		}),
		client,
	};
}

function createConfirmInteraction(client, confirmMessageId = 'confirm-msg-1') {
	const confirmInt = {
		message: { id: confirmMessageId },
		user: { id: 'user-1' },
		deferReply: jest.fn().mockResolvedValue(undefined),
		editReply: jest.fn().mockResolvedValue(undefined),
		deleteReply: jest.fn().mockResolvedValue(undefined),
		reply: jest.fn().mockResolvedValue(undefined),
		followUp: jest.fn().mockResolvedValue(undefined),
		client,
		customId: 'close-meeting-confirm',
		replied: false,
		deferred: false,
	};
	confirmInt.deferReply = jest.fn().mockImplementation(async () => {
		confirmInt.deferred = true;
	});
	return confirmInt;
}

beforeEach(() => {
	jest.clearAllMocks();
	// joinVoiceChannel is sync in @discordjs/voice; return connection object so voiceConnection.destroy() etc. work.
	mockJoinVoiceChannel.mockReturnValue(mockConnection);
	mockReceiverSubscribe.mockReturnValue({
		on: jest.fn(),
		pipe: jest.fn().mockReturnValue({ on: jest.fn(), removeAllListeners: jest.fn(), destroy: jest.fn() }),
	});
	sessionStore.clearSessions();
});

afterEach(async () => {
	await jest.runAllTimersAsync();
});

afterAll(() => {
	jest.useRealTimers();
});

describe('meeting flow integration', () => {
	it('happy path: start → accept → close → confirm → summary posted', async () => {
		const { client, controller, textChannel } = createClientWithMocks();
		const sessionId = 'session-1';

		const startInt = createStartInteraction(client, sessionId);
		const started = await controller.startMeeting(startInt);
		expect(started).toBe(true);
		expect(sessionStore.getSessionById(sessionId)).toBeDefined();

		const acceptInt = createAcceptInteraction(client, sessionId);
		await controller.handleButtonInteraction(acceptInt);
		expect(acceptInt.editReply).toHaveBeenCalledWith(
			expect.objectContaining({
				content: 'Disclaimer accepted. You are now a participant in the meeting and being recorded.',
			})
		);

		const closeInt = createCloseInteraction(client, sessionId);
		await controller.closeMeeting(sessionId, closeInt);

		const confirmInt = createConfirmInteraction(client);
		await controller.handleButtonInteraction(confirmInt);
		expect(textChannel.send).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining(summaryText),
			})
		);
	});

	it('pause and resume: start → accept → pause → resume → close → summary', async () => {
		const { client, controller, textChannel } = createClientWithMocks();
		const sessionId = 'session-1';

		const voiceChannelWithMembers = {
			id: 'voice-123',
			members: new Map([['user-1', { user: { id: 'user-1' } }]]),
		};
		const startInt = createStartInteraction(client, sessionId);
		startInt.guild.channels.fetch = jest.fn().mockResolvedValue(voiceChannelWithMembers);

		await controller.startMeeting(startInt);
		const acceptInt = createAcceptInteraction(client, sessionId);
		await controller.handleButtonInteraction(acceptInt);
		expect(acceptInt.editReply).toHaveBeenCalledWith(
			expect.objectContaining({ content: 'Disclaimer accepted. You are now a participant in the meeting and being recorded.' })
		);

		await controller.pauseMeeting(sessionId);
		expect(sessionStore.getSessionById(sessionId).paused).toBe(true);

		await controller.resumeMeeting(sessionId);
		expect(textChannel.send).toHaveBeenCalledWith(
			expect.objectContaining({ content: 'Meeting recording resumed.' })
		);
		expect(sessionStore.getSessionById(sessionId).paused).toBe(false);

		const closeInt = createCloseInteraction(client, sessionId);
		await controller.closeMeeting(sessionId, closeInt);
		const confirmInt = createConfirmInteraction(client);
		await controller.handleButtonInteraction(confirmInt);
		expect(textChannel.send).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining(summaryText) })
		);
	});

	it('worker down on start: user sees error when accepting', async () => {
		const mockWorker = createMockWorker({
			startTranscript: jest.fn().mockRejectedValue(new Error('Worker unavailable')),
		});
		const mockReportGen = createMockReportGenerator();
		const mockSummaryGen = createMockSummaryGenerator();
		const sessionManager = createSessionManager({
			sessionStore,
			createReportGenerator: () => mockReportGen,
			createSummaryGenerator: () => mockSummaryGen,
			transcriptWorker: mockWorker,
			managerConfig: { maxRetries: 3 },
		});
		const controller = createMeetingController({ meetingTimeouts: {
			explicitPauseMs: 30 * 60 * 1000,
			pausedEmptyRoomMs: 15 * 60 * 1000,
			emptyRoomMs: 5 * 60 * 1000,
			uiTimeoutMs: 60 * 1000,
		}}, sessionStore);
		const client = { sessionStore, sessionManager, meetingController: controller };

		const sessionId = 'session-1';
		const startInt = createStartInteraction(client, sessionId);
		await controller.startMeeting(startInt);

		const acceptInt = createAcceptInteraction(client, sessionId);
		await controller.handleButtonInteraction(acceptInt);

		expect(acceptInt.editReply).toHaveBeenCalledWith(
			expect.objectContaining({
				content: 'An error occurred while adding you as a participant.',
			})
		);
	});

	it('worker down on close: user sees error on confirm', async () => {
		const mockWorker = createMockWorker({
			closeTranscript: jest.fn().mockRejectedValue(new Error('Worker unavailable')),
		});
		const mockReportGen = createMockReportGenerator();
		const mockSummaryGen = createMockSummaryGenerator();
		const sessionManager = createSessionManager({
			sessionStore,
			createReportGenerator: () => mockReportGen,
			createSummaryGenerator: () => mockSummaryGen,
			transcriptWorker: mockWorker,
			managerConfig: { maxRetries: 3 },
		});
		const controller = createMeetingController({ meetingTimeouts: {
			explicitPauseMs: 30 * 60 * 1000,
			pausedEmptyRoomMs: 15 * 60 * 1000,
			emptyRoomMs: 5 * 60 * 1000,
			uiTimeoutMs: 60 * 1000,
		}}, sessionStore);
		const client = { sessionStore, sessionManager, meetingController: controller };

		const sessionId = 'session-1';
		const startInt = createStartInteraction(client, sessionId);
		await controller.startMeeting(startInt);
		const acceptInt = createAcceptInteraction(client, sessionId);
		await controller.handleButtonInteraction(acceptInt);

		const closeInt = createCloseInteraction(client, sessionId);
		await controller.closeMeeting(sessionId, closeInt);

		const confirmInt = createConfirmInteraction(client);
		await controller.handleButtonInteraction(confirmInt);

		expect(confirmInt.followUp).toHaveBeenCalledWith(
			expect.objectContaining({
				content: 'The meeting has ended. See the message above for details.',
			})
		);
	});

	it('STT retries: fetch called multiple times on failure then close completes', async () => {
		jest.useRealTimers();
		try {
			const mockFetch = jest.fn();
			let transcribeCallCount = 0;
			mockFetch.mockImplementation((url) => {
				// Worker calls /health first (waitForSttReady); must return ready so processing can start.
				if (String(url).endsWith('/health')) {
					return Promise.resolve({
						status: 200,
						json: () => Promise.resolve({ ready: true }),
					});
				}
				transcribeCallCount++;
				if (transcribeCallCount <= 3) {
					return Promise.resolve({ status: 500, statusText: 'Internal Server Error' });
				}
				// Return at least one segment so closeTranscript hasSegments passes and close succeeds.
				return Promise.resolve({
					status: 200,
					json: () => Promise.resolve({
						chunkId: transcribeCallCount,
						segments: [{ text: 'ok', startMs: 0, endMs: 100 }],
					}),
				});
			});

			const workerConfig = {
				sttBaseUrl: 'http://localhost:9999',
				workerTimeouts: { sttTimeoutMs: 5000, sttReadyTimeoutMs: 120000, sttReadyPollMs: 2000 },
				// Write transcripts for this test into a temp directory instead of the repo.
				transcriptsDir: path.join(os.tmpdir(), 'tsummix-worker-test'),
			};
			const worker = createTranscriptWorker({
				workerConfig,
				fetchImpl: mockFetch,
				fsImpl: require('node:fs'),
				pathImpl: require('node:path'),
			});

			const mockReportGen = createMockReportGenerator();
			const mockSummaryGen = createMockSummaryGenerator();
			const sessionManager = createSessionManager({
				sessionStore,
				createReportGenerator: () => mockReportGen,
				createSummaryGenerator: () => mockSummaryGen,
				transcriptWorker: worker,
				managerConfig: { maxRetries: 3 },
			});
			const controller = createMeetingController({ meetingTimeouts: {
				explicitPauseMs: 30 * 60 * 1000,
				pausedEmptyRoomMs: 15 * 60 * 1000,
				emptyRoomMs: 5 * 60 * 1000,
				uiTimeoutMs: 60 * 1000,
			}}, sessionStore);
			const textChannel = {
				isTextBased: jest.fn().mockReturnValue(true),
				send: jest.fn().mockResolvedValue(undefined),
				messages: {
					fetch: jest.fn().mockResolvedValue({ edit: jest.fn().mockResolvedValue(undefined) }),
				},
			};
			const client = {
				sessionStore,
				sessionManager,
				meetingController: controller,
				channels: { fetch: jest.fn().mockResolvedValue(textChannel) },
			};

			const sessionId = 'session-1';
			const startInt = createStartInteraction(client, sessionId);
			await controller.startMeeting(startInt);
			const acceptInt = createAcceptInteraction(client, sessionId);
			await controller.handleButtonInteraction(acceptInt);

			const wavBuffer = convertPCMToWav(Buffer.alloc(320), 16000);
			// Enqueue 5 chunks so ensureProcessing is retriggered after each failed attempt (worker only retries when processing is kicked again).
			for (let chunkId = 1; chunkId <= 5; chunkId++) {
				await worker.enqueueChunk(sessionId, {
					chunkId,
					participantData: { participantId: 'user-1', displayName: 'Alice' },
					chunkStartTimeMs: (chunkId - 1) * 5000,
					audio: wavBuffer,
				});
			}

			await new Promise((r) => setTimeout(r, 1000));

			const transcribeCalls = mockFetch.mock.calls.filter((call) => String(call[0]).endsWith('/transcribe'));
			expect(transcribeCalls.length).toBeGreaterThanOrEqual(3);

			const closeInt = createCloseInteraction(client, sessionId);
			await controller.closeMeeting(sessionId, closeInt);
			const confirmInt = createConfirmInteraction(client);
			await controller.handleButtonInteraction(confirmInt);
			expect(textChannel.send).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.stringContaining(summaryText),
				})
			);
		} finally {
			jest.useFakeTimers();
		}
	}, 15000);
});
