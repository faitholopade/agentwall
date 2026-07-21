const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const { config } = require("../config");
const { createLogger } = require("../utils/logger");

const log = createLogger("database");

let db = null;

function getDb() {
  if (db) return db;

  // Ensure data directory exists
  const dir = path.dirname(config.db.path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(config.db.path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  log.info(`Database opened at ${config.db.path}`);
  return db;
}

function migrate() {
  const db = getDb();

  db.exec(`
    -- Installations: GitHub App installations per repo/org
    CREATE TABLE IF NOT EXISTS installations (
      id INTEGER PRIMARY KEY,
      installation_id INTEGER UNIQUE NOT NULL,
      account_login TEXT NOT NULL,
      account_type TEXT NOT NULL DEFAULT 'Organization',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Contributors: cached contributor profiles
    CREATE TABLE IF NOT EXISTS contributors (
      id INTEGER PRIMARY KEY,
      github_login TEXT UNIQUE NOT NULL,
      github_id INTEGER,
      account_created_at TEXT,
      avatar_url TEXT,
      bio TEXT,
      has_linked_socials INTEGER DEFAULT 0,
      total_contributions INTEGER DEFAULT 0,
      public_repos INTEGER DEFAULT 0,
      followers INTEGER DEFAULT 0,
      following INTEGER DEFAULT 0,
      last_analyzed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Scans: every PR scan result
    CREATE TABLE IF NOT EXISTS scans (
      id INTEGER PRIMARY KEY,
      pr_number INTEGER NOT NULL,
      repo_full_name TEXT NOT NULL,
      pr_title TEXT,
      pr_url TEXT,
      contributor_login TEXT NOT NULL,
      risk_score INTEGER NOT NULL,
      risk_level TEXT NOT NULL,
      action_taken TEXT,
      signals_json TEXT NOT NULL,
      contributor_data_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (contributor_login) REFERENCES contributors(github_login)
    );

    -- Policies: per-installation enforcement rules
    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY,
      installation_id INTEGER,
      name TEXT NOT NULL,
      description TEXT,
      rule_type TEXT NOT NULL,
      threshold_min INTEGER DEFAULT 0,
      threshold_max INTEGER DEFAULT 100,
      action TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      config_json TEXT DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Contributor activity cache: stores fetched activity data
    CREATE TABLE IF NOT EXISTS contributor_activity (
      id INTEGER PRIMARY KEY,
      github_login TEXT NOT NULL,
      repos_contributed_to INTEGER DEFAULT 0,
      prs_last_30_days INTEGER DEFAULT 0,
      issue_comments_count INTEGER DEFAULT 0,
      code_reviews_count INTEGER DEFAULT 0,
      commit_hours_json TEXT DEFAULT '[]',
      pr_sizes_json TEXT DEFAULT '[]',
      commit_messages_json TEXT DEFAULT '[]',
      event_times_json TEXT DEFAULT '[]',
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (github_login) REFERENCES contributors(github_login)
    );

    -- Verified contributors: humans a maintainer has vouched for; bypass scanning
    CREATE TABLE IF NOT EXISTS verified_contributors (
      id INTEGER PRIMARY KEY,
      github_login TEXT UNIQUE NOT NULL,
      verified_by TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_scans_repo ON scans(repo_full_name);
    CREATE INDEX IF NOT EXISTS idx_scans_contributor ON scans(contributor_login);
    CREATE INDEX IF NOT EXISTS idx_scans_created ON scans(created_at);
    CREATE INDEX IF NOT EXISTS idx_scans_risk ON scans(risk_level);
    CREATE INDEX IF NOT EXISTS idx_policies_installation ON policies(installation_id);
    CREATE INDEX IF NOT EXISTS idx_contributor_activity_login ON contributor_activity(github_login);
  `);

  // Additive migrations for databases created by older versions
  const activityCols = db.prepare("PRAGMA table_info(contributor_activity)").all().map((c) => c.name);
  if (!activityCols.includes("event_times_json")) {
    db.exec("ALTER TABLE contributor_activity ADD COLUMN event_times_json TEXT DEFAULT '[]'");
    log.info("Migrated contributor_activity: added event_times_json");
  }

  // Seed default policies if none exist
  const policyCount = db.prepare("SELECT COUNT(*) as count FROM policies WHERE installation_id IS NULL").get();
  if (policyCount.count === 0) {
    const insert = db.prepare(`
      INSERT INTO policies (installation_id, name, description, rule_type, threshold_min, threshold_max, action, enabled, priority)
      VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const defaults = db.transaction(() => {
      insert.run("Block Critical Risk", "Auto-close PRs from contributors scoring 60+", "score_range", 60, 100, "close", 1, 100);
      insert.run("Label High Risk", "Auto-label PRs from contributors scoring 40-59 as needs-review", "score_range", 40, 59, "label", 1, 90);
      insert.run("Comment Medium Risk", "Add a warning comment on PRs scoring 20-39", "score_range", 20, 39, "comment", 1, 80);
      insert.run("Allow Low Risk", "Pass through PRs scoring below 20", "score_range", 0, 19, "allow", 1, 0);
    });

    defaults();
    log.info("Seeded default policies");
  }

  log.info("Database migration complete");
}

// Run migration if called directly
if (require.main === module) {
  require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });
  migrate();
  console.log("Migration complete.");
  process.exit(0);
}

module.exports = { getDb, migrate };
