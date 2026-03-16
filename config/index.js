require('dotenv').config();

//Manager default config

//Max retries for enqueuing chunks to the worker
const MANAGER_MAX_RETRIES = 3;
//Timeout for the LLM to generate a summary
const DEFAULT_LLM_TIMEOUT_MS = 20000;

//Worker default config

//Max retries for sending chunks to STT
const WORKER_MAX_RETRIES = 3;
//Number of chunks to process before flushing the transcript
const FLUSH_AFTER_PROCESSED_CHUNKS = 5;
//Timeout for each STT request
const DEFAULT_STT_TIMEOUT_MS = 5000;
//Timeout for the STT wrapper to be ready
const DEFAULT_STT_READY_TIMEOUT_MS = 120000;
//Time interval between each GET /health attempt while waiting for the STT wrapper to be ready
const DEFAULT_STT_READY_POLL_MS = 2000;

function getInt(name, fallback) {
    const raw = process.env[name];
    const parsed = raw != null ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

function getBoolean(name, fallback) {
    const raw = process.env[name];
    const parsed = raw != null ? raw.toLowerCase().trim() === 'true' : fallback;
    return parsed;
  }

function requireBaseUrl(name) {
    const raw = process.env[name]?.trim();
    if (!raw) {
        throw new Error(`${name} must be set in .env`);
    }
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`${name} must be a valid URL`);
    }
    return url.origin;
}

function requireDiscordToken(token) {
    if (!token) {
        throw new Error('DISCORD_TOKEN must be set in .env');
    }
    if (typeof token !== 'string') {
        throw new Error('DISCORD_TOKEN must be a string');
    }
    const tokenRegex = /^[MNOR][\w-]{23,25}\.[\w-]{6}\.[\w-]{27,39}$/;
    if (!tokenRegex.test(token)) {
        console.warn('Possible invalid DISCORD_TOKEN');
    }
    return token;
}
function validateUseLocal(name) {
    const useLocal = getBoolean(`${name}_USE_LOCAL`, true);
    if (!useLocal) {
        requireBaseUrl(`${name}_BASE_URL`);
    }
    return useLocal;
}

module.exports = {
    //Client config
    discordToken: requireDiscordToken(process.env.DISCORD_TOKEN),
    //Controller config
    controllerConfig: {
        meetingTimeouts: {
            //Timeout for explicitly pausing the meeting
            explicitPauseMs: 30 * 60 * 1000,
            //Timeout for paused empty room
            pausedEmptyRoomMs: 15 * 60 * 1000,
            //Timeout for empty room
            emptyRoomMs: 5 * 60 * 1000,
            //Timeout for aceepting the disclaimer and close-confirm buttons
            uiTimeoutMs: 60 * 1000,
        },
    },
    //Manager config
    managerConfig: {
        //Whether the manager runs in-process or is called over HTTP
        localManager: validateUseLocal('MANAGER'),
        //Port for the manager HTTP server
        managerPort: getInt('MANAGER_PORT', 3002),
        //Base URL for the worker HTTP server
        workerBaseUrl: !getBoolean('WORKER_USE_LOCAL', true) ? requireBaseUrl('WORKER_BASE_URL') : 'http://localhost:3000',
        //Max retries for enqueuing chunks to the worker
        maxRetries: MANAGER_MAX_RETRIES,
        //Timeout for the LLM to generate a summary
        llmTimeoutMs: getInt('LLM_TIMEOUT_MS', DEFAULT_LLM_TIMEOUT_MS),
    },
    //Worker config
    workerConfig: {
        //Whether the worker runs in-process or is called over HTTP
        localWorker: validateUseLocal('WORKER'),
        //Port for the worker HTTP server
        workerPort: getInt('WORKER_PORT', 3000),
        //Base URL for the STT wrapper
        sttBaseUrl: requireBaseUrl('STT_BASE_URL'),
        //Max retries for sending chunks to STT
        maxRetries: WORKER_MAX_RETRIES,
        //Number of chunks to process before flushing the transcript
        flushAfterProcessedChunks: FLUSH_AFTER_PROCESSED_CHUNKS,
        workerTimeouts: {
            //Timeout for each STT request
            sttTimeoutMs: getInt('STT_TIMEOUT_MS',  DEFAULT_STT_TIMEOUT_MS),
            //Timeout for the STT wrapper to be ready
            sttReadyTimeoutMs: getInt('STT_READY_TIMEOUT_MS', DEFAULT_STT_READY_TIMEOUT_MS),
            //Time interval between each GET /health attempt while waiting for the STT wrapper to be ready
            sttReadyPollMs: getInt('STT_READY_POLL_MS', DEFAULT_STT_READY_POLL_MS),
        },
    },
};
