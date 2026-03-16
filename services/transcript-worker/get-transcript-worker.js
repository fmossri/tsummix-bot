const { createTranscriptWorker } = require('./transcript-worker.js');
const { createWorkerHttpClient } = require('./http-client.js');

function getTranscriptWorker({workerConfig, fetchImpl, fsImpl, pathImpl}) {
	if (workerConfig.localWorker) {
		return createTranscriptWorker({
			workerConfig,
			fetchImpl,
			fsImpl,
			pathImpl,
		});
	}

	return createWorkerHttpClient(workerConfig, fetchImpl);
}
    module.exports = {
        getTranscriptWorker,
    }