const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { sessionStore } = require('../../session.js');

module.exports = {
	data: new SlashCommandBuilder().setName('close').setDescription('Closes the session and deletes the session data'),
	async execute(interaction) {
		const member = interaction.member;
		if (!member.voice.channel) {
			await interaction.reply({
				content: 'Must be connected to a voice channel',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const voiceChannel = member.voice.channel;
		if (!sessionStore.channelHasSession(voiceChannel.id)) {
			await interaction.reply({
				content: 'No session found in this channel.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		const session = sessionStore.getSessionByChannelId(voiceChannel.id);
		if (!session.sessionData.participantIds.includes(member.user.id)) {
			await interaction.reply({
				content: 'You are not a participant in this session.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
		if (!session.sessionData.disclaimerAccepted) {
			await interaction.reply({
				content: 'The meeting has not started yet.',
				flags: MessageFlags.Ephemeral,
			});
			return;
		}

		await interaction.client.sessionManager.finishMeeting(session.sessionId);
		await interaction.reply({
			content: 'The meeting is over. Thank you for participating.',
		});
		console.log('meeting finished.');
	},
};
