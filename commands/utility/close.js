const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { interactionErrorHelper } = require('../../utils/interaction-errors.js');

module.exports = {
	data: new SlashCommandBuilder().setName('close').setDescription('Closes the session and deletes the session data'),
	async execute(interaction) {
	    const member = interaction.member;
        const voiceChannel = member?.voice?.channel;
        const sessionStore = interaction.client.sessionStore;
        if (!voiceChannel) {
            await interaction.reply({
                content: 'Must be in the meeting\'s voice channel.',
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        if (!sessionStore.channelHasSession(voiceChannel.id)) {
            await interaction.reply({
                content: 'Meeting not found.',
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

		if (!sessionState.participantIds.length) {
			await interaction.reply({
				content: 'The meeting has not started yet.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
        try {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await interaction.client.botCoordinator.closeMeeting(sessionId, interaction);
        } catch (error) {
			await interactionErrorHelper(interaction, 'An error occurred while closing the meeting.');
        }
    },
};
