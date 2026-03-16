const fs = require('node:fs');
const path = require('node:path');

const { Client, Collection, GatewayIntentBits } = require('discord.js');
const config = require('./config/index.js');
const { sessionStore } = require('./session.js');
const { createSessionManager } = require('./services/session-manager/session-manager.js');
const { getTranscriptWorker } = require('./services/transcript-worker/get-transcript-worker.js');
const { createReportGenerator } = require('./services/report-generator/report-generator.js');
const { createSummaryGenerator } = require('./services/report-generator/summary-generator.js');
const { createBotCoordinator } = require('./coordinator/bot-coordinator.js');

const token = config.discordToken;

if (!token) {
    console.error('DISCORD_TOKEN must be set in .env');
    process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
/*client.on('debug', console.log)
      .on('warn', console.log)

client.on('raw', (packet) => {
  if (packet.t === 'VOICE_STATE_UPDATE' || packet.t === 'VOICE_SERVER_UPDATE') {
    console.log('[RAW VOICE EVENT]', packet.t, packet.d);
  }
});

client.on('raw', (packet) => {
    if (packet.t === 'VOICE_STATE_UPDATE' || packet.t === 'VOICE_SERVER_UPDATE') {
      console.log('[RAW VOICE EVENT]', packet.t, packet.d);
    }
  });
*/
client.sessionStore = sessionStore;
client.botCoordinator = createBotCoordinator(config.coordinatorConfig, sessionStore);

const transcriptWorker = getTranscriptWorker({
    workerConfig: config.workerConfig,
    fetchImpl: fetch,
    fsImpl: fs,
    pathImpl: path,
});

client.sessionManager = createSessionManager({
    managerConfig: config.managerConfig, 
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
