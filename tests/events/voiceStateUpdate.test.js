jest.mock('../../config/index.js', () => ({
	controllerConfig: {
		meetingTimeouts: {
			emptyRoomMs: 300_000,
			pausedEmptyRoomMs: 900_000,
			explicitPauseMs: 1_800_000,
			uiTimeoutMs: 60_000,
		},
	},
}));

const voiceStateUpdate = require('../../events/voiceStateUpdate.js');
const { controllerConfig: { meetingTimeouts } } = require('../../config/index.js');

function createMockClient(overrides = {}) {
	return {
		user: { id: 'bot-user-id' },
		sessionStore: {
			getSessionByChannelId: jest.fn().mockReturnValue(null),
		},
		meetingController: {
			handleUserJoinedMeetingChannel: jest.fn().mockResolvedValue(undefined),
			pauseMeeting: jest.fn().mockResolvedValue(undefined),
			autoCloseMeeting: jest.fn().mockResolvedValue(undefined),
		},
		users: {
			fetch: jest.fn().mockRejectedValue(new Error('User not found')),
		},
		...overrides,
	};
}

function createMockNewState(overrides = {}) {
	return {
		channelId: 'channel-123',
		id: 'user-456',
		member: null,
		...overrides,
	};
}

describe('VoiceStateUpdate', () => {
	it('does nothing when newState.channelId is null (user left)', async () => {
		const getSessionByChannelId = jest.fn();
		const handleUserJoinedMeetingChannel = jest.fn();
		const client = createMockClient({
			sessionStore: { getSessionByChannelId },
			meetingController: { handleUserJoinedMeetingChannel },
		});
		const newState = createMockNewState({ channelId: null });

		await voiceStateUpdate.execute({}, newState, client);

		expect(getSessionByChannelId).not.toHaveBeenCalled();
		expect(handleUserJoinedMeetingChannel).not.toHaveBeenCalled();
	});

	it('does nothing when channel has no session', async () => {
		const getSessionByChannelId = jest.fn().mockReturnValue(null);
		const handleUserJoinedMeetingChannel = jest.fn();
		const client = createMockClient({
			sessionStore: { getSessionByChannelId },
			meetingController: { handleUserJoinedMeetingChannel },
		});
		const newState = createMockNewState();

		await voiceStateUpdate.execute({}, newState, client);

		expect(getSessionByChannelId).toHaveBeenCalledWith('channel-123');
		expect(handleUserJoinedMeetingChannel).not.toHaveBeenCalled();
	});

	it('calls handleUserJoinedMeetingChannel when user joins meeting channel (late joiner path)', async () => {
		const mockUser = { send: jest.fn().mockResolvedValue(undefined) };
		const getSessionByChannelId = jest.fn().mockReturnValue({
			sessionId: 'session-1',
			sessionState: { participantIds: ['other-user'], rejectedIds: [], dmIds: [], started: true },
		});
		const handleUserJoinedMeetingChannel = jest.fn().mockResolvedValue(undefined);
		const client = createMockClient({
			sessionStore: { getSessionByChannelId },
			meetingController: { handleUserJoinedMeetingChannel },
		});
		const newState = createMockNewState({
			id: 'late-joiner',
			member: { user: mockUser },
		});

		await voiceStateUpdate.execute({}, newState, client);

		expect(handleUserJoinedMeetingChannel).toHaveBeenCalledTimes(1);
		expect(handleUserJoinedMeetingChannel).toHaveBeenCalledWith('session-1', 'late-joiner', { user: mockUser });
	});

	it('does not throw when late joiner has no member and users.fetch returns null', async () => {
		const getSessionByChannelId = jest.fn().mockReturnValue({
			sessionId: 'session-1',
			sessionState: { participantIds: ['other-user'], rejectedIds: [], dmIds: [], started: true },
		});
		const handleUserJoinedMeetingChannel = jest.fn().mockResolvedValue(undefined);
		const client = createMockClient({
			sessionStore: { getSessionByChannelId },
			meetingController: { handleUserJoinedMeetingChannel },
			users: { fetch: jest.fn().mockResolvedValue(null) },
		});
		const newState = createMockNewState({ id: 'late-joiner', member: null });

		await expect(voiceStateUpdate.execute({}, newState, client)).resolves.not.toThrow();
		expect(handleUserJoinedMeetingChannel).toHaveBeenCalledWith('session-1', 'late-joiner', { user: null });
	});

	it('calls handleUserJoinedMeetingChannel when user is in participantIds', async () => {
		const mockUser = {};
		const getSessionByChannelId = jest.fn().mockReturnValue({
			sessionId: 'session-1',
			sessionState: { participantIds: ['user-456'], rejectedIds: [], dmIds: [], started: true, paused: false },
		});
		const handleUserJoinedMeetingChannel = jest.fn().mockResolvedValue(undefined);
		const client = createMockClient({
			sessionStore: { getSessionByChannelId },
			meetingController: { handleUserJoinedMeetingChannel },
			users: { fetch: jest.fn().mockResolvedValue(mockUser) },
		});
		const newState = createMockNewState({ id: 'user-456', member: null });

		await voiceStateUpdate.execute({}, newState, client);

		expect(handleUserJoinedMeetingChannel).toHaveBeenCalledTimes(1);
		expect(handleUserJoinedMeetingChannel).toHaveBeenCalledWith('session-1', 'user-456', { user: mockUser });
	});

	it('does nothing when user stays in the same channel (mute/unmute etc.)', async () => {
		const getSessionByChannelId = jest.fn();
		const handleUserJoinedMeetingChannel = jest.fn();
		const client = createMockClient({
			sessionStore: { getSessionByChannelId },
			meetingController: { handleUserJoinedMeetingChannel },
		});
		const oldState = createMockNewState({ channelId: 'channel-123' });
		const newState = createMockNewState({ channelId: 'channel-123' });

		await voiceStateUpdate.execute(oldState, newState, client);

		expect(getSessionByChannelId).not.toHaveBeenCalled();
		expect(handleUserJoinedMeetingChannel).not.toHaveBeenCalled();
	});

	describe('user left path', () => {
		beforeEach(() => jest.useFakeTimers());
		afterEach(() => jest.useRealTimers());

		function createSessionState(overrides = {}) {
			return {
				participantIds: ['participant-1', 'participant-2'],
				started: true,
				paused: false,
				timeouts: { pauseTimeoutId: undefined },
				...overrides,
			};
		}

		function createOldState({ channelId = 'voice-1', userId = 'someone', channel = null } = {}) {
			return { channelId, id: userId, channel };
		}

		function leftNewState(channelId = null) {
			return createMockNewState({ channelId, id: 'irrelevant' });
		}

		function withSession(client, sessionState) {
			client.sessionStore.getSessionByChannelId.mockReturnValue({
				sessionId: 'session-1',
				sessionState,
			});
			return client;
		}

		it('does nothing when the bot itself leaves the channel', async () => {
			const sessionState = createSessionState();
			const client = withSession(createMockClient(), sessionState);
			const oldState = createOldState({ userId: 'bot-user-id', channel: { members: new Map() } });

			await voiceStateUpdate.execute(oldState, leftNewState(), client);

			expect(client.meetingController.pauseMeeting).not.toHaveBeenCalled();
			expect(client.meetingController.autoCloseMeeting).not.toHaveBeenCalled();
		});

		it('does nothing when old channel is not cached', async () => {
			const sessionState = createSessionState();
			const client = withSession(createMockClient(), sessionState);
			const oldState = createOldState({ channel: null });

			await voiceStateUpdate.execute(oldState, leftNewState(), client);

			expect(client.meetingController.pauseMeeting).not.toHaveBeenCalled();
		});

		it('does nothing when meeting has not started', async () => {
			const sessionState = createSessionState({ started: false });
			const client = withSession(createMockClient(), sessionState);
			const oldState = createOldState({ channel: { members: new Map() } });

			await voiceStateUpdate.execute(oldState, leftNewState(), client);

			expect(client.meetingController.pauseMeeting).not.toHaveBeenCalled();
		});

		it('does nothing when a non-participant leaves but a participant remains', async () => {
			const sessionState = createSessionState({ participantIds: ['participant-1'] });
			const members = new Map([
				['participant-1', { user: { id: 'participant-1' } }],
			]);
			const client = withSession(createMockClient(), sessionState);
			const oldState = createOldState({ userId: 'random-visitor', channel: { members } });

			await voiceStateUpdate.execute(oldState, leftNewState(), client);

			expect(client.meetingController.pauseMeeting).not.toHaveBeenCalled();
			expect(client.meetingController.autoCloseMeeting).not.toHaveBeenCalled();
		});

		it('does nothing when a participant leaves but another participant remains', async () => {
			const sessionState = createSessionState({ participantIds: ['participant-1', 'participant-2'] });
			const members = new Map([
				['participant-2', { user: { id: 'participant-2' } }],
				['bot-user-id', { user: { id: 'bot-user-id' } }],
			]);
			const client = withSession(createMockClient(), sessionState);
			const oldState = createOldState({ userId: 'participant-1', channel: { members } });

			await voiceStateUpdate.execute(oldState, leftNewState(), client);

			expect(client.meetingController.pauseMeeting).not.toHaveBeenCalled();
			expect(client.meetingController.autoCloseMeeting).not.toHaveBeenCalled();
		});

		it('pauses and sets emptyRoomMs auto-close when last participant leaves (not paused)', async () => {
			const sessionState = createSessionState({ participantIds: ['participant-1'], paused: false });
			const members = new Map([
				['bot-user-id', { user: { id: 'bot-user-id' } }],
			]);
			const client = withSession(createMockClient(), sessionState);
			const oldState = createOldState({ userId: 'participant-1', channel: { members } });

			await voiceStateUpdate.execute(oldState, leftNewState(), client);

			expect(client.meetingController.pauseMeeting).toHaveBeenCalledWith('session-1');
			expect(client.meetingController.autoCloseMeeting).not.toHaveBeenCalled();

			await jest.advanceTimersByTimeAsync(meetingTimeouts.emptyRoomMs);

			expect(client.meetingController.autoCloseMeeting).toHaveBeenCalledWith('session-1');
		});

		it('sets pausedEmptyRoomMs auto-close when last participant leaves (already paused)', async () => {
			const sessionState = createSessionState({ participantIds: ['participant-1'], paused: true });
			const members = new Map([
				['bot-user-id', { user: { id: 'bot-user-id' } }],
			]);
			const client = withSession(createMockClient(), sessionState);
			const oldState = createOldState({ userId: 'participant-1', channel: { members } });

			await voiceStateUpdate.execute(oldState, leftNewState(), client);

			expect(client.meetingController.pauseMeeting).not.toHaveBeenCalled();
			expect(client.meetingController.autoCloseMeeting).not.toHaveBeenCalled();

			await jest.advanceTimersByTimeAsync(meetingTimeouts.pausedEmptyRoomMs);

			expect(client.meetingController.autoCloseMeeting).toHaveBeenCalledWith('session-1');
		});

		it('swallows errors when pauseMeeting throws', async () => {
			const sessionState = createSessionState({ participantIds: ['participant-1'], paused: false });
			const members = new Map();
			const client = withSession(createMockClient(), sessionState);
			client.meetingController.pauseMeeting.mockRejectedValue(new Error('pause failed'));
			const oldState = createOldState({ userId: 'participant-1', channel: { members } });

			await expect(voiceStateUpdate.execute(oldState, leftNewState(), client)).resolves.not.toThrow();
			expect(client.meetingController.autoCloseMeeting).not.toHaveBeenCalled();
		});
	});
});
