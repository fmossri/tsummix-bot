const { MessageFlags, DiscordAPIError } = require('discord.js');
const logger = require('../services/logger/logger');

async function interactionErrorHelper(interaction, errorMessage) {
	try {
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
                content: errorMessage,
                flags: MessageFlags.Ephemeral,
            });
        } else {
            await interaction.reply({
                content: errorMessage,
                flags: MessageFlags.Ephemeral,
            });
        }
    } catch (error) {
        if (error instanceof DiscordAPIError && error.code === 10062) {
            // Unknown interaction – too late / already handled.
            // Best effort: ignore.
            logger.debug('interaction-errors', 'Unknown interaction – too late / already handled.', {
                interactionId: interaction.id,
                errorClass: error.constructor?.name || 'Error',
                message: error.message,
            });
        return;
        }
    }
}

module.exports = { interactionErrorHelper };

