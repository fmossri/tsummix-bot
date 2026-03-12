const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { interactionErrorHelper } = require('../../utils/interaction-errors.js');

module.exports = {
    data: new SlashCommandBuilder().setName('resume').setDescription('Resumes the meeting recording'),
    async execute(interaction) {
        const member = interaction.member;
        const voiceChannel = member?.voice?.channel;
        if (!voiceChannel) {
            await interaction.reply({
                content: 'Must be connected to the meeting\'s voice channel.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        const sessionStore = interaction.client.sessionStore;
        if (!sessionStore.channelHasSession(voiceChannel.id)) {
			await interaction.reply({
				content: 'No meeting is in progress in this channel.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
        const { sessionId, sessionState } = sessionStore.getSessionByChannelId(voiceChannel.id);
        if (!sessionState.participantIds.includes(member.user.id)) {
			await interaction.reply({
				content: 'You are not a participant in this meeting.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
        try {
            if (sessionState.started && sessionState.paused) {
                await interaction.deferReply();
                if (!(await interaction.client.botCoordinator.resumeMeeting(sessionId))) {
                    await interaction.editReply({
                        content: 'Failed to resume the meeting recording.',
                        flags: MessageFlags.Ephemeral,
                    });
                } else await interaction.deleteReply();
            } else {
                await interaction.reply({
                    content: 'Meeting recording is not paused.',
                    flags: MessageFlags.Ephemeral,
                });
            }
        } catch (error) {
            await interactionErrorHelper(interaction, 'An error occurred while resuming the meeting.');
        }
    },
};