const { ALL_SIGNALS } = require("./signals");
const { config } = require("../config");
const { createLogger } = require("../utils/logger");
const {
  fetchUserProfile,
  fetchUserEvents,
  analyzeEvents,
} = require("../github/api");
const {
  upsertContributor,
  getContributor,
  upsertContributorActivity,
  getLatestContributorActivity,
  isContributorStale,
  insertScan,
} = require("../database/queries");

const log = createLogger("analyzer");

/**
 * Full analysis pipeline for a contributor on a specific PR.
 *
 * 1. Fetch/update contributor profile from GitHub
 * 2. Fetch/update contributor activity from GitHub Events API
 * 3. Run all detection signals
 * 4. Calculate composite risk score
 * 5. Store scan results
 * 6. Return analysis for policy engine
 */
async function analyzeContribution(prData, installationId) {
  const { contributor_login, pr_number, repo_full_name, pr_title, pr_url } = prData;

  // PR-level context for signals that inspect the contribution itself
  // (may be absent on manual scans)
  const prContext = {
    pr_title,
    pr_body: prData.pr_body || null,
    commit_messages: prData.pr_commit_messages || [],
  };

  log.info(`Analyzing contribution from ${contributor_login} on ${repo_full_name}#${pr_number}`);

  // ── Step 1: Get or fetch contributor profile ──────────────────────
  let profile = getContributor(contributor_login);
  const needsRefresh = !profile || isContributorStale(contributor_login, 60);

  if (needsRefresh) {
    log.debug(`Fetching fresh profile for ${contributor_login}`);
    const ghProfile = await fetchUserProfile(contributor_login, installationId);
    if (ghProfile) {
      upsertContributor(ghProfile);
      profile = getContributor(contributor_login);
    } else if (!profile) {
      // Can't fetch and no cached data — create minimal profile
      upsertContributor({
        github_login: contributor_login,
        github_id: null,
        account_created_at: null,
        avatar_url: null,
        bio: null,
        has_linked_socials: 0,
        total_contributions: 0,
        public_repos: 0,
        followers: 0,
        following: 0,
      });
      profile = getContributor(contributor_login);
    }
  }

  // ── Step 2: Get or fetch activity data ────────────────────────────
  let activity = getLatestContributorActivity(contributor_login);
  const activityStale = !activity ||
    (Date.now() - new Date(activity.fetched_at + "Z").getTime()) > 60 * 60 * 1000;

  if (activityStale) {
    log.debug(`Fetching fresh activity for ${contributor_login}`);
    const events = await fetchUserEvents(contributor_login, installationId);
    const activityData = analyzeEvents(events, contributor_login);
    upsertContributorActivity(activityData);
    activity = getLatestContributorActivity(contributor_login);
  }

  // Fallback if still no activity data
  if (!activity) {
    activity = {
      github_login: contributor_login,
      repos_contributed_to: 0,
      prs_last_30_days: 0,
      issue_comments_count: 0,
      code_reviews_count: 0,
      commit_hours_json: "[]",
      pr_sizes_json: "[]",
      commit_messages_json: "[]",
      event_times_json: "[]",
    };
  }

  // ── Step 3: Run all detection signals ─────────────────────────────
  const signals = [];
  let totalScore = 0;

  for (const signalFn of ALL_SIGNALS) {
    try {
      const result = signalFn(profile, activity, prContext);
      if (result.triggered) {
        signals.push({
          name: result.name,
          severity: result.severity,
          score: result.score,
          detail: result.detail,
        });
        totalScore += result.score;
      }
    } catch (err) {
      log.warn(`Signal ${signalFn.name} threw an error`, { error: err.message });
    }
  }

  // Cap at 100
  totalScore = Math.min(totalScore, 100);

  // ── Step 4: Determine risk level ──────────────────────────────────
  let riskLevel;
  if (totalScore >= config.thresholds.critical) riskLevel = "critical";
  else if (totalScore >= config.thresholds.high) riskLevel = "high";
  else if (totalScore >= config.thresholds.medium) riskLevel = "medium";
  else riskLevel = "low";

  // ── Step 5: Store scan result ─────────────────────────────────────
  const scanData = {
    pr_number,
    repo_full_name,
    pr_title,
    pr_url,
    contributor_login,
    risk_score: totalScore,
    risk_level: riskLevel,
    action_taken: null, // set by policy engine
    signals_json: JSON.stringify(signals),
    contributor_data_json: JSON.stringify({
      account_age_days: profile.account_created_at
        ? Math.floor((Date.now() - new Date(profile.account_created_at).getTime()) / (1000 * 60 * 60 * 24))
        : null,
      public_repos: profile.public_repos,
      followers: profile.followers,
      repos_contributed_to: activity.repos_contributed_to,
      prs_last_30_days: activity.prs_last_30_days,
      issue_comments: activity.issue_comments_count,
      code_reviews: activity.code_reviews_count,
    }),
  };

  const result = insertScan(scanData);

  log.info(`Scan complete for ${contributor_login}: score=${totalScore}, level=${riskLevel}, signals=${signals.length}`, {
    scan_id: result.lastInsertRowid,
  });

  return {
    scan_id: result.lastInsertRowid,
    contributor_login,
    risk_score: totalScore,
    risk_level: riskLevel,
    signals,
    profile: {
      login: profile.github_login,
      avatar_url: profile.avatar_url,
      bio: profile.bio,
      account_created_at: profile.account_created_at,
      public_repos: profile.public_repos,
      followers: profile.followers,
    },
    activity: {
      repos_contributed_to: activity.repos_contributed_to,
      prs_last_30_days: activity.prs_last_30_days,
      issue_comments: activity.issue_comments_count,
      code_reviews: activity.code_reviews_count,
    },
  };
}

module.exports = { analyzeContribution };
