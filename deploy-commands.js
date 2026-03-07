require('dotenv').config();

const { REST, Routes } = require('discord.js');
const { APP_ID: clientId, SERVER_ID: guildId, DISCORD_TOKEN: token } = process.env;
const fs = require('node:fs');
const path = require('node:path');

const commands = [];
// Grab all the command folders from the commands directory you created earlier
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	// Grab all the command files from the commands directory you created earlier
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
	// Grab the SlashCommandBuilder#toJSON() output of each command's data for deployment
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		if ('data' in command && 'execute' in command) {
			commands.push(command.data.toJSON());
		}
		else {
			console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

// Construct and prepare an instance of the REST module
const rest = new REST().setToken(token);

// and deploy your commands!
(async () => {
	try {
		console.log(`Started refreshing ${commands.length} application (/) commands.`);

		if (guildId) {
			// Deploy to a single guild (instant; useful for development / dry dock)
			const data = await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
			console.log(`Successfully reloaded ${data.length} application (/) commands in guild ${guildId}.`);
		}
		else {
			// Deploy globally (commands available in all servers where the bot is invited; can take up to 1 hour to propagate)
			const data = await rest.put(Routes.applicationCommands(clientId), { body: commands });
			console.log(`Successfully reloaded ${data.length} application (/) commands globally.`);
		}
	}
	catch (error) {
		// And of course, make sure you catch and log any errors!
		console.error(error);
	}
})();
