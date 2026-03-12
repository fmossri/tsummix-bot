const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { interactionErrorHelper } = require('../../utils/interaction-errors.js');

module.exports = {
	data: new SlashCommandBuilder().setName('pause').setDescription('Pauses the meeting recording'),
    async execute(interaction) {
        const member = interaction.member;
		const voiceChannel = member?.voice?.channel;
        const sessionStore = interaction.client.sessionStore;
        if (!voiceChannel) {
			await interaction.reply({
				content: 'Must be connected to a voice channel.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
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
            if (sessionState.started && !sessionState.paused) {
                await interaction.deferReply();
                await interaction.client.botCoordinator.pauseMeeting(sessionId);
                await interaction.deleteReply();
            } else {
                await interaction.reply({
                    content: 'Meeting recording is not in progress.',
                    flags: MessageFlags.Ephemeral,
                });
            }
		} catch (error) {
			await interactionErrorHelper(interaction, 'An error occurred while pausing the meeting recording.');
		}
	},
};