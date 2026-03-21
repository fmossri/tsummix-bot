function checkRecentSilence(buffer, holdSamples, threshold) {
    // Just check the very end of the buffer for 'holdSamples' duration
    const slice = buffer.subarray(buffer.length - (holdSamples * 2));
    return calculateRMS(slice) < threshold;
}

function calculateRMS(buffer) {
    if (!buffer || buffer.length < 2) return 0;
    let sumSquares = 0;
    let samples = 0;
    for (let i = 0; i + 1 < buffer.length; i += 2) {
        const sample = buffer.readInt16LE(i);
        sumSquares += sample * sample;
        samples++;
    }
    if (samples === 0) return 0;
    return Math.sqrt(sumSquares / samples);
}

function findLowestEnergyPoint(buffer, windowSize) {
    // Scan the last 'windowSize' of the buffer in small steps (e.g., 100ms)
    // and return the offset from the end where energy was lowest.
    let minEnergy = Infinity;
    let bestOffset = 0;
    const step = 1600; // 100ms steps

    for (let offset = 0; offset < windowSize; offset += step) {
        const start = buffer.length - ((offset + step) * 2);
        const end = buffer.length - (offset * 2);
        if (start < 0) break;

        const energy = calculateRMS(buffer.subarray(start, end));
        if (energy < minEnergy) {
            minEnergy = energy;
            bestOffset = offset;
        }
    }
    return bestOffset;
}


const chunkingStrategies = {
    'fixedSize': (state, config) => {
        const target = config.fixedSize;
        // If we have enough, tell the loop to cut exactly the target amount
        if (state.samplesInBuffer >= target) {
            return target; 
        }
        return null;
    },
    'silenceBased': (state, config, now) => {
        const { minSamples, maxSamples, holdSamples, silenceThreshold, tailWindowSamples } = config;

        // 1. Primary Strategy: Silence-based "clean" cut
        if (state.samplesInBuffer > minSamples) {
            const isSilent = checkRecentSilence(state.samplesBuffer, holdSamples, silenceThreshold);
            if (isSilent) return state.samplesInBuffer; // Cut everything we have
        }

        // 2. Fallback Strategy: Max length reached, find the "breath" point
        if (state.samplesInBuffer >= maxSamples) {
            // Look back at the last 3 seconds (tail window) to find lowest energy 
            const bestCutOffset = findLowestEnergyPoint(state.samplesBuffer, tailWindowSamples);
            // Return the absolute index where we should cut
            return state.samplesInBuffer - bestCutOffset;
        }

        const wallClockAge = now - state.chunkClockTimeMs;
        const audioDurationMs = (state.samplesInBuffer / 16000) * 1000;
        const silentGapMs = wallClockAge - audioDurationMs;

        // 3. Idle timeout strategy: Cut the buffer if it's been idle for too long
        if (silentGapMs > config.idleTimeoutMs && state.samplesInBuffer > 0) {
            return state.samplesInBuffer;
        }

        return null; // Don't cut yet
    },
};

function chooseChunkingStrategy(strategy) {
    return chunkingStrategies[strategy] || chunkingStrategies['fixedSize'];
}

module.exports = { chooseChunkingStrategy, calculateRMS, checkRecentSilence, findLowestEnergyPoint };
