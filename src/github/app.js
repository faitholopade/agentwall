const fs = require("fs");
const { createAppAuth } = require("@octokit/auth-app");
const { Octokit } = require("@octokit/rest");
const { config } = require("../config");
const { createLogger } = require("../utils/logger");

const log = createLogger("github-app");

let privateKey = null;

function getPrivateKey() {
  if (privateKey) return privateKey;
  try {
    privateKey = fs.readFileSync(config.github.privateKeyPath, "utf8");
    return privateKey;
  } catch (err) {
    log.error(`Failed to read private key from ${config.github.privateKeyPath}`, { error: err.message });
    throw new Error(
      `Cannot read GitHub App private key. Make sure the .pem file exists at: ${config.github.privateKeyPath}\n` +
      `Download it from https://github.com/settings/apps -> your app -> Generate a private key`
    );
  }
}

/**
 * Create an authenticated Octokit instance for a specific installation.
 * This gives us access to repos that installed the app.
 */
function getInstallationOctokit(installationId) {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.github.appId,
      privateKey: getPrivateKey(),
      installationId,
    },
  });
  return octokit;
}

/**
 * Create an Octokit instance authenticated as the App itself (not installation).
 * Limited to app-level endpoints.
 */
function getAppOctokit() {
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.github.appId,
      privateKey: getPrivateKey(),
    },
  });
  return octokit;
}

/**
 * Create an unauthenticated Octokit for public API calls.
 * Rate limited to 60 requests/hour but doesn't need installation auth.
 */
function getPublicOctokit() {
  return new Octokit();
}

module.exports = { getInstallationOctokit, getAppOctokit, getPublicOctokit };
