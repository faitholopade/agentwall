const path = require("path");
require("dotenv").config();

const config = {
  // Server
  port: parseInt(process.env.PORT || "3000", 10),
  env: process.env.NODE_ENV || "development",

  // GitHub App
  github: {
    appId: process.env.GITHUB_APP_ID,
    privateKeyPath: path.resolve(process.env.GITHUB_APP_PRIVATE_KEY_PATH || "./private-key.pem"),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
  },

  // Database (":memory:" supported for tests)
  db: {
    path: process.env.DATABASE_PATH === ":memory:"
      ? ":memory:"
      : path.resolve(process.env.DATABASE_PATH || "./data/agentwall.db"),
  },

  // Dashboard
  dashboard: {
    secret: process.env.DASHBOARD_SECRET || "change-me",
  },

  // Enforcement behavior
  enforcement: {
    // Record what would happen but never touch PRs on GitHub
    monitorOnly: process.env.MONITOR_ONLY === "true",
    // Logins that bypass scanning entirely (comma-separated, case-insensitive)
    allowlist: (process.env.ALLOWLIST || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    // Skip GitHub App bots (dependabot[bot], renovate[bot], ...) by default
    skipBots: process.env.SKIP_BOTS !== "false",
    // Post a GitHub check run with the scan result on every analyzed PR
    // (requires the app to have the Checks: Read & write permission)
    checksEnabled: process.env.CHECKS_ENABLED !== "false",
  },

  // Scoring thresholds
  thresholds: {
    critical: 60,
    high: 40,
    medium: 20,
  },

  // Rate limits for GitHub API calls (per installation, per hour)
  rateLimits: {
    apiCallsPerHour: 4500, // GitHub allows 5000, we leave headroom
  },

  logLevel: process.env.LOG_LEVEL || "info",
};

// Validate required config on startup
function validate() {
  const missing = [];
  if (!config.github.appId) missing.push("GITHUB_APP_ID");
  if (!config.github.webhookSecret) missing.push("GITHUB_WEBHOOK_SECRET");
  if (config.dashboard.secret === "change-me") {
    console.warn("[AgentWall] WARNING: Using default DASHBOARD_SECRET. Set a strong secret in .env");
  }
  if (missing.length > 0) {
    console.error(`[AgentWall] Missing required env vars: ${missing.join(", ")}`);
    console.error("[AgentWall] Copy .env.example to .env and fill in your GitHub App credentials.");
    process.exit(1);
  }
}

module.exports = { config, validate };
