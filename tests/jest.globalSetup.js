// Runs in the main Jest process (before reporters initialize).
// Guards against RangeError: Invalid count value in the progress-bar reporter
// when process.stdout.columns is undefined or too small (e.g. WSL2, narrow terminals).
module.exports = async () => {
    if (!process.stdout.columns || process.stdout.columns < 80) {
        process.stdout.columns = 120;
    }
};
