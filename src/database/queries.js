const { getDb } = require("./init");

// ── Installations ───────────────────────────────────────────────────

function upsertInstallation(installationId, accountLogin, accountType) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO installations (installation_id, account_login, account_type, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(installation_id) DO UPDATE SET
      account_login = excluded.account_login,
      account_type = excluded.account_type,
      updated_at = datetime('now')
  `).run(installationId, accountLogin, accountType);
}

function removeInstallation(installationId) {
  const db = getDb();
  return db.prepare("DELETE FROM installations WHERE installation_id = ?").run(installationId);
}

function getInstallation(installationId) {
  const db = getDb();
  return db.prepare("SELECT * FROM installations WHERE installation_id = ?").get(installationId);
}

function getAllInstallations() {
  const db = getDb();
  return db.prepare("SELECT * FROM installations ORDER BY created_at DESC").all();
}

// ── Contributors ────────────────────────────────────────────────────

function upsertContributor(data) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO contributors (github_login, github_id, account_created_at, avatar_url, bio, has_linked_socials, total_contributions, public_repos, followers, following, last_analyzed_at, updated_at)
    VALUES (@github_login, @github_id, @account_created_at, @avatar_url, @bio, @has_linked_socials, @total_contributions, @public_repos, @followers, @following, datetime('now'), datetime('now'))
    ON CONFLICT(github_login) DO UPDATE SET
      github_id = excluded.github_id,
      account_created_at = COALESCE(excluded.account_created_at, contributors.account_created_at),
      avatar_url = excluded.avatar_url,
      bio = excluded.bio,
      has_linked_socials = excluded.has_linked_socials,
      total_contributions = excluded.total_contributions,
      public_repos = excluded.public_repos,
      followers = excluded.followers,
      following = excluded.following,
      last_analyzed_at = datetime('now'),
      updated_at = datetime('now')
  `).run(data);
}

function getContributor(login) {
  const db = getDb();
  return db.prepare("SELECT * FROM contributors WHERE github_login = ?").get(login);
}

function upsertContributorActivity(data) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO contributor_activity (github_login, repos_contributed_to, prs_last_30_days, issue_comments_count, code_reviews_count, commit_hours_json, pr_sizes_json, commit_messages_json, event_times_json, fetched_at)
    VALUES (@github_login, @repos_contributed_to, @prs_last_30_days, @issue_comments_count, @code_reviews_count, @commit_hours_json, @pr_sizes_json, @commit_messages_json, @event_times_json, datetime('now'))
  `).run(data);
}

function getLatestContributorActivity(login) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM contributor_activity
    WHERE github_login = ?
    ORDER BY fetched_at DESC LIMIT 1
  `).get(login);
}

function isContributorStale(login, maxAgeMinutes = 60) {
  const db = getDb();
  const row = db.prepare(`
    SELECT last_analyzed_at FROM contributors
    WHERE github_login = ?
  `).get(login);
  if (!row || !row.last_analyzed_at) return true;
  const age = (Date.now() - new Date(row.last_analyzed_at + "Z").getTime()) / 60000;
  return age > maxAgeMinutes;
}

// ── Verified Contributors ───────────────────────────────────────────

function addVerifiedContributor(login, verifiedBy, note) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO verified_contributors (github_login, verified_by, note)
    VALUES (?, ?, ?)
    ON CONFLICT(github_login) DO UPDATE SET
      verified_by = excluded.verified_by,
      note = excluded.note
  `).run(login, verifiedBy || null, note || null);
}

function removeVerifiedContributor(login) {
  const db = getDb();
  return db.prepare("DELETE FROM verified_contributors WHERE github_login = ?").run(login);
}

function isVerifiedContributor(login) {
  const db = getDb();
  return !!db.prepare("SELECT 1 FROM verified_contributors WHERE github_login = ? COLLATE NOCASE").get(login);
}

function getVerifiedContributors() {
  const db = getDb();
  return db.prepare("SELECT * FROM verified_contributors ORDER BY created_at DESC").all();
}

// ── Scans ───────────────────────────────────────────────────────────

function insertScan(data) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO scans (pr_number, repo_full_name, pr_title, pr_url, contributor_login, risk_score, risk_level, action_taken, signals_json, contributor_data_json)
    VALUES (@pr_number, @repo_full_name, @pr_title, @pr_url, @contributor_login, @risk_score, @risk_level, @action_taken, @signals_json, @contributor_data_json)
  `).run(data);
}

function getScans({ repo, riskLevel, limit = 50, offset = 0 }) {
  const db = getDb();
  let where = [];
  let params = {};

  if (repo) {
    where.push("repo_full_name = @repo");
    params.repo = repo;
  }
  if (riskLevel) {
    where.push("risk_level = @riskLevel");
    params.riskLevel = riskLevel;
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  params.limit = limit;
  params.offset = offset;

  return db.prepare(`
    SELECT * FROM scans ${whereClause}
    ORDER BY created_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params);
}

function getScan(id) {
  const db = getDb();
  return db.prepare("SELECT * FROM scans WHERE id = ?").get(id);
}

function getScanStats(repoFullName) {
  const db = getDb();
  const whereClause = repoFullName ? "WHERE repo_full_name = ?" : "";
  const params = repoFullName ? [repoFullName] : [];

  const total = db.prepare(`SELECT COUNT(*) as count FROM scans ${whereClause}`).get(...params);
  const byLevel = db.prepare(`
    SELECT risk_level, COUNT(*) as count FROM scans ${whereClause}
    GROUP BY risk_level
  `).all(...params);

  const last24h = db.prepare(`
    SELECT COUNT(*) as count FROM scans
    ${repoFullName ? "WHERE repo_full_name = ? AND" : "WHERE"} created_at >= datetime('now', '-24 hours')
  `).get(...params);

  const topSignals = db.prepare(`
    SELECT
      json_extract(je.value, '$.name') as signal_name,
      COUNT(*) as count
    FROM scans, json_each(scans.signals_json) je
    ${whereClause}
    GROUP BY signal_name
    ORDER BY count DESC
    LIMIT 10
  `).all(...params);

  return {
    total: total.count,
    last24h: last24h.count,
    byLevel: Object.fromEntries(byLevel.map(r => [r.risk_level, r.count])),
    topSignals,
  };
}

// ── Policies ────────────────────────────────────────────────────────

function getPolicies(installationId = null) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM policies
    WHERE installation_id IS ? OR installation_id IS NULL
    ORDER BY priority DESC
  `).all(installationId);
}

function getPolicy(id) {
  const db = getDb();
  return db.prepare("SELECT * FROM policies WHERE id = ?").get(id);
}

function createPolicy(data) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO policies (installation_id, name, description, rule_type, threshold_min, threshold_max, action, enabled, priority, config_json)
    VALUES (@installation_id, @name, @description, @rule_type, @threshold_min, @threshold_max, @action, @enabled, @priority, @config_json)
  `).run(data);
}

function updatePolicy(id, data) {
  const db = getDb();
  const fields = [];
  const params = { id };

  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined && key !== "id") {
      fields.push(`${key} = @${key}`);
      params[key] = val;
    }
  }
  fields.push("updated_at = datetime('now')");

  return db.prepare(`UPDATE policies SET ${fields.join(", ")} WHERE id = @id`).run(params);
}

function deletePolicy(id) {
  const db = getDb();
  return db.prepare("DELETE FROM policies WHERE id = ?").run(id);
}

module.exports = {
  upsertInstallation, removeInstallation, getInstallation, getAllInstallations,
  upsertContributor, getContributor, upsertContributorActivity, getLatestContributorActivity, isContributorStale,
  addVerifiedContributor, removeVerifiedContributor, isVerifiedContributor, getVerifiedContributors,
  insertScan, getScans, getScan, getScanStats,
  getPolicies, getPolicy, createPolicy, updatePolicy, deletePolicy,
};
