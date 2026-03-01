const { sessionStore } = require('../session.js');

describe('sessionStore', () => {
	beforeEach(() => {
		sessionStore.clearSessions();
        sessionStore.createSession('234', {
            participantIds: ['123', '456', '789'],
            voiceChannelId: '432',
            acceptedIds: [],
            disclaimerAccepted: false,
            originalInteraction: 'interaction',
            timeoutId: null,
        });
	});
    describe('mutations', () => {
        it('creates a session', () => {
            sessionStore.createSession('123', {
                participantIds: ['123', '456', '789'],
                voiceChannelId: '123',
                acceptedIds: [],
                disclaimerAccepted: false,
                originalInteraction: 'interaction',
                timeoutId: null,
            });
            expect(sessionStore.getSessionByMessageId('123')).toEqual({
                participantIds: ['123', '456', '789'],
                voiceChannelId: '123',
                acceptedIds: [],
                disclaimerAccepted: false,
                originalInteraction: 'interaction',
                timeoutId: null,
            });
        });
        it('deletes a session', () => {
            sessionStore.deleteSession('234');
            expect(sessionStore.getSessionByMessageId('234')).toBeUndefined();
        });
        it('returns undefined when delete session not found', () => {
            expect(sessionStore.deleteSession('123')).toBeUndefined();
        });
        it('clears all sessions', () => {   
            sessionStore.clearSessions();
            expect(sessionStore.getSessionByMessageId('234')).toBeUndefined();
            expect(sessionStore.channelHasSession('432')).toBe(false);
            expect(sessionStore.findSessionByChannelId('432')).toBeNull();
        });
    });
    describe('queries', () => {
        it('finds a session by channel id', () => {
            expect(sessionStore.findSessionByChannelId('432')).toEqual({
                messageId: '234',
                sessionData: {
                    participantIds: ['123', '456', '789'],
                    voiceChannelId: '432',
                    acceptedIds: [],
                    disclaimerAccepted: false,
                    originalInteraction: 'interaction',
                    timeoutId: null,
                },
            });
        });
        it('returns null when find session by channel id not found', () => {
            expect(sessionStore.findSessionByChannelId('123')).toBeNull();
        });
        it('gets a session by message id', () => {
            expect(sessionStore.getSessionByMessageId('234')).toEqual({
                participantIds: ['123', '456', '789'],
                voiceChannelId: '432',
                acceptedIds: [],
                disclaimerAccepted: false,
                originalInteraction: 'interaction',
                timeoutId: null,
            });
        });
        it('returns underfined when get session by message id not found', () => {
            expect(sessionStore.getSessionByMessageId('123')).toBeUndefined();
        });
        it('gets a session by channel id', () => {
            expect(sessionStore.getSessionByChannelId('432')).toEqual({
                messageId: '234',
                sessionData: {
                    participantIds: ['123', '456', '789'],
                    voiceChannelId: '432',
                    acceptedIds: [],
                    disclaimerAccepted: false,
                    originalInteraction: 'interaction',
                    timeoutId: null,
                },
            });
        });
        it('returns null when get session by channel id not found', () => {
            expect(sessionStore.getSessionByChannelId('123')).toBeNull();
        });
        it('checks if a channel has a session', () => {
            expect(sessionStore.channelHasSession('432')).toBe(true);
            expect(sessionStore.channelHasSession('123')).toBe(false);
        });
    });
});