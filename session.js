const sessions = new Map();

const sessionStore = {

	createSession(messageId, sessionData) {
		sessions.set(messageId, sessionData);
		console.log('debug message: session created!');
	},
	findSessionByChannelId(channelId) {
		for (const [messageId, sessionData] of sessions.entries()) {
			if (sessionData.voiceChannelId === channelId) {
				return { messageId, sessionData };
			}
		}
		return null;
	},

	getSessionByMessageId(messageId) {
		return sessions.get(messageId);
	},

	getSessionByChannelId(channelId) {
		return this.findSessionByChannelId(channelId);
	},
	deleteSession(messageId) {
		if (!sessions.has(messageId)) {
			console.log('no session found by message id.', messageId);
			return;
		}
		sessions.delete(messageId);
		console.log('session deleted by message id.', messageId);
	},

	channelHasSession(channelId) {
		return this.findSessionByChannelId(channelId) !== null;
	},

	clearSessions() {
		sessions.clear();
	},
};

module.exports = {
	sessionStore,
};
