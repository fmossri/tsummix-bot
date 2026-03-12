const { Events } = require('discord.js');
const { interactionErrorHelper } = require('../utils/interaction-errors.js');

module.exports = {
	name: Events.InteractionCreate,
	async execute(interaction) {
		if (interaction.isChatInputCommand()) {
			const command = interaction.client.commands.get(interaction.commandName);

			if (!command) {
				return;
			}

			try {
				await command.execute(interaction);
			}
			catch (error) {
				await interactionErrorHelper(interaction, 'There was an error while executing this command!');
			}
		}
		else if (interaction.isButton()) {
			try {
				await interaction.client.botCoordinator.handleButtonInteraction(interaction);
			}
			catch (error) {
				await interactionErrorHelper(interaction, 'There was an error while handling this button.');
			}
		}
		else {return;}
	},
};
