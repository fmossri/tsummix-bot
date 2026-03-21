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
const DEFAULT_STT_READY_POLL_MS = 500;

function getNonZeroInt(name, fallback) {
    const raw = process.env[name];
    const parsed = raw != null ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

function getBoolean(name, fallback) {
    const raw = process.env[name];
    const parsed = raw != null ? raw.toLowerCase().trim() === 'true' : fallback;
    return parsed;
  }

function getChunkingStrategy(name) {
    const validStrategies = ['fixedSize', 'silenceBased'];
    const raw = process.env[name];
    const parsed = raw != null ? raw.toLowerCase().trim() : 'fixedSize';
    if (!validStrategies.includes(parsed)) {
        throw new Error(`Invalid chunking strategy: ${parsed}\nValid strategies: ${validStrategies.join(', ')}`);
    }
    return parsed;
}

function requireBaseUrl(name) {
    const raw = process.env[name]?.trim();
    if (!raw) {
        throw new Error(`${name} must be set in .env`);
    }
    try {
        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error(`${name} must be a valid HTTP or HTTPS URL`);
        }
        return url.origin;
    } catch (error) {
        throw new Error(`Failed to parse ${name} as a URL: ${error.message}`);
    }
}

function requireStringToken(name) {
    const token = process.env[`${name}_AUTH_TOKEN`];
    if (!token) {
        throw new Error(`${name}_AUTH_TOKEN must be set in .env`);
    }
    if (name === 'DISCORD') {
        const tokenRegex = /^[MNOR][\w-]{23,25}\.[\w-]{6}\.[\w-]{27,39}$/;
        if (!tokenRegex.test(token)) {
            console.warn('Possible invalid DISCORD_AUTH_TOKEN');
        }
    }
    return token;
}

const minSamples = (getNonZeroInt('MIN_CHUNK_MS', 20 * 1000) / 1000) * 16000;
const maxSamples = (getNonZeroInt('MAX_CHUNK_MS', 30 * 1000) / 1000) * 16000;
const holdSamples = (getNonZeroInt('SILENCE_HOLD_MS', 1000) / 1000) * 16000;
const tailWindowSamples = (getNonZeroInt('TAIL_WINDOW_MS', 3 * 1000) / 1000) * 16000;
const silenceThreshold = getNonZeroInt('SILENCE_THRESHOLD', 500);
const idleTimeoutMs = getNonZeroInt('IDLE_TIMEOUT_MS', 5 * 1000);

const workerUseLocal = getBoolean('WORKER_USE_LOCAL', true);
const resolvedWorkerBaseUrl = workerUseLocal
    ? 'http://localhost:3000'
    : requireBaseUrl('WORKER_BASE_URL');
const resolvedWorkerAuthToken = workerUseLocal
    ? null
    : requireStringToken('WORKER');


module.exports = {
    //Client config
    discordToken: requireStringToken('DISCORD'),
    //Controller config
    controllerConfig: {
        meetingTimeouts: {
            //Timeout for explicitly pausing the meeting
            explicitPauseMs: 30 * 60 * 1000,
            //Timeout for paused empty room
            pausedEmptyRoomMs: 15 * 60 * 1000,
            //Timeout for empty room
            emptyRoomMs: 5 * 60 * 1000,
            //Timeout for accepting the disclaimer and close-confirm buttons
            uiTimeoutMs: 60 * 1000,
        },
    },
    //Manager config
    managerConfig: {
        //Port for the manager HTTP server
        managerPort: getNonZeroInt('MANAGER_PORT', 3002),
        //Auth token for the bot to access the worker
        workerAuthToken: resolvedWorkerAuthToken,
        //Base URL for the worker HTTP server
        workerBaseUrl: resolvedWorkerBaseUrl,
        //Max retries for enqueuing chunks to the worker
        maxRetries: MANAGER_MAX_RETRIES,
        //Timeout for the LLM to generate a summary
        llmTimeoutMs: getNonZeroInt('LLM_TIMEOUT_MS', DEFAULT_LLM_TIMEOUT_MS),
        chunkerConfig: {
            //Chunking strategy
            chunkingStrategy: getChunkingStrategy('CHUNKING_STRATEGY'),
            //Fixed size for the chunks
            fixedSize: maxSamples,
            //Silence threshold for the chunks
            silenceThreshold: silenceThreshold,
            //Silence hold time for the chunks
            holdSamples: holdSamples,
            //Minimum chunk duration
            minSamples: minSamples,
            //Maximum chunk duration
            maxSamples: maxSamples,
            //Tail window size for finding the lowest energy point
            tailWindowSamples: tailWindowSamples,
            //Idle stream timeout for cutting chunks
            idleTimeoutMs: idleTimeoutMs,
        },
    },
    //Worker config
    workerConfig: {
        //Auth token for the bot to access the worker
        workerAuthToken: resolvedWorkerAuthToken,
        //Auth token for the worker to access the STT wrapper
        sttAuthToken: requireStringToken('STT'),
        //Whether the worker runs in-process or is called over HTTP
        localWorker: workerUseLocal,
        //Port for the worker HTTP server
        workerPort: getNonZeroInt('WORKER_PORT', 3000),
        //Base URL for the STT wrapper
        sttBaseUrl: requireBaseUrl('STT_BASE_URL'),
        //Max retries for sending chunks to STT
        maxRetries: WORKER_MAX_RETRIES,
        //Number of chunks to process before flushing the transcript
        flushAfterProcessedChunks: FLUSH_AFTER_PROCESSED_CHUNKS,
        workerTimeouts: {
            //Timeout for each STT request
            sttTimeoutMs: getNonZeroInt('STT_TIMEOUT_MS',  DEFAULT_STT_TIMEOUT_MS),
            //Timeout for the STT wrapper to be ready
            sttReadyTimeoutMs: getNonZeroInt('STT_READY_TIMEOUT_MS', DEFAULT_STT_READY_TIMEOUT_MS),
            //Time interval between each GET /health attempt while waiting for the STT wrapper to be ready
            sttReadyPollMs: getNonZeroInt('STT_READY_POLL_MS', DEFAULT_STT_READY_POLL_MS),
        },
    },
};
