const { sessionStore } = require('../session.js');
const { Events } = require('discord.js');

module.exports = {
    name: Events.VoiceStateUpdate,
    async execute(oldState, newState, client) {
        if (!newState.channelId) {
            return;
        }
        const sessionJoined = sessionStore.getSessionByChannelId(newState.channelId);
        if (sessionJoined) {
            if (!sessionJoined.sessionData.participantIds.includes(newState.user.id)) {
                return;
            }
            client.sessionManager.resubscribeToStream(sessionJoined.sessionId, newState.member.id);
        }
    },
};