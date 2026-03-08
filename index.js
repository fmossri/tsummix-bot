require('dotenv').config();
const fetch = import('node-fetch');
const fs = require('node:fs');
const path = require('node:path');

const { Client, Collection, GatewayIntentBits } = require('discord.js');
const { sessionStore } = require('./session.js');
const { createSessionManager } = require('./services/session-manager/session-manager.js');
const { createTranscriptWorker } = require('./services/transcript-worker/transcript-worker.js');
const { createReportGenerator } = require('./services/report-generator/report-generator.js');
const { createSummaryGenerator } = require('./services/report-generator/summary-generator.js');
const { createBotCoordinator } = require('./coordinator/bot-coordinator.js');


const { DISCORD_TOKEN: token, STT_BASE_URL: sttBaseUrl } = process.env;

if (!sttBaseUrl) {
    console.error('STT_BASE_URL must be set in .env (e.g. http://localhost:8000)');
    process.exit(1);
}
if (!token) {
    console.error('DISCORD_TOKEN must be set in .env');
    process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });

client.sessionStore = sessionStore;
client.botCoordinator = createBotCoordinator(sessionStore);

const transcriptWorker = createTranscriptWorker({
    sttBaseUrl,
    fetchImpl: fetch,
    fsImpl: fs,
    pathImpl: path,
});

client.sessionManager = createSessionManager({
    sessionStore,
    createReportGenerator,
    createSummaryGenerator,
    transcriptWorker,
});
client.commands = new Collection();
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		if ('data' in command && 'execute' in command) {
			client.commands.set(command.data.name, command);
		}
		else {
			console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter((file) => file.endsWith('.js'));
for (const file of eventFiles) {
	const filePath = path.join(eventsPath, file);
	const event = require(filePath);
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args, client));
	}
	else {
		client.on(event.name, (...args) => event.execute(...args, client));
	}
}

client.login(token);
