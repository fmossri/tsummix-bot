const { MessageFlags } = require('discord.js');
const { sessionStore } = require('./session.js');

const handleDisclaimerButtons = async (interaction) => {
    const messageId = interaction.message.id;
	const session = sessionStore.getSessionById(messageId);

	if (!session) {
		console.log('no session found.', messageId);
		await interaction.deferUpdate();
		return;
	}

	if (interaction.customId === 'disclaimer-accept') {
		if (!session.disclaimerAccepted && session.participantIds.includes(interaction.user.id) && !session.acceptedIds.includes(interaction.user.id)) {
			session.acceptedIds.push(interaction.user.id);
			await interaction.reply({
				content: 'Disclaimer accepted.',
				flags: MessageFlags.Ephemeral,
			});

			if (session.acceptedIds.length === session.participantIds.length) {
				clearTimeout(session.timeoutId);
				session.disclaimerAccepted = true;
				console.log('disclaimerAccepted = true');

				await session.originalInteraction.followUp({
					content: 'All users have accepted the disclaimer. Starting recording.',
				});
                interaction.client.sessionManager.startMeeting(messageId);
				return;
			}
		}
		else {await interaction.deferUpdate();}

	}
	else if (interaction.customId === 'disclaimer-reject') {
		if (!session.disclaimerAccepted && session.participantIds.includes(interaction.user.id) && !session.acceptedIds.includes(interaction.user.id)) {
			await interaction.reply({
				content: 'Disclaimer rejected.',
				flags: MessageFlags.Ephemeral,
			});
			clearTimeout(session.timeoutId);
			await session.originalInteraction.followUp({
				content: 'All users must accept the disclaimer to start recording. Session terminated.',
			});
			sessionStore.deleteSession(interaction.message.id);

			console.log('disclaimer rejected and session deleted.');
			return;
		}
		else {
			await interaction.deferUpdate();
		}
	}
	else {
		await interaction.deferUpdate();
	}
};

module.exports = {
	handleDisclaimerButtons,
};
