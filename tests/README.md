# PlayBoard Automated Tests

These tests use free tooling only:

- Node.js built-in test runner
- The existing Supabase JavaScript client dependency
- GitHub Actions for repeatable CI runs

## Commands

```bash
npm run test:syntax
npm run test:integration
npm test
```

## What the Phase 1 integration test covers

The test creates one uniquely tagged test lead, runs through the Phase 1 funnel foundation, verifies the database state, and then deletes everything it created.

Covered areas:

- Lead creation through `api/leads.js`
- `LEAD_CREATED` event recording
- Lead score rollup
- Lead state and funnel stage rollup
- Initial automation queue records
- Email message tracking record
- Email open tracking through `api/email-open.js`
- Email click tracking through `api/email-click.js`
- Readiness form started tracking through `api/track.js`
- Readiness question answer tracking through `api/track.js`
- Form session progress
- Readiness submission through `api/readiness-check.js`
- Form completion state
- Form answer rollups
- Final automation queue records
- Final lead score band
- Cleanup verification across all Phase 1 tables

## Cleanup guarantee

The test stores every created lead ID and deletes related records from:

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

After cleanup, it queries each table again and fails if any test data remains.
