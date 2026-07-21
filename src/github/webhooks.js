const { Webhooks } = require("@octokit/webhooks");
const { config } = require("../config");
const { createLogger } = require("../utils/logger");
const { analyzeContribution } = require("../engine/analyzer");
const { evaluateAndEnforce } = require("../engine/policies");
const { fetchPRCommitMessages, postScanCheckRun } = require("./api");
const { upsertInstallation, removeInstallation, isVerifiedContributor } = require("../database/queries");

const log = createLogger("webhooks");

function createWebhookHandler() {
  const webhooks = new Webhooks({
    secret: config.github.webhookSecret,
  });

  // ── Pull Request Events ─────────────────────────────────────────
  webhooks.on("pull_request.opened", handlePROpened);
  webhooks.on("pull_request.reopened", handlePROpened);
  webhooks.on("pull_request.synchronize", handlePRSync);

  // ── Installation Events ─────────────────────────────────────────
  webhooks.on("installation.created", handleInstallCreated);
  webhooks.on("installation.deleted", handleInstallDeleted);

  // ── Error handling ──────────────────────────────────────────────
  webhooks.onError((error) => {
    log.error("Webhook processing error", { error: error.message });
  });

  return webhooks;
}

/**
 * Handle new or reopened pull requests — main analysis pipeline.
 */
async function handlePROpened({ id, name, payload }) {
  const pr = payload.pull_request;
  const repo = payload.repository;
  const installationId = payload.installation?.id;

  if (!installationId) {
    log.warn("Received PR event without installation ID, skipping");
    return;
  }

  // Registered GitHub App bots (dependabot[bot], renovate[bot], ...) are
  // already attributed automation — not what AgentWall hunts for.
  if (config.enforcement.skipBots && (pr.user.type === "Bot" || pr.user.login.endsWith("[bot]"))) {
    log.info(`Skipping registered bot ${pr.user.login} on ${repo.full_name}#${pr.number}`);
    return;
  }

  if (config.enforcement.allowlist.includes(pr.user.login.toLowerCase())) {
    log.info(`Skipping allowlisted contributor ${pr.user.login} on ${repo.full_name}#${pr.number}`);
    return;
  }

  if (isVerifiedContributor(pr.user.login)) {
    log.info(`Skipping verified contributor ${pr.user.login} on ${repo.full_name}#${pr.number}`);
    return;
  }

  const prData = {
    contributor_login: pr.user.login,
    pr_number: pr.number,
    repo_full_name: repo.full_name,
    pr_title: pr.title,
    pr_url: pr.html_url,
    pr_body: pr.body || null,
    pr_commit_messages: await fetchPRCommitMessages(repo.owner.login, repo.name, pr.number, installationId),
    head_sha: pr.head?.sha,
    owner: repo.owner.login,
    repo: repo.name,
  };

  log.info(`New PR: ${repo.full_name}#${pr.number} by ${pr.user.login}`);

  try {
    // Run the analysis pipeline
    const scanResult = await analyzeContribution(prData, installationId);

    // Evaluate policies and take action
    const enforcement = await evaluateAndEnforce(scanResult, prData, installationId);

    // Surface the result as a check run so branch protection can gate on it
    if (config.enforcement.checksEnabled && prData.head_sha) {
      await postScanCheckRun(prData.owner, prData.repo, prData.head_sha, scanResult, enforcement, installationId);
    }

    // Update the scan record with the action taken (prefixed when the
    // action was only simulated in monitor-only mode)
    if (enforcement.action !== "none") {
      const { getDb } = require("../database/init");
      const db = getDb();
      const recorded = enforcement.enforced ? enforcement.action : `monitor:${enforcement.action}`;
      db.prepare("UPDATE scans SET action_taken = ? WHERE id = ?")
        .run(recorded, scanResult.scan_id);
    }

    log.info(`PR ${repo.full_name}#${pr.number} processed: score=${scanResult.risk_score}, action=${enforcement.action}`);
  } catch (err) {
    log.error(`Failed to process PR ${repo.full_name}#${pr.number}`, {
      error: err.message,
      stack: err.stack,
    });
  }
}

/**
 * Handle PR synchronize (new commits pushed) — re-analyze if needed.
 * We don't re-analyze every push, only if the contributor data is stale.
 */
async function handlePRSync({ id, name, payload }) {
  const pr = payload.pull_request;
  const repo = payload.repository;
  const installationId = payload.installation?.id;

  // Only re-analyze if the last scan was > 1 hour ago
  const { isContributorStale } = require("../database/queries");
  if (!isContributorStale(pr.user.login, 60)) {
    log.debug(`Skipping re-analysis for ${pr.user.login} on sync (data is fresh)`);
    return;
  }

  // Re-run the full pipeline
  return handlePROpened({ id, name, payload });
}

/**
 * Handle new app installations.
 */
async function handleInstallCreated({ payload }) {
  const installation = payload.installation;
  log.info(`New installation: ${installation.account.login} (${installation.id})`);

  upsertInstallation(
    installation.id,
    installation.account.login,
    installation.account.type,
  );
}

/**
 * Handle app uninstallations.
 */
async function handleInstallDeleted({ payload }) {
  const installation = payload.installation;
  log.info(`Installation removed: ${installation.account.login} (${installation.id})`);

  removeInstallation(installation.id);
}

module.exports = { createWebhookHandler };
