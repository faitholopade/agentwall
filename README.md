# AgentWall

**The firewall for open source.** Detect autonomous AI agent contributions, enforce human-first policies, and protect your maintainers.

AgentWall is a GitHub App that sits between incoming contributions and your repositories. It uses behavioral analysis — not just content detection — to identify autonomous agents and enforce contribution policies.

---

## How It Works

When a pull request is opened on a protected repo, AgentWall:

1. **Fetches contributor data** — profile, activity history, contribution patterns from the GitHub API
2. **Runs 10 detection signals** — behavioral fingerprinting plus PR-content analysis: timing, velocity, engagement, code patterns, rest-gap analysis, and explicit AI attribution
3. **Scores the contributor** — composite risk score from 0-100 with full signal breakdown
4. **Enforces your policies** — auto-close, label, comment, or require human attribution based on configurable rules
5. **Posts a check run** — every scanned PR gets an AgentWall check with the full signal table, so you can gate merges with branch protection (requires the *Checks: Read & write* app permission)

Registered GitHub App bots (`dependabot[bot]`, `renovate[bot]`, …) are skipped by default — they're already attributed automation. Allowlisted and **verified contributors** (humans you vouch for via the dashboard) bypass scanning entirely.

### Detection Signals

| Signal | What It Detects | Severity |
|--------|----------------|----------|
| **Hyperspeed Ramp-up** | New account with abnormally high contribution velocity | Critical |
| **Robotic Timing** | Commits with near-zero *circular* variance in time-of-day (machines don't sleep — and midnight-crossing schedules can't hide) | Critical |
| **Spray Pattern** | PRs across many repos simultaneously (agent breadth-first behavior) | Critical |
| **No-Sleep Marathon** | Days with 18+ hours of continuous activity and no rest gap over 3h — catches round-the-clock agents that have *high* timing variance | Critical |
| **Explicit Agent Attribution** | AI co-author trailers (`Co-Authored-By: Claude`), "Generated with…" markers in PR body or commits | High |
| **Newborn Account** | Code submitted from an account created days (or hours) ago | High |
| **Zero Community Engagement** | Code submissions with no discussion, reviews, or comments | High |
| **Ghost Profile** | No avatar, bio, linked accounts, or followers | High |
| **Template Code Pattern** | PRs that are suspiciously uniform in size and structure | High |
| **Formulaic Messages** | Commit messages with low entropy suggesting auto-generation | Medium |

### Merge Gating via Checks

When the app has the **Checks: Read & write** permission, AgentWall posts a check run on every scanned PR (`failure` for critical/high risk, `neutral` for medium, `success` for low) with the full signal breakdown. Add "AgentWall" as a required status check in branch protection and risky PRs can't merge until a maintainer reviews them — a softer, more auditable gate than auto-closing.

### Verified Contributors

False positive? Open the scan in the dashboard and click **"Mark as verified human"** (or use the Verified tab). Verified contributors bypass scanning and enforcement permanently until removed. Manage via the dashboard or `GET/POST /api/verified` and `DELETE /api/verified/:login`.

### Monitor-Only Mode

Set `MONITOR_ONLY=true` to trial AgentWall safely: every PR is scanned and scored, policies are evaluated, and the dashboard records what *would* have happened (shown as `monitor:close`, `monitor:label`, …) — but no PR is ever touched. Flip it off once you trust the scoring.

---

## Quick Start (Windows)

### Prerequisites

- **Node.js 18+** — [Download](https://nodejs.org/)
- **Git** — [Download](https://git-scm.com/)
- **A GitHub account** with permission to create GitHub Apps

### 1. Clone and Install

```bash
git clone https://github.com/faitholopade/agentwall.git
cd agentwall
npm install
```

### 2. Create a GitHub App

Go to **[github.com/settings/apps/new](https://github.com/settings/apps/new)** and configure:

| Field | Value |
|-------|-------|
| **App name** | AgentWall (or your preferred name) |
| **Homepage URL** | `http://localhost:3000` |
| **Webhook URL** | Your public URL + `/webhook` (see step 4) |
| **Webhook secret** | Generate a strong random string |

**Permissions** (Repository):
- Pull requests: **Read & Write**
- Issues: **Read & Write**
- Checks: **Read & Write** (enables merge gating via check runs)
- Metadata: **Read-only**

**Subscribe to events:**
- Pull request
- Installation

After creating the app:
1. Note the **App ID** (shown at the top of the app settings page)
2. Click **Generate a private key** — save the `.pem` file to your project root as `private-key.pem`

### 3. Configure Environment

Run the interactive setup:

```bash
npm run setup
```

Or manually copy and edit the environment file:

```bash
copy .env.example .env
# Edit .env with your GitHub App credentials
```

### 4. Set Up Webhook Tunnel (Development)

For local development, you need a public URL for GitHub to send webhooks to. Use **ngrok**:

```bash
npx ngrok http 3000
```

Copy the `https://xxxxx.ngrok.io` URL and update your GitHub App's **Webhook URL** to:
```
https://xxxxx.ngrok.io/webhook
```

### 5. Start the Server

```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

Open **http://localhost:3000** for the dashboard.

### Run the Tests

```bash
npm test
```

Covers the detection signals (including circular timing statistics and agent-attribution patterns), event analysis, policy evaluation, and database queries against an in-memory SQLite database.

### 6. Install on a Repository

Go to your GitHub App's page, choose **Install App**, and select the repos you want to protect.

---

## Architecture

```
agentwall/
├── src/
│   ├── index.js              # Express server entry point
│   ├── config.js             # Environment configuration
│   ├── database/
│   │   ├── init.js           # SQLite schema and migrations
│   │   └── queries.js        # Database query helpers
│   ├── github/
│   │   ├── app.js            # GitHub App authentication (Octokit)
│   │   ├── api.js            # GitHub API calls (profile, events, PR actions)
│   │   └── webhooks.js       # Webhook event handlers
│   ├── engine/
│   │   ├── signals.js        # 7 detection signal implementations
│   │   ├── analyzer.js       # Orchestrates the full analysis pipeline
│   │   └── policies.js       # Policy evaluation and enforcement
│   ├── routes/
│   │   ├── api.js            # REST API for the dashboard
│   │   └── webhooks.js       # Webhook HTTP route
│   └── utils/
│       └── logger.js         # Structured logging
├── public/                   # Dashboard frontend (HTML/CSS/JS)
├── scripts/
│   └── setup.js              # Interactive setup wizard
├── data/                     # SQLite database (auto-created)
└── private-key.pem           # Your GitHub App private key
```

## API Reference

All endpoints are under `/api`. In development mode, no auth is required. In production, pass `Authorization: Bearer <DASHBOARD_SECRET>`.

### Scans

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/scans` | List scans. Query: `?repo=&riskLevel=&limit=&offset=` |
| `GET` | `/api/scans/:id` | Get scan details with signals |
| `GET` | `/api/stats` | Dashboard statistics. Query: `?repo=` |

### Contributors

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/contributors/:login` | Get cached contributor profile + activity |
| `POST` | `/api/contributors/:login/scan` | Manually trigger a scan |

### Policies

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/policies` | List all policies |
| `POST` | `/api/policies` | Create a new policy |
| `PUT` | `/api/policies/:id` | Update a policy |
| `DELETE` | `/api/policies/:id` | Delete a policy |

### Installations

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/installations` | List all GitHub App installations |

## Policy Configuration

Policies are evaluated in **priority order** (highest first). The first matching policy wins.

### Default Policies

| Policy | Score Range | Action |
|--------|------------|--------|
| Block Critical Risk | 60-100 | Close PR with explanation |
| Label High Risk | 40-59 | Add warning labels |
| Comment Medium Risk | 20-39 | Post informational comment |
| Allow Low Risk | 0-19 | Pass through |

### Custom Policies via API

```bash
curl -X POST http://localhost:3000/api/policies \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Block Spray Bots",
    "description": "Block contributors hitting 20+ repos in 30 days",
    "rule_type": "score_range",
    "threshold_min": 50,
    "threshold_max": 100,
    "action": "close",
    "enabled": true,
    "priority": 95
  }'
```

## Deployment

### Docker

```bash
docker build -t agentwall .
docker run -p 3000:3000 --env-file .env \
  -v agentwall-data:/app/data \
  -v ./private-key.pem:/app/private-key.pem:ro \
  agentwall
```

### Railway / Render / Fly.io

1. Push to GitHub
2. Connect your repo to Railway/Render/Fly
3. Set environment variables from `.env`
4. Deploy; the app auto-creates the SQLite database

### Persistent Storage

The SQLite database at `./data/agentwall.db` must persist across deploys. On Railway/Render, configure a persistent volume mounted at `/app/data`.

### Environment Variables for Production

```bash
NODE_ENV=production
PORT=3000
GITHUB_APP_ID=your-app-id
GITHUB_APP_PRIVATE_KEY_PATH=/app/private-key.pem
GITHUB_WEBHOOK_SECRET=your-webhook-secret
DASHBOARD_SECRET=a-very-strong-random-secret
DATABASE_PATH=/app/data/agentwall.db
LOG_LEVEL=info
MONITOR_ONLY=false        # true = score and record, never touch PRs
ALLOWLIST=                # comma-separated logins that bypass scanning
SKIP_BOTS=true            # skip dependabot[bot] and friends
```

A `GET /healthz` endpoint is available for load balancers and uptime monitors.

---

## Contributing

PRs welcome. The detection signals are the core innovation — new signals that improve agent detection accuracy are especially valuable.

## License

MIT

---

Built by **Blindspot Labs** · Protecting open source from autonomous agents.
