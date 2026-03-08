const { MessageFlags } = require('discord.js');

const mockJoinVoiceChannel = jest.fn();
const mockReceiverSubscribe = jest.fn();
const mockDecoder = jest.fn();

jest.mock('@discordjs/voice', () => ({
	joinVoiceChannel: (...args) => mockJoinVoiceChannel(...args),
	EndBehaviorType: { AfterSilence: 0 },
}));

jest.mock('prism-media', () => ({
	opus: {
		Decoder: jest.fn().mockImplementation(() => mockDecoder()),
	},
}));

jest.useFakeTimers();

beforeEach(() => {
	jest.clearAllMocks();
	mockJoinVoiceChannel.mockResolvedValue({
		receiver: {
			subscribe: mockReceiverSubscribe,
		},
		destroy: jest.fn(),
	});
	mockReceiverSubscribe.mockReturnValue({
		on: jest.fn(),
		pipe: jest.fn().mockReturnValue({}),
	});
	mockDecoder.mockReturnValue({});
});

afterEach(async () => {
	// Flush any timeouts (e.g. session timeout, close-meeting confirm timeout) so Jest exits cleanly
	await jest.runAllTimersAsync();
});

afterAll(() => {
	jest.useRealTimers();
});

const { createBotCoordinator } = require('../../coordinator/bot-coordinator.js');

function createMockSessionStore(session = null) {
	return {
		getSessionById: jest.fn().mockReturnValue(session),
		createSession: jest.fn(),
		deleteSession: jest.fn(),
	};
}

function createMockInteraction(overrides = {}) {
	const replyPayload = {
		fetch: jest.fn().mockResolvedValue({ id: 'reply-msg-id' }),
	};
	return {
		member: { voice: { channel: { id: 'voice-123' } } },
		user: { id: 'user-456', displayName: 'TestUser' },
		message: { id: 'msg-789' },
		reply: jest.fn().mockResolvedValue(replyPayload),
		followUp: jest.fn().mockResolvedValue(undefined),
		deferUpdate: jest.fn().mockResolvedValue(undefined),
		deferReply: jest.fn().mockResolvedValue(undefined),
		editReply: jest.fn().mockResolvedValue(undefined),
		client: {
			sessionManager: {
				startSession: jest.fn().mockResolvedValue(true),
				chunkStream: jest.fn(),
				closeSession: jest.fn().mockResolvedValue({ reportPath: '/tmp/report.md', summary: 'Summary.' }),
			},
		},
		customId: 'disclaimer-accept',
		...overrides,
	};
}

describe('Bot Coordinator', () => {
	describe('startMeeting', () => {
		it('replies with disclaimer and buttons, creates session in store with correct shape, returns true', async () => {
			const sessionStore = createMockSessionStore();
			const coordinator = createBotCoordinator(sessionStore);
			const interaction = createMockInteraction();
			// startMeeting awaits interaction.reply() then calls .fetch() on the result; must return object with fetch
			interaction.reply.mockResolvedValue({
				fetch: jest.fn().mockResolvedValue({ id: 'reply-msg-id' }),
			});

			const result = await coordinator.startMeeting(interaction);

			expect(result).toBe(true);
			expect(interaction.reply).toHaveBeenCalledWith(
				expect.objectContaining({
					content: 'bot presentation, meeting start message and disclaimer message placeholder.',
					components: expect.any(Array),
				})
			);
			expect(sessionStore.createSession).toHaveBeenCalledTimes(1);
			const [sessionId, sessionState] = sessionStore.createSession.mock.calls[0];
			expect(sessionId).toBe('reply-msg-id');
			expect(sessionState).toMatchObject({
				voiceChannelId: 'voice-123',
				participantIds: [],
				rejectedIds: [],
				started: false,
			});
			expect(sessionState.participantStates).toBeInstanceOf(Map);
			expect(sessionState.originalInteraction).toBe(interaction);
			expect(sessionState.timeoutId).not.toBeNull();
		});
	});

	describe('closeMeeting', () => {
		it('replies with session not found and returns when session does not exist', async () => {
			const sessionStore = createMockSessionStore(null);
			const coordinator = createBotCoordinator(sessionStore);
			const interaction = createMockInteraction();

			await coordinator.closeMeeting('session-1', interaction);

			expect(interaction.reply).toHaveBeenCalledTimes(1);
			expect(interaction.reply).toHaveBeenCalledWith({
				content: 'An error occurred while closing the meeting: session not found.',
				flags: MessageFlags.Ephemeral,
			});
		});

		it('replies with confirm message and stores confirm mapping when session exists', async () => {
			const sessionState = { timeoutId: null };
			const sessionStore = createMockSessionStore(sessionState);
			const coordinator = createBotCoordinator(sessionStore);
			const confirmMsgId = 'confirm-123';
			const replyMessage = {
				fetch: () => Promise.resolve({ id: confirmMsgId }),
				delete: jest.fn().mockResolvedValue(undefined),
			};
			const interaction = createMockInteraction({
				reply: jest.fn().mockResolvedValue(replyMessage),
			});

			await coordinator.closeMeeting('session-1', interaction);

			expect(interaction.reply).toHaveBeenCalledWith(
				expect.objectContaining({
					content: 'Are you sure you want to close the meeting?',
					flags: MessageFlags.Ephemeral,
				})
			);
			expect(sessionState.timeoutId).not.toBeNull();
		});
	});

	describe('reconnectParticipant', () => {
		it('returns false when session is not found', () => {
			const sessionStore = createMockSessionStore(null);
			const coordinator = createBotCoordinator(sessionStore);

			const result = coordinator.reconnectParticipant('session-1', 'user-1');

			expect(result).toBe(false);
		});

		it('returns false when participant is not in participantStates', () => {
			const sessionState = {
				participantStates: new Map(),
				originalInteraction: { client: { sessionManager: { chunkStream: jest.fn() } } },
			};
			const sessionStore = createMockSessionStore(sessionState);
			const coordinator = createBotCoordinator(sessionStore);

			const result = coordinator.reconnectParticipant('session-1', 'user-1');

			expect(result).toBe(false);
			expect(sessionState.originalInteraction.client.sessionManager.chunkStream).not.toHaveBeenCalled();
		});

		it('calls chunkStream and returns true when session and participant exist', () => {
			const chunkStreamMock = jest.fn();
			const sessionState = {
				participantStates: new Map([
					[
						'user-1',
						{
							subscription: null,
							pcmStream: null,
							displayName: 'User1',
							chunkerState: {},
						},
					],
				]),
				voiceConnection: {
					receiver: { subscribe: mockReceiverSubscribe },
				},
				originalInteraction: { client: { sessionManager: { chunkStream: chunkStreamMock } } },
			};
			const sessionStore = createMockSessionStore(sessionState);
			const coordinator = createBotCoordinator(sessionStore);

			const result = coordinator.reconnectParticipant('session-1', 'user-1');

			expect(result).toBe(true);
			expect(chunkStreamMock).toHaveBeenCalledWith('session-1', 'user-1');
		});
	});

	describe('handleButtonInteraction', () => {
		it('calls deferUpdate and returns when no session for message', async () => {
			const sessionStore = createMockSessionStore(null);
			const coordinator = createBotCoordinator(sessionStore);
			const interaction = createMockInteraction({ message: { id: 'unknown-msg' } });

			await coordinator.handleButtonInteraction(interaction);

			expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
			expect(interaction.reply).not.toHaveBeenCalled();
		});

		it('defers and then edits reply with Disclaimer accepted when disclaimer-accept and registerParticipant succeeds', async () => {
			const sessionState = {
				participantIds: [],
				rejectedIds: [],
				participantStates: new Map(),
				voiceConnection: { receiver: { subscribe: mockReceiverSubscribe } },
				timeoutId: null,
				originalInteraction: null,
			};
			sessionState.originalInteraction = {
				followUp: jest.fn().mockResolvedValue(undefined),
			};
			const sessionStore = createMockSessionStore(sessionState);
			sessionStore.getSessionById.mockReturnValue(sessionState);
			const coordinator = createBotCoordinator(sessionStore);
			const interaction = createMockInteraction({
				message: { id: 'msg-789' },
				user: { id: 'user-456', displayName: 'Alice' },
				customId: 'disclaimer-accept',
			});
			interaction.client.sessionManager.startSession.mockResolvedValue(true);

			await coordinator.handleButtonInteraction(interaction);

			expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
			expect(interaction.editReply).toHaveBeenCalledWith({
				content: 'Disclaimer accepted. You are now a participant in the meeting and being recorded.',
			});
		});

		it('calls deferUpdate when disclaimer-accept and user already in participantIds', async () => {
			const sessionState = {
				participantIds: ['user-456'],
				rejectedIds: [],
				participantStates: new Map(),
			};
			const sessionStore = createMockSessionStore(sessionState);
			const coordinator = createBotCoordinator(sessionStore);
			const interaction = createMockInteraction({
				message: { id: 'msg-789' },
				user: { id: 'user-456' },
				customId: 'disclaimer-accept',
			});

			await coordinator.handleButtonInteraction(interaction);

			expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
			expect(interaction.reply).not.toHaveBeenCalledWith(
				expect.objectContaining({ content: expect.stringContaining('Disclaimer accepted') })
			);
		});

		it('pushes to rejectedIds and replies when disclaimer-reject first time', async () => {
			const sessionState = {
				participantIds: [],
				rejectedIds: [],
				participantStates: new Map(),
			};
			const sessionStore = createMockSessionStore(sessionState);
			const coordinator = createBotCoordinator(sessionStore);
			const interaction = createMockInteraction({
				message: { id: 'msg-789' },
				user: { id: 'user-456' },
				customId: 'disclaimer-reject',
			});

			await coordinator.handleButtonInteraction(interaction);

			expect(sessionState.rejectedIds).toContain('user-456');
			expect(interaction.reply).toHaveBeenCalledWith({
				content: 'Disclaimer rejected. You are not a participant in the meeting and will not be recorded.',
				flags: MessageFlags.Ephemeral,
			});
		});

		it('calls deferUpdate when disclaimer-reject and user already in rejectedIds', async () => {
			const sessionState = {
				participantIds: [],
				rejectedIds: ['user-456'],
				participantStates: new Map(),
			};
			const sessionStore = createMockSessionStore(sessionState);
			const coordinator = createBotCoordinator(sessionStore);
			const interaction = createMockInteraction({
				message: { id: 'msg-789' },
				user: { id: 'user-456' },
				customId: 'disclaimer-reject',
			});

			await coordinator.handleButtonInteraction(interaction);

			expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
			expect(interaction.reply).not.toHaveBeenCalledWith(
				expect.objectContaining({ content: expect.stringContaining('Disclaimer rejected') })
			);
		});

		it('calls closeSession, editReply with summary, and deleteSession on close-meeting-confirm success', async () => {
			const sessionId = 'session-1';
			const confirmMessageId = 'confirm-msg-123';
			const sessionState = {
				participantIds: [],
				timeoutId: null,
				voiceConnection: { destroy: jest.fn() },
				participantStates: new Map(),
			};
			const sessionStore = createMockSessionStore();
			sessionStore.getSessionById.mockImplementation((id) => (id === sessionId ? sessionState : null));
			const coordinator = createBotCoordinator(sessionStore);

			const closeInteraction = createMockInteraction({
				reply: jest.fn().mockResolvedValue({
					fetch: () => Promise.resolve({ id: confirmMessageId }),
				}),
			});
			await coordinator.closeMeeting(sessionId, closeInteraction);

			const interaction = createMockInteraction({
				message: { id: confirmMessageId },
				customId: 'close-meeting-confirm',
			});
			interaction.client.sessionManager.closeSession.mockResolvedValue({
				reportPath: '/path/report.md',
				summary: 'Meeting summary.',
			});

			await coordinator.handleButtonInteraction(interaction);

			expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
			expect(interaction.client.sessionManager.closeSession).toHaveBeenCalledWith(sessionId);
			expect(interaction.editReply).toHaveBeenCalledWith({
				content: expect.stringContaining('Meeting summary.'),
			});
			expect(sessionStore.deleteSession).toHaveBeenCalledWith(sessionId);
		});

		it('editReply with error when close-meeting-confirm and closeSession throws', async () => {
			const sessionId = 'session-1';
			const confirmMessageId = 'confirm-msg-456';
			const sessionState = {
				participantIds: [],
				timeoutId: null,
				voiceConnection: { destroy: jest.fn() },
				participantStates: new Map(),
			};
			const sessionStore = createMockSessionStore(sessionState);
			const coordinator = createBotCoordinator(sessionStore);
			const closeInteraction = createMockInteraction({
				reply: jest.fn().mockResolvedValue({
					fetch: () => Promise.resolve({ id: confirmMessageId }),
				}),
			});
			await coordinator.closeMeeting(sessionId, closeInteraction);

			const interaction = createMockInteraction({
				message: { id: confirmMessageId },
				customId: 'close-meeting-confirm',
			});
			interaction.client.sessionManager.closeSession.mockRejectedValue(new Error('close failed'));

			await coordinator.handleButtonInteraction(interaction);

			expect(interaction.editReply).toHaveBeenCalledWith({
				content: 'An error occurred while closing the meeting.',
				flags: MessageFlags.Ephemeral,
			});
		});

		it('calls deferUpdate for unknown customId', async () => {
			const sessionState = {
				participantIds: [],
				rejectedIds: [],
				participantStates: new Map(),
			};
			const sessionStore = createMockSessionStore(sessionState);
			const coordinator = createBotCoordinator(sessionStore);
			const interaction = createMockInteraction({
				message: { id: 'msg-789' },
				customId: 'unknown-button',
			});

			await coordinator.handleButtonInteraction(interaction);

			expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
			expect(interaction.reply).not.toHaveBeenCalled();
		});
	});
});
