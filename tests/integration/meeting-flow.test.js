/**
 * Integration tests: Discord-like trigger → summary (happy path + failure cases).
 * Replaces the former contract test; fully mocked (Discord, STT, LLM).
 */

const { sessionStore } = require('../../session.js');
const { createSessionManager } = require('../../services/session-manager/session-manager.js');
const { createBotCoordinator } = require('../../coordinator/bot-coordinator.js');
const { createTranscriptWorker } = require('../../services/transcript-worker/transcript-worker.js');
const { convertPCMToWav } = require('../../services/session-manager/convert-pcm-to-wav.js');

const mockJoinVoiceChannel = jest.fn();
const mockReceiverSubscribe = jest.fn();
const mockConnection = {
	destroy: jest.fn(),
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
	EndBehaviorType: { AfterSilence: 0 },
}));

jest.mock('prism-media', () => ({
	opus: {
		Decoder: jest.fn().mockImplementation(() => ({})),
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
		...sessionManagerOverrides,
	});

	const coordinator = createBotCoordinator(sessionStore);

	const client = {
		sessionStore,
		sessionManager,
		botCoordinator: coordinator,
	};

	return { client, coordinator, sessionManager, mockWorker, mockReportGen, mockSummaryGen };
}

function createStartInteraction(client, sessionId = 'session-1') {
	return {
		member: { voice: { channel: { id: 'voice-123' } } },
		user: { id: 'user-1', displayName: 'Alice' },
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
		const { client, coordinator } = createClientWithMocks();
		const sessionId = 'session-1';

		const startInt = createStartInteraction(client, sessionId);
		const started = await coordinator.startMeeting(startInt);
		expect(started).toBe(true);
		expect(sessionStore.getSessionById(sessionId)).toBeDefined();

		const acceptInt = createAcceptInteraction(client, sessionId);
		await coordinator.handleButtonInteraction(acceptInt);
		expect(acceptInt.editReply).toHaveBeenCalledWith(
			expect.objectContaining({
				content: 'Disclaimer accepted. You are now a participant in the meeting and being recorded.',
			})
		);

		const closeInt = createCloseInteraction(client, sessionId);
		await coordinator.closeMeeting(sessionId, closeInt);

		const confirmInt = createConfirmInteraction(client);
		await coordinator.handleButtonInteraction(confirmInt);
		expect(startInt.followUp).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining(summaryText),
			})
		);
	});

	it('pause and resume: start → accept → pause → resume → close → summary', async () => {
		const { client, coordinator } = createClientWithMocks();
		const sessionId = 'session-1';

		const voiceChannelWithMembers = {
			id: 'voice-123',
			members: [{ user: { id: 'user-1' } }],
		};
		const startInt = createStartInteraction(client, sessionId);
		startInt.guild.channels.fetch = jest.fn().mockResolvedValue(voiceChannelWithMembers);

		await coordinator.startMeeting(startInt);
		const acceptInt = createAcceptInteraction(client, sessionId);
		await coordinator.handleButtonInteraction(acceptInt);
		expect(acceptInt.editReply).toHaveBeenCalledWith(
			expect.objectContaining({ content: 'Disclaimer accepted. You are now a participant in the meeting and being recorded.' })
		);

		await coordinator.pauseMeeting(sessionId);
		expect(sessionStore.getSessionById(sessionId).paused).toBe(true);

		await coordinator.resumeMeeting(sessionId);
		expect(startInt.followUp).toHaveBeenCalledWith(
			expect.objectContaining({ content: 'Meeting recording resumed.' })
		);
		expect(sessionStore.getSessionById(sessionId).paused).toBe(false);

		const closeInt = createCloseInteraction(client, sessionId);
		await coordinator.closeMeeting(sessionId, closeInt);
		const confirmInt = createConfirmInteraction(client);
		await coordinator.handleButtonInteraction(confirmInt);
		expect(startInt.followUp).toHaveBeenCalledWith(
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
		});
		const coordinator = createBotCoordinator(sessionStore);
		const client = { sessionStore, sessionManager, botCoordinator: coordinator };

		const sessionId = 'session-1';
		const startInt = createStartInteraction(client, sessionId);
		await coordinator.startMeeting(startInt);

		const acceptInt = createAcceptInteraction(client, sessionId);
		await coordinator.handleButtonInteraction(acceptInt);

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
		});
		const coordinator = createBotCoordinator(sessionStore);
		const client = { sessionStore, sessionManager, botCoordinator: coordinator };

		const sessionId = 'session-1';
		const startInt = createStartInteraction(client, sessionId);
		await coordinator.startMeeting(startInt);
		const acceptInt = createAcceptInteraction(client, sessionId);
		await coordinator.handleButtonInteraction(acceptInt);

		const closeInt = createCloseInteraction(client, sessionId);
		await coordinator.closeMeeting(sessionId, closeInt);

		const confirmInt = createConfirmInteraction(client);
		await coordinator.handleButtonInteraction(confirmInt);

		expect(confirmInt.followUp).toHaveBeenCalledWith(
			expect.objectContaining({
				content: 'An error occurred while closing the meeting.',
			})
		);
	});

	it('STT retries: fetch called multiple times on failure then close completes', async () => {
		jest.useRealTimers();
		try {
			const mockFetch = jest.fn();
			let fetchCallCount = 0;
			mockFetch.mockImplementation(() => {
				fetchCallCount++;
				if (fetchCallCount <= 3) {
					return Promise.resolve({ status: 500, statusText: 'Internal Server Error' });
				}
				return Promise.resolve({
					status: 200,
					json: () => Promise.resolve({ chunkId: 1, segments: [] }),
				});
			});

			const worker = createTranscriptWorker({
				sttBaseUrl: 'http://localhost:9999',
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
			});
			const coordinator = createBotCoordinator(sessionStore);
			const client = { sessionStore, sessionManager, botCoordinator: coordinator };

			const sessionId = 'session-1';
			const startInt = createStartInteraction(client, sessionId);
			await coordinator.startMeeting(startInt);
			const acceptInt = createAcceptInteraction(client, sessionId);
			await coordinator.handleButtonInteraction(acceptInt);

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

			expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(3);

			const closeInt = createCloseInteraction(client, sessionId);
			await coordinator.closeMeeting(sessionId, closeInt);
			const confirmInt = createConfirmInteraction(client);
			await coordinator.handleButtonInteraction(confirmInt);
			expect(startInt.followUp).toHaveBeenCalledWith(
				expect.objectContaining({
					content: expect.stringContaining(summaryText),
				})
			);
		} finally {
			jest.useFakeTimers();
		}
	}, 15000);
});
