const { Events } = require('discord.js');
const timeoutDuration = require('../config/timeouts');

module.exports = {
	name: Events.VoiceStateUpdate,
	async execute(oldState, newState, client) {
		// Ignore non-channel changes like mute/unmute
        if (oldState.channelId === newState.channelId) {
            return;
        }

        const oldSession = oldState.channelId
        ? client.sessionStore.getSessionByChannelId(oldState.channelId)
        : null;

        // User left the meeting channel (to null OR another channel)
        if (oldSession && oldState.channelId !== newState.channelId) {
            const sessionState = oldSession.sessionState;
            // Channel not cached or user left before the meeting started -> do nothing.
            if (!oldState.channel || !sessionState.started) return;
            const membersInChannel = oldState.channel.members;
            // Check if there are any participants in the meeting's voice channel.
            for (const member of membersInChannel) {
                // A participant is still in the channel -> do nothing.
                if (sessionState.participantIds.includes(member.user.id)) {
                    return;
                }
            }

            // Room empties and not paused -> pause meeting and auto-close after emptyRoomMs timeout
            try {
                if (!sessionState.paused) {
                    await client.botCoordinator.pauseMeeting(oldSession.sessionId);
                    clearTimeout(sessionState.timeouts.pauseTimeoutId);
                    sessionState.timeouts.pauseTimeoutId = setTimeout(async () => {
                        await client.botCoordinator.autoCloseMeeting(oldSession.sessionId);
                    }, timeoutDuration.emptyRoomMs);

                // Room empties and paused -> auto-close after pausedEmptyRoomMs timeout
                } else {
                    clearTimeout(sessionState.timeouts.pauseTimeoutId);
                    sessionState.timeouts.pauseTimeoutId = setTimeout(async () => {
                        await client.botCoordinator.autoCloseMeeting(oldSession.sessionId);
                    }, timeoutDuration.pausedEmptyRoomMs);
                }
                return;
            } catch (error) {
                return;
            }
          }

        // User joined the meeting channel (to null OR another channel)
        const newSession = newState.channelId
            ? client.sessionStore.getSessionByChannelId(newState.channelId)
            : null;
        if (!newSession || !newSession.sessionState.started) {
            return;
        }
        const userId = newState.id;
        const user = newState.member?.user ?? (await client.users.fetch(userId).catch(() => null));
        await client.botCoordinator.handleUserJoinedMeetingChannel(newSession.sessionId, userId, { user });
	},
};