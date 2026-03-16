const wav = require('node-wav');

function isValidWav(audioBuffer) {
    const SAMPLE_RATE = 16000;
    const WAV_CHANNELS = 1;
	try {
		const result = wav.decode(audioBuffer);
		if (result.sampleRate !== SAMPLE_RATE || result.channelData.length !== WAV_CHANNELS) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

module.exports = { isValidWav };