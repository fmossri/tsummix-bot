/**
 * Worker HTTP client: transport only. Does not log; the session manager is the
 * canonical logger for start/enqueue/close failures (ERROR-HANDLING, OBSERVABILITY-PLAN).
 * On failure: throws so the caller can retry and/or log once with full context.
 */
function createWorkerHttpClient(workerConfig, fetchImpl) {
    function throwOnNotOk(response, action) {
        if (response.ok) return;
        const statusPart = [response.status, response.statusText].filter(Boolean).join(' ');
        const err = new Error(statusPart ? `${action}: ${statusPart}` : action);
        if (response.status != null) err.statusCode = response.status;
        throw err;
    }

    async function startTranscript(transcriptId, meetingStartTimeMs) {
        const response = await fetchImpl(`${workerConfig.workerBaseUrl}/start-transcript`, {
            headers: {
                'Content-Type': 'application/json',
            },
            method: 'POST',
            body: JSON.stringify({ transcriptId, meetingStartTimeMs }),
        });
        throwOnNotOk(response, 'Failed to start transcript');
        const { transcriptPath } = await response.json();
        return transcriptPath;
    }

    async function enqueueChunk(transcriptId, chunk) {
        const audioBase64 = Buffer.isBuffer(chunk.audio) ? chunk.audio.toString('base64') : chunk.audio;
        const payload = { ...chunk, audio: audioBase64 };
        const response = await fetchImpl(`${workerConfig.workerBaseUrl}/enqueue-chunk`, {
            headers: {
                'Content-Type': 'application/json',
            },
            method: 'POST',
            body: JSON.stringify({ transcriptId, chunk: payload }),
        });
        throwOnNotOk(response, 'Failed to enqueue chunk');
        return true;
    }

    async function closeTranscript(transcriptId, { channelId, participantDisplayNames, closure } = {}) {
        const response = await fetchImpl(`${workerConfig.workerBaseUrl}/close-transcript`, {
            headers: {
                'Content-Type': 'application/json',
            },
            method: 'POST',
            body: JSON.stringify({ transcriptId, channelId, participantDisplayNames, closure }),
        });
        throwOnNotOk(response, 'Failed to close transcript');
        return true;
    }

    return {
        startTranscript,
        enqueueChunk,
        closeTranscript,
    }
}

module.exports = {
    createWorkerHttpClient,
}