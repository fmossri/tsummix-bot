const wav = require('node-wav');

/**
 * Converts a buffer of 16-bit PCM samples to WAV format.
 * @param {Buffer} pcmBuffer - Raw PCM (16-bit signed, mono).
 * @param {number} sampleRate - Sample rate in Hz (e.g. 16000).
 * @returns {Buffer} WAV file buffer.
 */
function convertPCMToWav(pcmBuffer, sampleRate) {
    const int16View = new Int16Array(
        pcmBuffer.buffer,
        pcmBuffer.byteOffset,
        pcmBuffer.length / 2
    );
    const floatSamples = new Float32Array(int16View.length);
    for (let i = 0; i < int16View.length; i++) {
        floatSamples[i] = int16View[i] / 32768;
    }
    return wav.encode([floatSamples], { sampleRate, bitDepth: 16 });
}

module.exports = { convertPCMToWav };
