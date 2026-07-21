const { config } = require("../config");

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LEVELS[config.logLevel] ?? LEVELS.info;

function fmt(level, scope, msg, data) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}] [${scope}]`;
  if (data) {
    return `${prefix} ${msg} ${JSON.stringify(data)}`;
  }
  return `${prefix} ${msg}`;
}

function createLogger(scope) {
  return {
    error: (msg, data) => {
      if (currentLevel >= LEVELS.error) console.error(fmt("error", scope, msg, data));
    },
    warn: (msg, data) => {
      if (currentLevel >= LEVELS.warn) console.warn(fmt("warn", scope, msg, data));
    },
    info: (msg, data) => {
      if (currentLevel >= LEVELS.info) console.log(fmt("info", scope, msg, data));
    },
    debug: (msg, data) => {
      if (currentLevel >= LEVELS.debug) console.log(fmt("debug", scope, msg, data));
    },
  };
}

module.exports = { createLogger };
