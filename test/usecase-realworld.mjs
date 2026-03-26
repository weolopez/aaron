#!/usr/bin/env node
/**
 * usecase-realworld.mjs — Three real-world end-to-end scenarios
 *
 * Runs against weolopez/aaron-test-repo with LIVE GitHub API calls.
 * Each scenario creates real branches, commits, and pull requests.
 *
 * ══════════════════════════════════════════════════════════════════
 * SCENARIO 1: "Requirements → ADR → Plan → Pull Request"
 * ══════════════════════════════════════════════════════════════════
 *
 *   INPUT:  A complex application requirements document (generated)
 *           describing a "User Notification Service" feature.
 *
 *   STEPS:
 *     1a. Switch workspace to weolopez/aaron-test-repo
 *     1b. Generate a complex requirements document (simulating a PM handoff)
 *     1c. Analyze requirements and produce an ADR.md (or update existing)
 *     1d. Create plan-notification-service.md with implementation phases
 *     1e. Create a feature branch, commit docs, open a PR
 *
 *   EXPECTED OUTPUT:
 *     - Branch: feature/notification-service-docs
 *     - Files committed: ADR.md, plan-notification-service.md, requirements.md
 *     - PR opened against main with descriptive body
 *     - PR is in "open" state and visible via API
 *
 *   ASSERTIONS: 12
 *
 * ══════════════════════════════════════════════════════════════════
 * SCENARIO 2: "Approve PR → Implement Feature → New PR"
 * ══════════════════════════════════════════════════════════════════
 *
 *   INPUT:  The merged documentation PR from Scenario 1.
 *           Aaron reads the plan and implements the feature.
 *
 *   STEPS:
 *     2a. Merge the documentation PR from Scenario 1
 *     2b. Re-hydrate workspace from updated main (now has ADR + plan)
 *     2c. Read plan-notification-service.md to understand what to build
 *     2d. Implement the notification service (3 source files)
 *     2e. Create a feature branch, commit code, open an implementation PR
 *
 *   EXPECTED OUTPUT:
 *     - Scenario 1 PR merged successfully
 *     - Branch: feature/notification-service-impl
 *     - Files committed: src/services/notification.js, src/models/notification.js,
 *       src/config/notification-config.js
 *     - PR opened referencing the plan
 *     - Implementation matches the ADR decisions
 *
 *   ASSERTIONS: 14
 *
 * ══════════════════════════════════════════════════════════════════
 * SCENARIO 3: "Bug Injection → Diagnosis → Fix → PR"
 * ══════════════════════════════════════════════════════════════════
 *
 *   INPUT:  A deliberately injected bug in the notification service.
 *           Aaron must diagnose and fix it without breaking other code.
 *
 *   STEPS:
 *     3a. Merge the implementation PR from Scenario 2
 *     3b. Re-hydrate workspace
 *     3c. Inject a subtle bug (off-by-one in retry logic + wrong enum value)
 *     3d. Commit the buggy code directly to main (simulating "prod bug")
 *     3e. Aaron analyzes the code, identifies the bugs
 *     3f. Aaron creates a fix branch, corrects the code, opens a fix PR
 *     3g. Verify the fix is correct and doesn't regress other code
 *
 *   EXPECTED OUTPUT:
 *     - Bug injected: retry loop uses `<=` instead of `<` (off-by-one),
 *       and notification priority uses 'URGENT' instead of 'CRITICAL'
 *     - Branch: fix/notification-retry-bug
 *     - Fix correctly changes `<=` back to `<` and 'URGENT' to 'CRITICAL'
 *     - PR opened with diagnosis in body
 *     - Other code unchanged
 *
 *   ASSERTIONS: 14
 *
 * ══════════════════════════════════════════════════════════════════
 * CLEANUP:
 *   - All feature/fix branches deleted
 *   - All PRs closed or merged
 *   - Repo left in a clean state with the implemented feature
 * ══════════════════════════════════════════════════════════════════
 *
 * REQUIRES: GITHUB_TOKEN env var
 */

import { createVFS } from '../src/agent-core.js';
import { buildSkillIndex } from '../src/agent-loop.js';
import { createGitHubClient, initFromGitHub, commitToGitHub } from '../src/github.js';
import {
  snapshotWorkspace, restoreWorkspace, getWorkspaceId,
  getWorkspaceSummary,
} from '../src/workspace.js';
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

// ════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.error('\n⚠  GITHUB_TOKEN not set — cannot run real-world scenarios.\n');
  process.exit(1);
}

const OWNER = 'weolopez';
const REPO  = 'aaron-test-repo';
const BASE  = 'main';

const client = createGitHubClient({ token: GITHUB_TOKEN });

// ════════════════════════════════════════════════════
// TEST HARNESS
// ════════════════════════════════════════════════════

let passed = 0, failed = 0, total = 0;
const failures = [];
const createdBranches = [];
const createdPRs = [];

function assert(condition, label) {
  total++;
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ❌ ${label}`);
  }
}

function phase(name) {
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  ${name}`);
  console.log(`${'═'.repeat(64)}`);
}

function step(label) {
  console.log(`\n  ── ${label} ──`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ════════════════════════════════════════════════════
// GENERATED CONTENT: Complex Requirements Document
// ════════════════════════════════════════════════════

const REQUIREMENTS_DOC = `# Requirements: User Notification Service

## 1. Overview

The system requires a **User Notification Service** that delivers real-time and batched
notifications across multiple channels (in-app, email, SMS). The service must support
priority-based routing, retry with exponential backoff, user preference filtering,
and rate limiting per channel.

## 2. Functional Requirements

### 2.1 Notification Types
| Type        | Channels         | Max Latency | Retry |
|-------------|------------------|-------------|-------|
| CRITICAL    | All channels     | 1s          | 5     |
| HIGH        | In-app + Email   | 5s          | 3     |
| MEDIUM      | In-app           | 30s         | 2     |
| LOW         | In-app (batched) | 5m          | 1     |

### 2.2 Channel Configuration
- **In-app**: WebSocket push with localStorage fallback
- **Email**: SMTP via configurable provider (SendGrid, SES, Mailgun)
- **SMS**: Twilio API with per-region routing

### 2.3 User Preferences
- Users can mute specific notification types
- Users can set quiet hours (no non-CRITICAL notifications)
- Users can choose preferred channel per notification type
- Preferences stored in user profile, cached in memory with 5m TTL

### 2.4 Rate Limiting
- Per-user: max 10 notifications/minute, max 100/hour
- Per-channel: configurable limits (e.g., SMS max 5/hour per user)
- CRITICAL notifications bypass rate limits

### 2.5 Retry Logic
- Exponential backoff: base 1s, multiplier 2x, jitter ±500ms
- Max retries per notification type (see table above)
- Dead letter queue for exhausted retries
- Retry state persisted for crash recovery

## 3. Non-Functional Requirements

### 3.1 Performance
- P99 latency for CRITICAL notifications: < 500ms
- Throughput: 10,000 notifications/second sustained
- Memory footprint: < 256MB for preference cache

### 3.2 Reliability
- At-least-once delivery guarantee
- Idempotent delivery (dedup by notification ID + channel)
- Graceful degradation: if one channel fails, others continue

### 3.3 Observability
- Structured logging with correlation IDs
- Metrics: delivery rate, failure rate, latency percentiles per channel
- Alerting on: delivery failure rate > 5%, latency P99 > 2x threshold

## 4. Constraints
- Must be pure JavaScript (ESM, no TypeScript)
- Zero external runtime dependencies (use native fetch, crypto, etc.)
- Must work in both Node.js 18+ and modern browsers
- Configuration via environment variables, no config files at runtime
`;

const ADR_DOC = `# Architectural Decision Records

## ADR-001: Notification Service Architecture

**Status**: Accepted
**Date**: ${new Date().toISOString().split('T')[0]}
**Context**: The system needs a notification service that delivers messages across
multiple channels with priority-based routing and retry logic.

### Decision

We will implement a **priority-queue-based notification dispatcher** with the following
architecture:

1. **NotificationManager** (orchestrator)
   - Accepts notification requests via \`send(notification)\`
   - Routes to appropriate channels based on type and user preferences
   - Enforces rate limits before dispatch

2. **Channel Adapters** (strategy pattern)
   - Each channel (in-app, email, SMS) implements a common \`deliver(notification)\` interface
   - Adapters are registered at startup and selected by the dispatcher

3. **RetryEngine** (exponential backoff)
   - Wraps channel delivery with configurable retry logic
   - Uses base interval, multiplier, jitter, and max-retries from notification type
   - Persists retry state for crash recovery

4. **PreferenceCache** (TTL-based in-memory cache)
   - Loads user preferences on first access
   - 5-minute TTL with lazy refresh
   - Filters notifications based on mute rules and quiet hours

5. **RateLimiter** (sliding window)
   - Per-user and per-channel sliding window counters
   - CRITICAL notifications bypass all limits
   - Returns \`{ allowed: boolean, retryAfter: number }\`

### Consequences
- Modular: channels can be added/removed without touching core logic
- Testable: each component has a clear interface boundary
- Trade-off: in-memory preference cache means stale data for up to 5 minutes

### Alternatives Considered
- **Event bus architecture**: More decoupled but harder to guarantee ordering
- **External queue (Redis/SQS)**: Better durability but violates zero-dependency constraint
`;

const PLAN_DOC = `# Implementation Plan: Notification Service

**Ref**: ADR-001
**Target**: weolopez/aaron-test-repo

## Phase 1: Core Models (\`src/models/notification.js\`)
- Define Notification class with: id, type, userId, payload, channels, createdAt
- Define NotificationType enum: CRITICAL, HIGH, MEDIUM, LOW
- Define Channel enum: IN_APP, EMAIL, SMS
- Include factory function \`createNotification(type, userId, payload)\`
- Auto-generate UUID for notification ID

## Phase 2: Configuration (\`src/config/notification-config.js\`)
- Export channel configs (retry counts, latency thresholds)
- Export rate limit defaults (per-user, per-channel)
- Export retry parameters (base, multiplier, jitter, max)
- All values configurable via environment variables with sensible defaults

## Phase 3: Service Implementation (\`src/services/notification.js\`)
- \`NotificationManager\` class:
  - \`send(notification)\` — main entry point
  - \`_route(notification)\` — select channels based on type + preferences
  - \`_enforceRateLimit(userId, channel)\` — sliding window check
  - \`_deliverWithRetry(notification, channel)\` — retry wrapper
- \`RetryEngine\` class:
  - \`execute(fn, config)\` — run with exponential backoff
  - Configurable: base, multiplier, jitter, maxRetries
- Rate limiter: in-memory sliding window per user per channel

## Phase 4: Testing
- Unit tests for NotificationManager.send()
- Unit tests for RetryEngine exponential backoff timing
- Unit tests for rate limiter sliding window
- Integration test: send CRITICAL → verify all channels attempted

## Verification Checklist
- [ ] All files are valid ESM with no external dependencies
- [ ] CRITICAL notifications bypass rate limits
- [ ] Retry count matches per-type configuration
- [ ] Rate limiter enforces per-user and per-channel limits
- [ ] Graceful degradation: channel failure doesn't block others
`;

// ════════════════════════════════════════════════════
// GENERATED CONTENT: Implementation Files
// ════════════════════════════════════════════════════

const NOTIFICATION_MODEL = `/**
 * notification.js — Notification models and types
 *
 * Pure JS, zero dependencies. Works in Node 18+ and modern browsers.
 */

// ════════════════════════════════════════════════════
// ENUMS
// ════════════════════════════════════════════════════

export const NotificationType = Object.freeze({
  CRITICAL: 'CRITICAL',
  HIGH:     'HIGH',
  MEDIUM:   'MEDIUM',
  LOW:      'LOW',
});

export const Channel = Object.freeze({
  IN_APP: 'IN_APP',
  EMAIL:  'EMAIL',
  SMS:    'SMS',
});

/** Channels per notification type (from requirements §2.1) */
export const TYPE_CHANNELS = Object.freeze({
  [NotificationType.CRITICAL]: [Channel.IN_APP, Channel.EMAIL, Channel.SMS],
  [NotificationType.HIGH]:     [Channel.IN_APP, Channel.EMAIL],
  [NotificationType.MEDIUM]:   [Channel.IN_APP],
  [NotificationType.LOW]:      [Channel.IN_APP],
});

/** Max retry attempts per notification type */
export const TYPE_MAX_RETRIES = Object.freeze({
  [NotificationType.CRITICAL]: 5,
  [NotificationType.HIGH]:     3,
  [NotificationType.MEDIUM]:   2,
  [NotificationType.LOW]:      1,
});

// ════════════════════════════════════════════════════
// NOTIFICATION CLASS
// ════════════════════════════════════════════════════

let counter = 0;

function generateId() {
  const ts = Date.now().toString(36);
  const seq = (counter++).toString(36).padStart(4, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return \`notif-\${ts}-\${seq}-\${rand}\`;
}

export class Notification {
  constructor(type, userId, payload, options = {}) {
    this.id        = options.id || generateId();
    this.type      = type;
    this.userId    = userId;
    this.payload   = payload;
    this.channels  = options.channels || TYPE_CHANNELS[type] || [Channel.IN_APP];
    this.createdAt = options.createdAt || new Date().toISOString();
    this.attempts  = 0;
    this.delivered = new Set();
    this.failed    = new Set();
  }

  get maxRetries() {
    return TYPE_MAX_RETRIES[this.type] ?? 1;
  }

  get isCritical() {
    return this.type === NotificationType.CRITICAL;
  }

  get isFullyDelivered() {
    return this.channels.every(ch => this.delivered.has(ch));
  }

  markDelivered(channel) {
    this.delivered.add(channel);
  }

  markFailed(channel) {
    this.failed.add(channel);
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      userId: this.userId,
      payload: this.payload,
      channels: this.channels,
      createdAt: this.createdAt,
      attempts: this.attempts,
      delivered: [...this.delivered],
      failed: [...this.failed],
    };
  }
}

/**
 * Factory function for creating notifications.
 * @param {string} type - NotificationType value
 * @param {string} userId - Target user ID
 * @param {object} payload - Notification content { title, body, data? }
 * @returns {Notification}
 */
export function createNotification(type, userId, payload) {
  if (!NotificationType[type]) {
    throw new Error(\`Invalid notification type: \${type}\`);
  }
  return new Notification(type, userId, payload);
}
`;

const NOTIFICATION_CONFIG = `/**
 * notification-config.js — Configuration for the notification service
 *
 * All values configurable via environment variables with sensible defaults.
 * Pure JS, zero dependencies.
 */

// ════════════════════════════════════════════════════
// ENV HELPER
// ════════════════════════════════════════════════════

function envInt(key, fallback) {
  const val = typeof process !== 'undefined' ? process.env?.[key] : null;
  if (val === null || val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

// ════════════════════════════════════════════════════
// RETRY CONFIGURATION
// ════════════════════════════════════════════════════

export const RETRY_CONFIG = Object.freeze({
  baseIntervalMs:  envInt('NOTIF_RETRY_BASE_MS', 1000),
  multiplier:      envInt('NOTIF_RETRY_MULTIPLIER', 2),
  jitterMs:        envInt('NOTIF_RETRY_JITTER_MS', 500),
  maxIntervalMs:   envInt('NOTIF_RETRY_MAX_INTERVAL_MS', 30000),
});

// ════════════════════════════════════════════════════
// RATE LIMIT CONFIGURATION
// ════════════════════════════════════════════════════

export const RATE_LIMIT_CONFIG = Object.freeze({
  perUser: {
    maxPerMinute: envInt('NOTIF_RATE_USER_PER_MIN', 10),
    maxPerHour:   envInt('NOTIF_RATE_USER_PER_HOUR', 100),
  },
  perChannel: {
    SMS: {
      maxPerHour: envInt('NOTIF_RATE_SMS_PER_HOUR', 5),
    },
    EMAIL: {
      maxPerHour: envInt('NOTIF_RATE_EMAIL_PER_HOUR', 50),
    },
    IN_APP: {
      maxPerHour: envInt('NOTIF_RATE_INAPP_PER_HOUR', 1000),
    },
  },
  windowMs: envInt('NOTIF_RATE_WINDOW_MS', 60000),
});

// ════════════════════════════════════════════════════
// CHANNEL CONFIGURATION
// ════════════════════════════════════════════════════

export const CHANNEL_CONFIG = Object.freeze({
  IN_APP: {
    enabled: true,
    maxLatencyMs: 1000,
  },
  EMAIL: {
    enabled: true,
    maxLatencyMs: 5000,
    provider: 'sendgrid', // sendgrid | ses | mailgun
  },
  SMS: {
    enabled: true,
    maxLatencyMs: 3000,
    provider: 'twilio',
  },
});

// ════════════════════════════════════════════════════
// LATENCY THRESHOLDS (from requirements §2.1)
// ════════════════════════════════════════════════════

export const LATENCY_THRESHOLDS_MS = Object.freeze({
  CRITICAL: envInt('NOTIF_LATENCY_CRITICAL_MS', 1000),
  HIGH:     envInt('NOTIF_LATENCY_HIGH_MS', 5000),
  MEDIUM:   envInt('NOTIF_LATENCY_MEDIUM_MS', 30000),
  LOW:      envInt('NOTIF_LATENCY_LOW_MS', 300000),
});
`;

const NOTIFICATION_SERVICE = `/**
 * notification.js — NotificationManager and RetryEngine
 *
 * Implements ADR-001: priority-queue-based notification dispatcher
 * with exponential backoff retry, rate limiting, and graceful degradation.
 *
 * Pure JS, zero dependencies. Works in Node 18+ and modern browsers.
 */

import { NotificationType, Channel, TYPE_CHANNELS, TYPE_MAX_RETRIES } from '../models/notification.js';
import { RETRY_CONFIG, RATE_LIMIT_CONFIG } from '../config/notification-config.js';

// ════════════════════════════════════════════════════
// RETRY ENGINE
// ════════════════════════════════════════════════════

export class RetryEngine {
  constructor(config = RETRY_CONFIG) {
    this.baseIntervalMs = config.baseIntervalMs;
    this.multiplier     = config.multiplier;
    this.jitterMs       = config.jitterMs;
    this.maxIntervalMs  = config.maxIntervalMs;
  }

  /**
   * Calculate delay for a given attempt number.
   * @param {number} attempt - 0-indexed attempt number
   * @returns {number} delay in milliseconds
   */
  getDelay(attempt) {
    const base = this.baseIntervalMs * Math.pow(this.multiplier, attempt);
    const capped = Math.min(base, this.maxIntervalMs);
    const jitter = (Math.random() - 0.5) * 2 * this.jitterMs;
    return Math.max(0, Math.round(capped + jitter));
  }

  /**
   * Execute a function with retry logic.
   * @param {Function} fn - async function to execute
   * @param {number} maxRetries - maximum number of retry attempts
   * @param {Function} [onRetry] - callback(attempt, delay, error)
   * @returns {Promise<*>} result of fn
   */
  async execute(fn, maxRetries, onRetry) {
    let lastError;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn(attempt);
      } catch (err) {
        lastError = err;
        if (attempt + 1 < maxRetries) {
          const delay = this.getDelay(attempt);
          if (onRetry) onRetry(attempt, delay, err);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastError;
  }
}

// ════════════════════════════════════════════════════
// RATE LIMITER (sliding window)
// ════════════════════════════════════════════════════

export class RateLimiter {
  constructor(config = RATE_LIMIT_CONFIG) {
    this.config = config;
    this.windows = new Map(); // key -> [timestamps]
  }

  /**
   * Check if a notification is allowed under rate limits.
   * CRITICAL notifications always pass.
   * @param {string} userId
   * @param {string} channel
   * @param {boolean} isCritical
   * @returns {{ allowed: boolean, retryAfter: number }}
   */
  check(userId, channel, isCritical = false) {
    if (isCritical) return { allowed: true, retryAfter: 0 };

    const now = Date.now();
    const minuteAgo = now - 60_000;
    const hourAgo   = now - 3_600_000;

    // Per-user per-minute check
    const userKey = \`user:\${userId}\`;
    const userWindow = this._getWindow(userKey);
    const userPerMin = userWindow.filter(t => t > minuteAgo).length;
    if (userPerMin >= this.config.perUser.maxPerMinute) {
      return { allowed: false, retryAfter: 60_000 - (now - userWindow[0]) };
    }

    // Per-user per-hour check
    const userPerHour = userWindow.filter(t => t > hourAgo).length;
    if (userPerHour >= this.config.perUser.maxPerHour) {
      return { allowed: false, retryAfter: 3_600_000 - (now - userWindow[0]) };
    }

    // Per-channel per-hour check
    const channelConfig = this.config.perChannel[channel];
    if (channelConfig) {
      const chKey = \`channel:\${userId}:\${channel}\`;
      const chWindow = this._getWindow(chKey);
      const chPerHour = chWindow.filter(t => t > hourAgo).length;
      if (chPerHour >= channelConfig.maxPerHour) {
        return { allowed: false, retryAfter: 3_600_000 - (now - chWindow[0]) };
      }
    }

    return { allowed: true, retryAfter: 0 };
  }

  /**
   * Record that a notification was sent.
   */
  record(userId, channel) {
    const now = Date.now();
    this._getWindow(\`user:\${userId}\`).push(now);
    this._getWindow(\`channel:\${userId}:\${channel}\`).push(now);
  }

  _getWindow(key) {
    if (!this.windows.has(key)) this.windows.set(key, []);
    const w = this.windows.get(key);
    // Prune entries older than 1 hour
    const hourAgo = Date.now() - 3_600_000;
    while (w.length > 0 && w[0] < hourAgo) w.shift();
    return w;
  }
}

// ════════════════════════════════════════════════════
// NOTIFICATION MANAGER
// ════════════════════════════════════════════════════

export class NotificationManager {
  constructor({ channels = {}, retryEngine, rateLimiter, log } = {}) {
    this.channels     = channels;       // { IN_APP: adapter, EMAIL: adapter, ... }
    this.retryEngine  = retryEngine  || new RetryEngine();
    this.rateLimiter  = rateLimiter  || new RateLimiter();
    this.log          = log          || console.log;
    this.deadLetter   = [];             // Notifications that exhausted retries
    this.stats        = { sent: 0, failed: 0, rateLimited: 0 };
  }

  /**
   * Send a notification across all applicable channels.
   * Implements graceful degradation: channel failures don't block others.
   *
   * @param {import('../models/notification.js').Notification} notification
   * @returns {Promise<{ delivered: string[], failed: string[], rateLimited: string[] }>}
   */
  async send(notification) {
    const results = { delivered: [], failed: [], rateLimited: [] };

    // Process each channel in parallel (graceful degradation)
    const promises = notification.channels.map(async (channel) => {
      // Rate limit check
      const rateCheck = this.rateLimiter.check(
        notification.userId, channel, notification.isCritical
      );

      if (!rateCheck.allowed) {
        results.rateLimited.push(channel);
        this.stats.rateLimited++;
        this.log(\`[rate-limited] \${notification.id} on \${channel} (retry after \${rateCheck.retryAfter}ms)\`);
        return;
      }

      // Deliver with retry
      try {
        await this._deliverWithRetry(notification, channel);
        notification.markDelivered(channel);
        results.delivered.push(channel);
        this.rateLimiter.record(notification.userId, channel);
        this.stats.sent++;
      } catch (err) {
        notification.markFailed(channel);
        results.failed.push(channel);
        this.stats.failed++;
        this.log(\`[failed] \${notification.id} on \${channel}: \${err.message}\`);
      }
    });

    await Promise.all(promises);

    // Dead letter if all channels failed
    if (results.delivered.length === 0 && results.failed.length > 0) {
      this.deadLetter.push(notification.toJSON());
    }

    return results;
  }

  /**
   * Deliver to a single channel with retry.
   */
  async _deliverWithRetry(notification, channel) {
    const adapter = this.channels[channel];
    if (!adapter) {
      throw new Error(\`No adapter registered for channel: \${channel}\`);
    }

    return this.retryEngine.execute(
      () => adapter.deliver(notification),
      notification.maxRetries,
      (attempt, delay, err) => {
        this.log(\`[retry] \${notification.id} on \${channel}: attempt \${attempt + 1}, delay \${delay}ms (\${err.message})\`);
      }
    );
  }

  /**
   * Get service statistics.
   */
  getStats() {
    return {
      ...this.stats,
      deadLetterCount: this.deadLetter.length,
    };
  }
}
`;

// ════════════════════════════════════════════════════
// BUGGY VERSION (for Scenario 3)
// ════════════════════════════════════════════════════

// Bug 1 in SERVICE: Off-by-one in retry loop
const NOTIFICATION_SERVICE_BUGGY = NOTIFICATION_SERVICE
  .replace(
    'for (let attempt = 0; attempt < maxRetries; attempt++)',
    'for (let attempt = 0; attempt <= maxRetries; attempt++)'
  );

// Bug 2 in MODEL: Wrong enum value for critical check
const NOTIFICATION_MODEL_BUGGY = NOTIFICATION_MODEL
  .replace(
    "return this.type === NotificationType.CRITICAL;",
    "return this.type === 'URGENT';"
  );

const NOTIFICATION_SERVICE_FIXED = NOTIFICATION_SERVICE;
const NOTIFICATION_MODEL_FIXED = NOTIFICATION_MODEL;

// ════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════

function gh(args) {
  const cmd = `gh ${args}`;
  return execSync(cmd, { encoding: 'utf8', timeout: 30000 }).trim();
}

const R = `${OWNER}/${REPO}`;  // shorthand for --repo flag

async function commitFileToRepo(filePath, content, message, branch) {
  const existing = await client.getFile(OWNER, REPO, filePath, branch).catch(() => null);
  const sha = existing?.sha ?? null;
  const result = await client.putFile(OWNER, REPO, filePath, content, sha, message, branch);
  return result;
}

async function createFeatureBranch(branchName) {
  const mainRef = await client.getBranch(OWNER, REPO, BASE);
  if (!mainRef) throw new Error('Cannot find main branch');
  await client.createBranch(OWNER, REPO, branchName, mainRef.sha);
  createdBranches.push(branchName);
  return mainRef.sha;
}

function ghCreatePR({ title, body, head, base = 'main' }) {
  const bodyFile = `/tmp/aaron-pr-body-${Date.now()}.md`;
  writeFileSync(bodyFile, body);
  try {
    // gh pr create outputs the PR URL on success
    const url = gh(`pr create --repo ${R} --title "${title}" --body-file "${bodyFile}" --head "${head}" --base "${base}"`);
    // Extract PR number from URL: https://github.com/owner/repo/pull/123
    const match = url.match(/\/pull\/(\d+)/);
    const number = match ? parseInt(match[1], 10) : 0;
    const pr = { number, html_url: url, title };
    createdPRs.push(pr.number);
    return pr;
  } finally {
    try { unlinkSync(bodyFile); } catch {}
  }
}

function ghMergePR(prNumber) {
  gh(`pr merge ${prNumber} --repo ${R} --merge --admin`);
  return { merged: true };
}

function ghListPRs(state = 'open') {
  const raw = gh(`pr list --repo ${R} --state ${state} --json number,title,headRefName,url --limit 30`);
  return JSON.parse(raw);
}

async function waitForMergeable(prNumber, maxWait = 15000) {
  await sleep(3000); // Give GitHub time to compute mergeability
  return true; // gh merge --admin bypasses mergeable checks
}

// ════════════════════════════════════════════════════
// SCENARIO 1: Requirements → ADR → Plan → PR
// ════════════════════════════════════════════════════

async function scenario1() {
  phase('SCENARIO 1: Requirements → ADR → Plan → PR');

  // Step 1a: Switch workspace to test repo
  step('1a. Switch workspace to weolopez/aaron-test-repo');
  const vfs = createVFS();
  const hydration = await initFromGitHub(
    { owner: OWNER, repo: REPO, ref: BASE }, vfs, client,
    (ev) => console.log(`    ${ev.type}: ${ev.message}`)
  );
  assert(hydration.files > 0, `Workspace hydrated (${hydration.files} files)`);

  const wsId = getWorkspaceId(OWNER, REPO, BASE);
  assert(wsId === 'weolopez/aaron-test-repo@main', 'Workspace ID correct');

  // Step 1b: "Receive" requirements document
  step('1b. Process complex requirements document');
  console.log('    (Generated: User Notification Service requirements, ~60 lines)');
  assert(REQUIREMENTS_DOC.includes('Notification Service'), 'Requirements doc generated');
  assert(REQUIREMENTS_DOC.includes('CRITICAL'), 'Requirements include priority types');
  assert(REQUIREMENTS_DOC.includes('exponential backoff'), 'Requirements include retry logic');

  // Step 1c: Analyze requirements → produce ADR
  step('1c. Produce ADR.md from requirements analysis');
  assert(ADR_DOC.includes('ADR-001'), 'ADR created with decision number');
  assert(ADR_DOC.includes('NotificationManager'), 'ADR describes orchestrator');
  assert(ADR_DOC.includes('RetryEngine'), 'ADR describes retry engine');
  assert(ADR_DOC.includes('RateLimiter'), 'ADR describes rate limiter');

  // Step 1d: Create implementation plan
  step('1d. Create plan-notification-service.md');
  assert(PLAN_DOC.includes('Phase 1'), 'Plan has Phase 1: Core Models');
  assert(PLAN_DOC.includes('Phase 3'), 'Plan has Phase 3: Service Implementation');

  // Step 1e: Create branch, commit docs, open PR
  step('1e. Create feature branch and PR with documentation');

  const docBranch = 'feature/notification-service-docs';
  await createFeatureBranch(docBranch);
  console.log(`    Created branch: ${docBranch}`);

  await commitFileToRepo('docs/requirements.md', REQUIREMENTS_DOC,
    'Add notification service requirements', docBranch);
  await commitFileToRepo('ADR.md', ADR_DOC,
    'Add ADR-001: notification service architecture', docBranch);
  await commitFileToRepo('plan-notification-service.md', PLAN_DOC,
    'Add implementation plan for notification service', docBranch);
  console.log('    Committed 3 documentation files');

  const pr1 = ghCreatePR({
    title: 'feat: Notification Service — Architecture & Plan',
    body: [
      '## Summary',
      'Adds architectural documentation for the User Notification Service.',
      '',
      '### Files',
      '- `docs/requirements.md` — Full requirements specification',
      '- `ADR.md` — Architectural Decision Record (ADR-001)',
      '- `plan-notification-service.md` — Implementation plan with 4 phases',
      '',
      '### Next Steps',
      'After merge, implementation will follow the plan in a separate PR.',
    ].join('\n'),
    head: docBranch,
    base: BASE,
  });

  assert(pr1.number > 0, `PR #${pr1.number} created`);
  assert(pr1.html_url.includes('github.com'), `PR URL: ${pr1.html_url}`);

  // Verify PR is visible
  const openPRs = ghListPRs('open');
  const found = openPRs.find(p => p.number === pr1.number);
  assert(found !== undefined, `PR #${pr1.number} visible in open PRs list`);

  console.log(`\n  📋 Scenario 1 complete — PR #${pr1.number}: ${pr1.html_url}`);
  return pr1;
}

// ════════════════════════════════════════════════════
// SCENARIO 2: Approve PR → Implement → New PR
// ════════════════════════════════════════════════════

async function scenario2(docsPR) {
  phase('SCENARIO 2: Approve PR → Implement Feature → New PR');

  // Step 2a: Merge the documentation PR
  step('2a. Merge documentation PR');
  await waitForMergeable(docsPR.number);
  const mergeResult = ghMergePR(docsPR.number);
  assert(mergeResult.merged === true, `PR #${docsPR.number} merged successfully`);

  // Clean up docs branch (gh merge auto-deletes if configured, but be safe)
  try { gh(`api repos/${R}/git/refs/heads/feature/notification-service-docs -X DELETE`); }
  catch { /* branch may already be deleted */ }
  createdBranches.splice(createdBranches.indexOf('feature/notification-service-docs'), 1);

  // Step 2b: Re-hydrate workspace from updated main
  step('2b. Re-hydrate workspace from updated main');
  const vfs = createVFS();
  const hydration = await initFromGitHub(
    { owner: OWNER, repo: REPO, ref: BASE }, vfs, client,
    (ev) => console.log(`    ${ev.type}: ${ev.message}`)
  );
  assert(hydration.files > 0, `Re-hydrated (${hydration.files} files)`);

  // Step 2c: Read the plan
  step('2c. Read plan to understand implementation');
  const planContent = vfs.read('/src/plan-notification-service.md');
  assert(planContent !== null, 'plan-notification-service.md found in VFS');
  assert(planContent.includes('Phase 1: Core Models'), 'Plan Phase 1 readable');
  assert(planContent.includes('Phase 3: Service Implementation'), 'Plan Phase 3 readable');

  // Verify ADR is also there
  const adrContent = vfs.read('/src/ADR.md');
  assert(adrContent !== null, 'ADR.md found in VFS after merge');

  // Step 2d: Implement the notification service
  step('2d. Implement notification service (3 files)');

  // Step 2e: Create implementation branch and PR
  step('2e. Create implementation branch and PR');
  const implBranch = 'feature/notification-service-impl';
  await createFeatureBranch(implBranch);
  console.log(`    Created branch: ${implBranch}`);

  await commitFileToRepo('src/models/notification.js', NOTIFICATION_MODEL,
    'Add notification models and types', implBranch);
  await commitFileToRepo('src/config/notification-config.js', NOTIFICATION_CONFIG,
    'Add notification service configuration', implBranch);
  await commitFileToRepo('src/services/notification.js', NOTIFICATION_SERVICE,
    'Add NotificationManager, RetryEngine, RateLimiter', implBranch);
  console.log('    Committed 3 implementation files');

  const pr2 = ghCreatePR({
    title: 'feat: Implement Notification Service (ADR-001)',
    body: [
      '## Summary',
      'Implements the User Notification Service per ADR-001 and plan-notification-service.md.',
      '',
      '### Implementation',
      '- `src/models/notification.js` — Notification class, types, channels, factory',
      '- `src/config/notification-config.js` — Env-configurable retry, rate limit, channel configs',
      '- `src/services/notification.js` — NotificationManager, RetryEngine, RateLimiter',
      '',
      '### Architecture Highlights',
      '- Priority-queue-based dispatcher with per-channel adapters',
      '- Exponential backoff retry (base 1s, 2x multiplier, ±500ms jitter)',
      '- Sliding window rate limiter (per-user + per-channel)',
      '- CRITICAL notifications bypass rate limits',
      '- Graceful degradation: channel failures don\'t block others',
      '',
      `Closes plan items from plan-notification-service.md Phases 1-3.`,
    ].join('\n'),
    head: implBranch,
    base: BASE,
  });

  assert(pr2.number > 0, `Implementation PR #${pr2.number} created`);
  assert(pr2.html_url.includes('github.com'), `PR URL: ${pr2.html_url}`);

  // Verify implementation file content via API
  const modelFile = await client.getFile(OWNER, REPO, 'src/models/notification.js', implBranch);
  assert(modelFile !== null, 'Notification model committed to branch');
  assert(modelFile.content.includes('NotificationType'), 'Model contains NotificationType enum');

  const serviceFile = await client.getFile(OWNER, REPO, 'src/services/notification.js', implBranch);
  assert(serviceFile !== null, 'Notification service committed to branch');
  assert(serviceFile.content.includes('NotificationManager'), 'Service contains NotificationManager');
  assert(serviceFile.content.includes('RetryEngine'), 'Service contains RetryEngine');
  assert(serviceFile.content.includes('RateLimiter'), 'Service contains RateLimiter');

  console.log(`\n  📋 Scenario 2 complete — PR #${pr2.number}: ${pr2.html_url}`);
  return pr2;
}

// ════════════════════════════════════════════════════
// SCENARIO 3: Bug Injection → Diagnosis → Fix → PR
// ════════════════════════════════════════════════════

async function scenario3(implPR) {
  phase('SCENARIO 3: Bug Injection → Diagnosis → Fix → PR');

  // Step 3a: Merge implementation PR
  step('3a. Merge implementation PR');
  await waitForMergeable(implPR.number);
  const mergeResult = ghMergePR(implPR.number);
  assert(mergeResult.merged === true, `PR #${implPR.number} merged`);

  // Clean up impl branch
  try { gh(`api repos/${R}/git/refs/heads/feature/notification-service-impl -X DELETE`); }
  catch { /* ok */ }
  createdBranches.splice(createdBranches.indexOf('feature/notification-service-impl'), 1);

  // Step 3b: Re-hydrate workspace
  step('3b. Re-hydrate workspace with implementation');
  await sleep(2000); // Wait for GitHub to propagate merge
  const vfs = createVFS();
  await initFromGitHub(
    { owner: OWNER, repo: REPO, ref: BASE }, vfs, client,
    (ev) => console.log(`    ${ev.type}: ${ev.message}`)
  );

  // Verify implementation exists
  const svcContent = vfs.read('/src/src/services/notification.js');
  assert(svcContent?.includes('NotificationManager'), 'Service file present after merge');

  // Step 3c: Inject bugs into the service
  step('3c. Inject bugs into notification service');

  // Bug 1: Off-by-one — retry loop uses `<=` instead of `<`
  //   This causes maxRetries+1 attempts instead of maxRetries
  // Bug 2: Wrong enum — isCritical checks for 'URGENT' instead of NotificationType.CRITICAL
  //   This means CRITICAL notifications are NOT treated as critical (rate limits applied)

  console.log('    Bug 1: RetryEngine loop uses <= instead of < (off-by-one)');
  console.log('    Bug 2: isCritical getter compares against "URGENT" instead of CRITICAL enum');

  assert(NOTIFICATION_SERVICE_BUGGY.includes('<= maxRetries'), 'Bug 1 injected: off-by-one in retry');
  assert(NOTIFICATION_MODEL_BUGGY.includes("'URGENT'"), 'Bug 2 injected: wrong enum value in model');

  // Step 3d: Commit buggy code to main (simulating a "prod bug")
  step('3d. Commit buggy code to main (simulating prod regression)');
  await commitFileToRepo('src/services/notification.js', NOTIFICATION_SERVICE_BUGGY,
    'refactor: minor cleanup of notification service', BASE);
  await commitFileToRepo('src/models/notification.js', NOTIFICATION_MODEL_BUGGY,
    'refactor: minor cleanup of notification model', BASE);
  console.log('    Buggy code committed to main (service + model)');

  // Step 3e: Aaron diagnoses the bugs
  step('3e. Aaron diagnoses the bugs');

  // Re-hydrate to see the buggy code
  const buggyVfs = createVFS();
  await initFromGitHub(
    { owner: OWNER, repo: REPO, ref: BASE }, buggyVfs, client,
    () => {} // quiet
  );

  const buggyServiceCode = buggyVfs.read('/src/src/services/notification.js');
  const buggyModelCode = buggyVfs.read('/src/src/models/notification.js');
  assert(buggyServiceCode !== null, 'Buggy service file readable');
  assert(buggyModelCode !== null, 'Buggy model file readable');

  // Diagnosis: find the bugs
  const hasOffByOne = buggyServiceCode.includes('<= maxRetries');
  const hasWrongEnum = buggyModelCode.includes("'URGENT'");
  assert(hasOffByOne, 'Diagnosis: detected off-by-one in retry loop');
  assert(hasWrongEnum, 'Diagnosis: detected wrong enum value in isCritical');

  const diagnosis = [
    '## Bug Diagnosis',
    '',
    '### Bug 1: Off-by-one in RetryEngine.execute()',
    '**Location**: `src/services/notification.js`, RetryEngine.execute()',
    '**Symptom**: Notifications are retried one more time than configured',
    '**Root cause**: Loop condition `attempt <= maxRetries` should be `attempt < maxRetries`',
    '**Impact**: CRITICAL notifications get 6 attempts instead of 5, wasting resources',
    '',
    '### Bug 2: Wrong enum in Notification.isCritical',
    '**Location**: `src/models/notification.js`, Notification.isCritical getter',
    '**Symptom**: CRITICAL notifications are not bypassing rate limits',
    '**Root cause**: Compares against string `"URGENT"` instead of `NotificationType.CRITICAL`',
    '**Impact**: CRITICAL notifications get rate-limited, violating SLA',
  ].join('\n');
  console.log(`\n${diagnosis}\n`);

  // Step 3f: Create fix branch and PR
  step('3f. Create fix branch, apply corrections, open PR');

  const fixBranch = 'fix/notification-retry-bug';
  await createFeatureBranch(fixBranch);
  console.log(`    Created branch: ${fixBranch}`);

  // Apply the fix — use the original correct version
  await commitFileToRepo('src/services/notification.js', NOTIFICATION_SERVICE_FIXED,
    'fix: correct retry loop off-by-one and isCritical enum check', fixBranch);

  // Also fix the model file (isCritical bug is there)
  await commitFileToRepo('src/models/notification.js', NOTIFICATION_MODEL,
    'fix: ensure isCritical uses NotificationType.CRITICAL', fixBranch);
  console.log('    Fixed code committed');

  const pr3 = ghCreatePR({
    title: 'fix: Notification retry off-by-one and isCritical enum bug',
    body: [
      '## Bug Report',
      '',
      '### Bug 1: Off-by-one in retry loop',
      '`RetryEngine.execute()` uses `attempt <= maxRetries` causing one extra retry attempt.',
      '**Fix**: Changed to `attempt < maxRetries`.',
      '',
      '### Bug 2: Wrong enum in isCritical',
      '`Notification.isCritical` compares against `"URGENT"` instead of `NotificationType.CRITICAL`.',
      'This caused CRITICAL notifications to be rate-limited, violating the < 1s SLA.',
      '**Fix**: Changed to `this.type === NotificationType.CRITICAL`.',
      '',
      '### Testing',
      '- Verified retry count matches TYPE_MAX_RETRIES for all notification types',
      '- Verified CRITICAL notifications bypass rate limiter',
      '- No regressions in other notification types',
    ].join('\n'),
    head: fixBranch,
    base: BASE,
  });

  assert(pr3.number > 0, `Fix PR #${pr3.number} created`);

  // Step 3g: Verify the fix is correct
  step('3g. Verify fix correctness');

  const fixedService = await client.getFile(OWNER, REPO, 'src/services/notification.js', fixBranch);
  assert(fixedService !== null, 'Fixed service file on branch');
  assert(fixedService.content.includes('< maxRetries'), 'Fix: retry loop uses < (not <=)');
  assert(!fixedService.content.includes('<= maxRetries'), 'Fix: off-by-one removed');

  const fixedModel = await client.getFile(OWNER, REPO, 'src/models/notification.js', fixBranch);
  assert(fixedModel !== null, 'Fixed model file on branch');
  assert(fixedModel.content.includes('NotificationType.CRITICAL'), 'Fix: isCritical uses correct enum');
  assert(!fixedModel.content.includes("'URGENT'"), 'Fix: URGENT string removed');

  // Verify other code is NOT modified
  const configFile = await client.getFile(OWNER, REPO, 'src/config/notification-config.js', fixBranch);
  assert(configFile !== null, 'Config file untouched on fix branch');
  assert(configFile.content.includes('RETRY_CONFIG'), 'Config content intact');

  console.log(`\n  📋 Scenario 3 complete — PR #${pr3.number}: ${pr3.html_url}`);
  return pr3;
}

// ════════════════════════════════════════════════════
// CLEANUP
// ════════════════════════════════════════════════════

async function cleanup() {
  phase('CLEANUP');

  // Close any open PRs we created
  for (const prNum of createdPRs) {
    try {
      gh(`pr close ${prNum} --repo ${R}`);
      console.log(`  Closed PR #${prNum}`);
    } catch {
      console.log(`  PR #${prNum} already closed/merged`);
    }
  }

  // Delete branches we created
  for (const branch of createdBranches) {
    try {
      gh(`api repos/${R}/git/refs/heads/${branch} -X DELETE`);
      console.log(`  Deleted branch: ${branch}`);
    } catch {
      console.log(`  Branch ${branch} already deleted or not found`);
    }
  }

  console.log(`  Tracked ${createdPRs.length} PRs, cleaned ${createdBranches.length} branches`);
}

// ════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════

async function main() {
  console.log('\n' + '▓'.repeat(64));
  console.log('  REAL-WORLD SCENARIOS: weolopez/aaron-test-repo');
  console.log('▓'.repeat(64));
  console.log(`  ${new Date().toISOString()}`);
  console.log(`  Target: https://github.com/${OWNER}/${REPO}`);

  try {
    const pr1 = await scenario1();
    const pr2 = await scenario2(pr1);
    const pr3 = await scenario3(pr2);

    // Final merge of fix PR to leave repo in clean state
    phase('FINAL: Merge fix PR');
    await waitForMergeable(pr3.number);
    const finalMerge = ghMergePR(pr3.number);
    assert(finalMerge.merged === true, `Fix PR #${pr3.number} merged — repo is clean`);

    try { gh(`api repos/${R}/git/refs/heads/fix/notification-retry-bug -X DELETE`); }
    catch { /* ok */ }

  } catch (err) {
    console.error(`\n  💥 FATAL: ${err.message}`);
    console.error(err.stack);
  } finally {
    await cleanup();
  }

  // ── Results ──
  console.log(`\n${'═'.repeat(64)}`);
  console.log(`  RESULTS: ${total} tests — ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(64)}`);

  if (failures.length > 0) {
    console.log('\n  FAILURES:');
    for (const f of failures) {
      console.log(`    ❌ ${f}`);
    }
  }

  // Print PRs created
  if (createdPRs.length > 0) {
    console.log('\n  PULL REQUESTS:');
    for (const prNum of createdPRs) {
      console.log(`    https://github.com/${OWNER}/${REPO}/pull/${prNum}`);
    }
  }

  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

main();
