const { MessageFlags, ActionRowBuilder } = require('discord.js');
const { execute } = require('../../../commands/utility/start.js');
const { sessionStore } = require('../../../session.js');

describe('start', () => {
    const interaction = {
        member: {
            voice: {
                channel: {
                    id: '123',
                    members: [{ user: { id: '123' } }, { user: { id: '456' } }, { user: { id: '789' } }],
                },
            },
        },
        reply: jest.fn().mockResolvedValue({ fetch: jest.fn().mockResolvedValue({ id: '123' }) }),
        deferUpdate: jest.fn().mockResolvedValue(undefined),
        followUp: jest.fn().mockResolvedValue(undefined),
        
    }
    beforeEach(() => {
        jest.useFakeTimers();
        sessionStore.clearSessions();
    });

    it('returns an error if the user is not connected to a voice channel', async () => {
        
        interaction.member.voice.channel = null;
        await execute(interaction);
        expect(interaction.reply).toHaveBeenCalledWith({
            content: 'Must be connected to a voice channel',
            flags: MessageFlags.Ephemeral,
        });
    });
    it('returns an error if a session already exists in the voice channel', async () => {
        interaction.member.voice.channel = { id: '123' };
        sessionStore.createSession('123', {
            participantIds: ['123', '456', '789'],
            voiceChannelId: '123',
            acceptedIds: [],
            disclaimerAccepted: false,
            originalInteraction: interaction,
            timeoutId: null,
        });
        await execute(interaction);
        expect(interaction.reply).toHaveBeenCalledWith({
            content: 'A session is already in progress in this channel',
            flags: MessageFlags.Ephemeral,
        });
    });
    it('creates a session and returns a message with the participants', async () => {
        interaction.member.voice.channel.members = [{ user: { id: '123' } }, { user: { id: '456' } }, { user: { id: '789' } }];
        await execute(interaction);
        expect(interaction.reply).toHaveBeenCalledWith({
            content: expect.stringContaining('Starting procedures for a meeting recording and summarization.'),
            components: expect.arrayContaining([expect.any(ActionRowBuilder)]),
        });
    })
});