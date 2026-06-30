# PlayBoard Automated Tests

These tests use free tooling only:

- Node.js built-in test runner
- The existing Supabase JavaScript client dependency
- GitHub Actions for repeatable CI runs

## Commands

```bash
npm run test:syntax
npm run test:phase1
npm run test:phase2
npm run test:phase3
npm run test:phase4
npm run test:integration
npm test
```

## Phase 1

Covers lead creation, event recording, score rollups, state rollups, email open/click tracking, readiness form tracking, completion, automation queue records, and cleanup.

## Phase 2

Covers automation queue worker behavior, reminders, abandonment recovery, skip paths, automation history, email sequence dry-run records, and cleanup.

## Phase 3

Covers funnel analytics, email analytics, form analytics, drop-off reporting, analytics access key behavior, and cleanup.

## Phase 4

Covers AI lead summaries, deterministic fallback mode, engagement predictions, dynamic email generation, AI lead endpoint behavior, AI automation queue rules, dry-run personalized email records, AI events, and cleanup.

## Cleanup guarantee

The tests store every created lead ID and delete related records from:

- `readiness_checks`
- `automation_history`
- `automation_queue`
- `email_events`
- `email_messages`
- `form_answers`
- `form_sessions`
- `lead_scores`
- `lead_events`
- `leads`

After cleanup, each test queries every table again and fails if any test data remains.
