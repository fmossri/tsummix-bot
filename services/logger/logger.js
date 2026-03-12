const LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];

// Minimum level to log, defaults to 'info' if unset or invalid. 'silent' = no output.
const ENV_LEVEL = process.env.LOG_LEVEL;
const MIN_LEVEL = LEVELS.includes(ENV_LEVEL) ? ENV_LEVEL : 'info';
const MIN_INDEX = LEVELS.indexOf(MIN_LEVEL);

function shouldLog(level) {
  if (MIN_LEVEL === 'silent') return false;
  const idx = LEVELS.indexOf(level);
  return idx !== -1 && idx >= MIN_INDEX;
}

function log(level, component, event, message, context = {}) {
  if (!shouldLog(level)) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    component,
    event,
    message,
    context,
  };

  try {
    // Single JSON line to stdout
    // Using write instead of console.log to avoid extra formatting.
    process.stdout.write(JSON.stringify(entry) + '\n');
  } catch {
    // If logging itself fails, we do not throw; avoid breaking the app on log errors.
  }
}

module.exports = {
  debug(component, event, message, context) {
    log('debug', component, event, message, context);
  },
  info(component, event, message, context) {
    log('info', component, event, message, context);
  },
  warn(component, event, message, context) {
    log('warn', component, event, message, context);
  },
  error(component, event, message, context) {
    log('error', component, event, message, context);
  },
};

