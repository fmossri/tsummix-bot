const { MessageFlags } = require('discord.js');

const mockJoinVoiceChannel = jest.fn();
const mockReceiverSubscribe = jest.fn();
const mockDecoder = jest.fn();

jest.mock('@discordjs/voice', () => ({
	joinVoiceChannel: (...args) => mockJoinVoiceChannel(...args),
	EndBehaviorType: { AfterSilence: 0, Manual: 1 },
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
	// Controller calls decoder.on('error', ...); mock must expose .on so subscribeToStream does not throw.
	mockDecoder.mockReturnValue({ on: jest.fn() });
});

afterEach(async () => {
	// Flush any timeouts (e.g. session timeout, close-meeting confirm timeout) so Jest exits cleanly
	await jest.runAllTimersAsync();
});

afterAll(() => {
	jest.useRealTimers();
});

const { createMeetingController } = require('../../controller/meeting-controller.js');

const DEFAULT_CONTROLLER_CONFIG = {
	meetingTimeouts: {
		explicitPauseMs: 30 * 60 * 1000,
		pausedEmptyRoomMs: 15 * 60 * 1000,
		emptyRoomMs: 5 * 60 * 1000,
		uiTimeoutMs: 60 * 1000,
	},
};

function createMockSessionStore(session = null) {
	return {
		getSessionById: jest.fn().mockReturnValue(session),
		createSession: jest.fn(),
		deleteSession: jest.fn(),
	};
}

function createMockTextChannel() {
	const messageEditMock = jest.fn().mockResolvedValue(undefined);
	const messageFetchMock = jest.fn().mockResolvedValue({ edit: messageEditMock });
	const sendMock = jest.fn().mockResolvedValue(undefined);
	return {
		sendMock,
		messageFetchMock,
		messageEditMock,
		channel: {
			isTextBased: jest.fn().mockReturnValue(true),
			send: sendMock,
			messages: { fetch: messageFetchMock },
		},
	};
}

function createMockInteraction(overrides = {}) {
	const replyPayload = {
		fetch: jest.fn().mockResolvedValue({ id: 'reply-msg-id' }),
	};
	const { channel: textChannel } = createMockTextChannel();
	return {
		member: { voice: { channel: { id: 'voice-123' } } },
		user: { id: 'user-456', displayName: 'TestUser' },
		message: { id: 'msg-789' },
		channelId: 'text-123',
		reply: jest.fn().mockResolvedValue(replyPayload),
		followUp: jest.fn().mockResolvedValue(undefined),
		deferUpdate: jest.fn().mockResolvedValue(undefined),
		deferReply: jest.fn().mockResolvedValue(undefined),
		editReply: jest.fn().mockResolvedValue(undefined),
		deleteReply: jest.fn().mockResolvedValue(undefined),
		replied: false,
		deferred: false,
		client: {
			channels: { fetch: jest.fn().mockResolvedValue(textChannel) },
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

describe('Meeting Controller', () => {
	describe('startMeeting', () => {
		it('replies with disclaimer and buttons, creates session in store with correct shape, returns true', async () => {
			const sessionStore = createMockSessionStore();
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);
			const interaction = createMockInteraction();
			// startMeeting awaits interaction.reply() then calls .fetch() on the result; must return object with fetch
			interaction.reply.mockResolvedValue({
				fetch: jest.fn().mockResolvedValue({ id: 'reply-msg-id' }),
			});

			const result = await controller.startMeeting(interaction);

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
			expect(sessionState.timeouts.uiTimeoutId).not.toBeNull();
		});
	});

	describe('closeMeeting', () => {
		it('returns false when session does not exist (sessionState is null)', async () => {
			const sessionStore = createMockSessionStore(null);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);
			const interaction = createMockInteraction({
				editReply: jest.fn().mockResolvedValue({ id: 'confirm-msg-id', delete: jest.fn().mockResolvedValue(undefined) }),
			});

			const result = await controller.closeMeeting('session-1', interaction);

			expect(result).toBe(false);
		});

		it('calls editReply with confirm message and stores confirm mapping when session exists', async () => {
			const sessionState = { timeouts: { uiTimeoutId: null, pauseTimeoutId: null } };
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);
			const interaction = createMockInteraction({
				editReply: jest.fn().mockResolvedValue({ id: 'confirm-123', delete: jest.fn().mockResolvedValue(undefined) }),
			});

			await controller.closeMeeting('session-1', interaction);

			expect(interaction.editReply).toHaveBeenCalledWith(
				expect.objectContaining({
					content: 'Are you sure you want to close the meeting?',
					flags: MessageFlags.Ephemeral,
				})
			);
			expect(sessionState.timeouts.uiTimeoutId).not.toBeNull();
		});
	});

	describe('reconnectParticipant', () => {
		it('returns false when session is not found', () => {
			const sessionStore = createMockSessionStore(null);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const result = controller.reconnectParticipant('session-1', 'user-1');

			expect(result).toBe(false);
		});

		it('returns false when participant is not in participantStates', () => {
			const sessionState = {
				participantStates: new Map(),
				originalInteraction: { client: { sessionManager: { chunkStream: jest.fn() } } },
			};
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const result = controller.reconnectParticipant('session-1', 'user-1');

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
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const result = controller.reconnectParticipant('session-1', 'user-1');

			expect(result).toBe(true);
			expect(chunkStreamMock).toHaveBeenCalledWith('session-1', 'user-1');
		});
	});

	describe('pauseMeeting', () => {
		it('sets sessionState.paused and pauseTimeoutId when session exists', async () => {
			const closeSessionMock = jest.fn().mockResolvedValue({ reportPath: '/tmp/report.md', summary: 'Summary.' });
			const pauseSessionMock = jest.fn().mockResolvedValue(true);
			const { channel: textChannel } = createMockTextChannel();
			const sessionState = {
				participantIds: ['user-1'],
				voiceConnection: { destroy: jest.fn(), receiver: { subscribe: mockReceiverSubscribe } },
				participantStates: new Map([['user-1', { subscription: null, pcmStream: null }]]),
				textChannelId: 'text-123',
				originalInteraction: {
					followUp: jest.fn().mockResolvedValue(undefined),
					editReply: jest.fn().mockResolvedValue(undefined),
					client: {
						channels: { fetch: jest.fn().mockResolvedValue(textChannel) },
						sessionManager: { closeSession: closeSessionMock, pauseSession: pauseSessionMock },
					},
				},
				timeouts: { uiTimeoutId: null, pauseTimeoutId: null },
			};
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			await controller.pauseMeeting('session-1');

			expect(sessionState.paused).toBe(true);
			expect(sessionState.timeouts.pauseTimeoutId).not.toBeNull();
			expect(pauseSessionMock).toHaveBeenCalledWith('session-1');
		});

	});

	describe('resumeMeeting', () => {
		it('connects, fetches channel, reconnects participants, sets paused false, sends "Meeting recording resumed.", returns true', async () => {
			const { channel: textChannel, sendMock } = createMockTextChannel();
			const voiceChannel = {
				members: new Map([['user-1', { user: { id: 'user-1' } }]]),
			};
			const sessionState = {
				participantIds: ['user-1'],
				voiceChannelId: 'voice-123',
				voiceConnection: { receiver: { subscribe: mockReceiverSubscribe } },
				textChannelId: 'text-123',
				participantStates: new Map([
					['user-1', { subscription: null, pcmStream: null, displayName: 'User1', chunkerState: {} }],
				]),
				timeouts: { uiTimeoutId: null, pauseTimeoutId: null },
				originalInteraction: {
					guild: { channels: { fetch: jest.fn().mockResolvedValue(voiceChannel) } },
					client: {
						channels: { fetch: jest.fn().mockResolvedValue(textChannel) },
						sessionManager: { chunkStream: jest.fn() },
					},
				},
			};
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const result = await controller.resumeMeeting('session-1');

			expect(result).toBe(true);
			expect(sessionState.paused).toBe(false);
			expect(sendMock).toHaveBeenCalledWith({
				content: 'Meeting recording resumed.',
			});
			expect(sessionState.originalInteraction.client.sessionManager.chunkStream).toHaveBeenCalledWith('session-1', 'user-1');
		});

		it('returns false when connectToChannel fails (no voiceConnection, joinVoiceChannel throws)', async () => {
			mockJoinVoiceChannel.mockImplementationOnce(() => {
				throw new Error('connect failed');
			});
			const sessionState = {
				participantIds: [],
				voiceChannelId: 'voice-123',
				voiceConnection: null,
				textChannelId: 'text-123',
				participantStates: new Map(),
				timeouts: { uiTimeoutId: null, pauseTimeoutId: null },
				originalInteraction: {
					guild: { channels: { fetch: jest.fn().mockResolvedValue({ members: [] }) } },
					client: { channels: { fetch: jest.fn().mockResolvedValue(createMockTextChannel().channel) } },
					followUp: jest.fn().mockResolvedValue(undefined),
				},
			};
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const result = await controller.resumeMeeting('session-1');
			expect(result).toBe(false);
		});

		it('returns false when voice channel fetch returns null', async () => {
			const sessionState = {
				participantIds: [],
				voiceChannelId: 'voice-123',
				voiceConnection: { receiver: { subscribe: mockReceiverSubscribe } },
				textChannelId: 'text-123',
				participantStates: new Map(),
				timeouts: { uiTimeoutId: null, pauseTimeoutId: null },
				originalInteraction: {
					guild: { channels: { fetch: jest.fn().mockResolvedValue(null) } },
					client: { channels: { fetch: jest.fn().mockResolvedValue(createMockTextChannel().channel) } },
					followUp: jest.fn().mockResolvedValue(undefined),
				},
			};
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const result = await controller.resumeMeeting('session-1');

			expect(result).toBe(false);
		});

		it('returns true even when resume success message fails to send', async () => {
			const brokenChannel = {
				isTextBased: jest.fn().mockReturnValue(true),
				send: jest.fn().mockRejectedValue(new Error('send failed')),
				messages: { fetch: jest.fn().mockResolvedValue({ edit: jest.fn().mockResolvedValue(undefined) }) },
			};
			const voiceChannel = { members: [] };
			const sessionState = {
				participantIds: [],
				voiceChannelId: 'voice-123',
				voiceConnection: { receiver: { subscribe: mockReceiverSubscribe } },
				textChannelId: 'text-123',
				participantStates: new Map(),
				timeouts: { uiTimeoutId: null, pauseTimeoutId: null },
				originalInteraction: {
					guild: { channels: { fetch: jest.fn().mockResolvedValue(voiceChannel) } },
					client: {
						channels: { fetch: jest.fn().mockResolvedValue(brokenChannel) },
						sessionManager: { chunkStream: jest.fn() },
					},
				},
			};
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const result = await controller.resumeMeeting('session-1');
			expect(result).toBe(true);
		});
	});

	describe('handleButtonInteraction', () => {
		it('calls deferUpdate and returns when no session for message', async () => {
			const sessionStore = createMockSessionStore(null);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);
			const interaction = createMockInteraction({ message: { id: 'unknown-msg' } });

			await controller.handleButtonInteraction(interaction);

			expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
			expect(interaction.reply).not.toHaveBeenCalled();
		});

		it('defers and then edits reply with Disclaimer accepted when disclaimer-accept and registerParticipant succeeds', async () => {
			const sessionState = {
				participantIds: [],
				rejectedIds: [],
				participantStates: new Map(),
				voiceConnection: { receiver: { subscribe: mockReceiverSubscribe } },
				timeouts: { uiTimeoutId: null, pauseTimeoutId: null },
				originalInteraction: null,
			};
			sessionState.originalInteraction = {
				followUp: jest.fn().mockResolvedValue(undefined),
			};
			const sessionStore = createMockSessionStore(sessionState);
			sessionStore.getSessionById.mockReturnValue(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);
			const interaction = createMockInteraction({
				message: { id: 'msg-789' },
				user: { id: 'user-456', displayName: 'Alice' },
				customId: 'disclaimer-accept',
			});
			interaction.client.sessionManager.startSession.mockResolvedValue(true);

			await controller.handleButtonInteraction(interaction);

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
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);
			const interaction = createMockInteraction({
				message: { id: 'msg-789' },
				user: { id: 'user-456' },
				customId: 'disclaimer-accept',
			});

			await controller.handleButtonInteraction(interaction);

			expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
			expect(interaction.reply).not.toHaveBeenCalledWith(
				expect.objectContaining({ content: expect.stringContaining('Disclaimer accepted') })
			);
		});

		it('pushes to rejectedIds and edits reply when disclaimer-reject first time', async () => {
			const sessionState = {
				participantIds: [],
				rejectedIds: [],
				participantStates: new Map(),
			};
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);
			const interaction = createMockInteraction({
				message: { id: 'msg-789' },
				user: { id: 'user-456' },
				customId: 'disclaimer-reject',
			});

			await controller.handleButtonInteraction(interaction);

			expect(sessionState.rejectedIds).toContain('user-456');
			expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
			expect(interaction.editReply).toHaveBeenCalledWith({
				content: 'Disclaimer rejected. You are not a participant in the meeting and will not be recorded.',
			});
		});

		it('calls deferUpdate when disclaimer-reject and user already in rejectedIds', async () => {
			const sessionState = {
				participantIds: [],
				rejectedIds: ['user-456'],
				participantStates: new Map(),
			};
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);
			const interaction = createMockInteraction({
				message: { id: 'msg-789' },
				user: { id: 'user-456' },
				customId: 'disclaimer-reject',
			});

			await controller.handleButtonInteraction(interaction);

			expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
			expect(interaction.reply).not.toHaveBeenCalledWith(
				expect.objectContaining({ content: expect.stringContaining('Disclaimer rejected') })
			);
		});

		it('calls closeSession, followUp with summary, and deleteSession on close-meeting-confirm success', async () => {
			const sessionId = 'session-1';
			const confirmMessageId = 'confirm-msg-123';
			const { channel: textChannel, sendMock, messageEditMock } = createMockTextChannel();
			const editReplyMock = jest.fn().mockResolvedValue(undefined);
			const closeSessionMock = jest.fn().mockResolvedValue({ reportPath: '/path/report.md', summary: 'Meeting summary.' });
			const sessionState = {
				participantIds: [],
				textChannelId: 'text-123',
				timeouts: { uiTimeoutId: null, pauseTimeoutId: null },
				voiceConnection: { destroy: jest.fn() },
				participantStates: new Map(),
				originalInteraction: {
					editReply: editReplyMock,
					client: {
						channels: { fetch: jest.fn().mockResolvedValue(textChannel) },
						sessionManager: { closeSession: closeSessionMock },
					},
				},
			};
			const sessionStore = createMockSessionStore();
			sessionStore.getSessionById.mockImplementation((id) => (id === sessionId ? sessionState : null));
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const closeInteraction = createMockInteraction({
				editReply: jest.fn().mockResolvedValue({ id: confirmMessageId, delete: jest.fn().mockResolvedValue(undefined) }),
			});
			await controller.closeMeeting(sessionId, closeInteraction);

			const interaction = createMockInteraction({
				message: { id: confirmMessageId },
				customId: 'close-meeting-confirm',
			});

			await controller.handleButtonInteraction(interaction);

			expect(interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
			expect(closeSessionMock).toHaveBeenCalledWith(
				sessionId,
				expect.objectContaining({ autoClose: false, closeReason: 'manual', closedAtMs: expect.any(Number) })
			);
			expect(sendMock).toHaveBeenCalledWith({
				content: expect.stringContaining('Meeting summary.'),
			});
			expect(messageEditMock).toHaveBeenCalledWith(expect.objectContaining({ components: expect.any(Array) }));
			expect(sessionStore.deleteSession).toHaveBeenCalledWith(sessionId);
		});

		it('calls interactionErrorHelper when close-meeting-confirm and closeSession throws', async () => {
			const sessionId = 'session-1';
			const confirmMessageId = 'confirm-msg-456';
			const followUpMock = jest.fn().mockResolvedValue(undefined);
			const closeSessionMock = jest.fn().mockRejectedValue(new Error('close failed'));
			const { channel: textChannel } = createMockTextChannel();
			const sessionState = {
				participantIds: [],
				textChannelId: 'text-123',
				timeouts: { uiTimeoutId: null, pauseTimeoutId: null },
				voiceConnection: { destroy: jest.fn() },
				participantStates: new Map(),
				originalInteraction: {
					followUp: followUpMock,
					editReply: jest.fn().mockResolvedValue(undefined),
					client: {
						channels: { fetch: jest.fn().mockResolvedValue(textChannel) },
						sessionManager: { closeSession: closeSessionMock },
					},
				},
			};
			const sessionStore = createMockSessionStore(sessionState);
			sessionStore.getSessionById.mockImplementation((id) => (id === sessionId ? sessionState : null));
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);
			const closeInteraction = createMockInteraction({
				editReply: jest.fn().mockResolvedValue({ id: confirmMessageId, delete: jest.fn().mockResolvedValue(undefined) }),
			});
			await controller.closeMeeting(sessionId, closeInteraction);

			const interaction = createMockInteraction({
				message: { id: confirmMessageId },
				customId: 'close-meeting-confirm',
				deferred: true,
				replied: true,
			});
			interaction.followUp = jest.fn().mockResolvedValue(undefined);

			await controller.handleButtonInteraction(interaction);

			expect(interaction.followUp).toHaveBeenCalledWith({
				content: 'The meeting has ended. See the message above for details.',
				flags: MessageFlags.Ephemeral,
			});
			expect(sessionStore.deleteSession).toHaveBeenCalledWith(sessionId);
		});

		it('calls deferUpdate for unknown customId', async () => {
			const sessionState = {
				participantIds: [],
				rejectedIds: [],
				participantStates: new Map(),
			};
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);
			const interaction = createMockInteraction({
				message: { id: 'msg-789' },
				customId: 'unknown-button',
			});

			await controller.handleButtonInteraction(interaction);

			expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
			expect(interaction.reply).not.toHaveBeenCalled();
		});
	});

	describe('autoCloseMeeting', () => {
		it('returns false when session not found', async () => {
			const sessionStore = createMockSessionStore(null);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const result = await controller.autoCloseMeeting('session-1');

			expect(result).toBe(false);
			expect(sessionStore.deleteSession).not.toHaveBeenCalled();
		});

		it('returns true and calls executeClose with autoClose when session exists and close succeeds', async () => {
			const { channel: textChannel, sendMock } = createMockTextChannel();
			const closeSessionMock = jest.fn().mockResolvedValue({ reportPath: '/tmp/report.md', summary: 'Auto-close summary.' });
			const sessionState = {
				participantIds: [],
				textChannelId: 'text-123',
				timeouts: { uiTimeoutId: null, pauseTimeoutId: null },
				voiceConnection: { destroy: jest.fn() },
				participantStates: new Map(),
				originalInteraction: {
					client: {
						channels: { fetch: jest.fn().mockResolvedValue(textChannel) },
						sessionManager: { closeSession: closeSessionMock },
					},
				},
			};
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const result = await controller.autoCloseMeeting('session-1');

			expect(result).toBe(true);
			expect(closeSessionMock).toHaveBeenCalledWith(
				'session-1',
				expect.objectContaining({ autoClose: true, closeReason: 'inactivity', closedAtMs: expect.any(Number) })
			);
			expect(sendMock).toHaveBeenCalledWith({
				content: 'Meeting closed due to inactivity. The partial report is saved.',
			});
			expect(sessionStore.deleteSession).toHaveBeenCalledWith('session-1');
		});

		it('returns false when executeClose returns false (closeSession throws)', async () => {
			const closeSessionMock = jest.fn().mockRejectedValue(new Error('close failed'));
			const { channel: textChannel } = createMockTextChannel();
			const sessionState = {
				participantIds: [],
				textChannelId: 'text-123',
				timeouts: { uiTimeoutId: null, pauseTimeoutId: null },
				voiceConnection: { destroy: jest.fn() },
				participantStates: new Map(),
				originalInteraction: {
					client: {
						channels: { fetch: jest.fn().mockResolvedValue(textChannel) },
						sessionManager: { closeSession: closeSessionMock },
					},
				},
			};
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const result = await controller.autoCloseMeeting('session-1');

			expect(result).toBe(false);
			expect(sessionStore.deleteSession).toHaveBeenCalledWith('session-1');
		});

		it('returns false when executeClose throws (e.g. followUp rejects)', async () => {
			const closeSessionMock = jest.fn().mockResolvedValue({ reportPath: '/tmp/report.md', summary: 'Summary.' });
			const brokenChannel = {
				isTextBased: jest.fn().mockReturnValue(true),
				send: jest.fn().mockRejectedValue(new Error('send failed')),
				messages: { fetch: jest.fn().mockResolvedValue({ edit: jest.fn().mockResolvedValue(undefined) }) },
			};
			const sessionState = {
				participantIds: [],
				textChannelId: 'text-123',
				timeouts: { uiTimeoutId: null, pauseTimeoutId: null },
				voiceConnection: { destroy: jest.fn() },
				participantStates: new Map(),
				originalInteraction: {
					client: {
						channels: { fetch: jest.fn().mockResolvedValue(brokenChannel) },
						sessionManager: { closeSession: closeSessionMock },
					},
				},
			};
			const sessionStore = createMockSessionStore(sessionState);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const result = await controller.autoCloseMeeting('session-1');

			expect(result).toBe(false);
			expect(sessionStore.deleteSession).toHaveBeenCalledWith('session-1');
		});

		it('returns false when executeClose gets session not found (race: session deleted between check and executeClose)', async () => {
			const sessionState = {
				participantIds: [],
				timeouts: { uiTimeoutId: null, pauseTimeoutId: null },
				voiceConnection: { destroy: jest.fn() },
				participantStates: new Map(),
				originalInteraction: {
					followUp: jest.fn().mockResolvedValue(undefined),
					editReply: jest.fn().mockResolvedValue(undefined),
					client: { sessionManager: { closeSession: jest.fn() } },
				},
			};
			const sessionStore = createMockSessionStore(sessionState);
			sessionStore.getSessionById.mockReturnValueOnce(sessionState).mockReturnValueOnce(null);
			const controller = createMeetingController(DEFAULT_CONTROLLER_CONFIG, sessionStore);

			const result = await controller.autoCloseMeeting('session-1');

			expect(result).toBe(false);
			expect(sessionStore.deleteSession).not.toHaveBeenCalled();
		});
	});
});
