#!/usr/bin/env node

/**
 * AgentWall Setup Script
 * Guides you through configuring AgentWall for first use.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const ENV_PATH = path.resolve(__dirname, "..", ".env");

async function main() {
  console.log("");
  console.log("AgentWall Setup");
  console.log("Agent firewall for open source repositories");
  console.log("-------------------------------------------");
  console.log("");

  // Check if .env already exists
  if (fs.existsSync(ENV_PATH)) {
    const overwrite = await ask(".env file already exists. Overwrite? (y/N): ");
    if (overwrite.toLowerCase() !== "y") {
      console.log("Setup cancelled. Your existing .env is unchanged.");
      rl.close();
      return;
    }
  }

  console.log("Before continuing, you need a GitHub App. If you don't have one yet:");
  console.log("  1. Go to https://github.com/settings/apps/new");
  console.log("  2. Fill in:");
  console.log("     - App name: AgentWall (or your preferred name)");
  console.log("     - Homepage URL: http://localhost:3000");
  console.log("     - Webhook URL: your public URL + /webhook (use ngrok for local dev)");
  console.log("     - Webhook secret: generate a strong random string");
  console.log("  3. Permissions needed:");
  console.log("     - Pull requests: Read & Write");
  console.log("     - Issues: Read & Write");
  console.log("     - Checks: Read & Write (enables merge gating via check runs)");
  console.log("     - Metadata: Read-only");
  console.log("  4. Subscribe to events: Pull request, Installation");
  console.log("  5. After creating, generate and download a private key (.pem file)");
  console.log("");

  const appId = await ask("GitHub App ID: ");
  const webhookSecret = await ask("Webhook Secret: ");
  const pemPath = await ask("Path to private key .pem file (default: ./private-key.pem): ");
  const port = await ask("Server port (default: 3000): ");
  const dashboardSecret = await ask("Dashboard password (for production auth): ");

  const envContent = `# AgentWall configuration

# GitHub App credentials
GITHUB_APP_ID=${appId.trim()}
GITHUB_APP_PRIVATE_KEY_PATH=${pemPath.trim() || "./private-key.pem"}
GITHUB_WEBHOOK_SECRET=${webhookSecret.trim()}

# Server
PORT=${port.trim() || "3000"}
NODE_ENV=development

# Database
DATABASE_PATH=./data/agentwall.db

# Dashboard auth
DASHBOARD_SECRET=${dashboardSecret.trim() || "change-me-to-a-strong-secret"}

# Enforcement behavior
MONITOR_ONLY=false
ALLOWLIST=
SKIP_BOTS=true
CHECKS_ENABLED=true

# Logging
LOG_LEVEL=info
`;

  fs.writeFileSync(ENV_PATH, envContent);
  console.log(`\n.env file created at ${ENV_PATH}`);

  // Create data directory
  const dataDir = path.resolve(__dirname, "..", "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log("Data directory created");
  }

  // Check if private key exists
  const keyPath = path.resolve(pemPath.trim() || "./private-key.pem");
  if (!fs.existsSync(keyPath)) {
    console.log(`\nWarning: private key not found at ${keyPath}`);
    console.log("Download it from your GitHub App settings and place it there.");
  } else {
    console.log("Private key found");
  }

  console.log("");
  console.log("Setup complete. Next steps:");
  console.log("  1. npm install");
  console.log("  2. Place your .pem private key file");
  console.log("  3. npm run dev");
  console.log(`  4. Open http://localhost:${port.trim() || "3000"}`);
  console.log("");
  console.log(`For webhook testing: npx ngrok http ${port.trim() || "3000"}`);
  console.log("Then update your GitHub App webhook URL.");
  console.log("");

  rl.close();
}

main().catch((err) => {
  console.error("Setup failed:", err);
  rl.close();
  process.exit(1);
});
