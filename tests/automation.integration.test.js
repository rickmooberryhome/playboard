const assert = require("node:assert/strict");
const test = require("node:test");
const { createClient } = require("@supabase/supabase-js");

process.env.PLAYBOARD_SITE_URL = process.env.PLAYBOARD_SITE_URL || "https://playboard.test";
process.env.PLAYBOARD_AUTOMATION_DRY_RUN = "true";

const hasDbConfig = Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY));

const leadHandler = require("../api/leads");
const trackHandler = require("../api/track");
const readinessHandler = require("../api/readiness-check");
const automationWorker = require("../api/run-automation-queue");
const { recordLeadEvent } = require("../api/_funnel");

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY);
}

function req({ method = "POST", body = {}, query = {} } = {}) {
  return { method, body, query, headers: { host: "playboard.test", "x-forwarded-proto": "https", "user-agent": "phase-2-test" }, socket: { remoteAddress: "127.0.0.1" } };
}

function res() {
  return { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
}

async function call(handler, options) {
  const response = res();
  await handler(req(options), response);
  return response;
}

async function cleanup(supabase, ids) {
  const leadIds = [...new Set(ids.filter(Boolean))];
  if (!leadIds.length) return;
  for (const [table, column] of [["readiness_checks", "lead_id"], ["automation_history", "lead_id"], ["automation_queue", "lead_id"], ["email_events", "lead_id"], ["email_messages", "lead_id"], ["form_answers", "lead_id"], ["form_sessions", "lead_id"], ["lead_scores", "lead_id"], ["lead_events", "lead_id"], ["leads", "id"]]) {
    const { error } = await supabase.from(table).delete().in(column, leadIds);
    if (error && error.code !== "42P01") throw new Error(`Cleanup failed for ${table}: ${error.message}`);
  }
  for (const [table, column] of [["readiness_checks", "lead_id"], ["automation_history", "lead_id"], ["automation_queue", "lead_id"], ["email_events", "lead_id"], ["email_messages", "lead_id"], ["form_answers", "lead_id"], ["form_sessions", "lead_id"], ["lead_scores", "lead_id"], ["lead_events", "lead_id"], ["leads", "id"]]) {
    const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true }).in(column, leadIds);
    if (error && error.code !== "42P01") throw new Error(`Cleanup check failed for ${table}: ${error.message}`);
    assert.equal(count || 0, 0, `${table} should be clean`);
  }
}

async function createLead(runId) {
  const response = await call(leadHandler, { body: { firstName: "PhaseTwo", lastName: "Automation", email: `phase2+${runId}@example.com`, biggestQuestion: "What level should we target?" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  return response.body.leadId;
}

async function makeDue(supabase, leadId, ruleKey) {
  const { error } = await supabase.from("automation_queue").update({ run_after: new Date(Date.now() - 1000).toISOString() }).eq("lead_id", leadId).eq("rule_key", ruleKey).eq("status", "pending");
  assert.ifError(error);
}

async function campaignCount(supabase, leadId, campaignKey) {
  const { count, error } = await supabase.from("email_messages").select("*", { count: "exact", head: true }).eq("lead_id", leadId).eq("campaign_key", campaignKey);
  assert.ifError(error);
  return count || 0;
}

async function runWorker(leadId) {
  const response = await call(automationWorker, { body: { leadId } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.targetLeadId, leadId);
  return response.body;
}

test("Phase 2 automation sends sequence emails, recovers abandoned forms, queues review, and cleans up", { skip: hasDbConfig ? false : "database env vars required" }, async () => {
  const supabase = db();
  const ids = [];
  const runId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const unopenedLeadId = await createLead(`${runId}-unopened`);
    ids.push(unopenedLeadId);
    await makeDue(supabase, unopenedLeadId, "first_email_unopened_24h");
    let result = await runWorker(unopenedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, unopenedLeadId, "first_email_unopened_24h"), 1);

    const openedLeadId = await createLead(`${runId}-opened`);
    ids.push(openedLeadId);
    await recordLeadEvent(supabase, { leadId: openedLeadId, eventType: "EMAIL_OPENED", source: "test", metadata: { runId }, idempotencyKey: `test-opened:${openedLeadId}` });
    await makeDue(supabase, openedLeadId, "first_email_unopened_24h");
    result = await runWorker(openedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, openedLeadId, "first_email_unopened_24h"), 0);
    await makeDue(supabase, openedLeadId, "opened_no_click_24h");
    result = await runWorker(openedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, openedLeadId, "opened_no_click_24h"), 1);

    const abandonedLeadId = await createLead(`${runId}-abandoned`);
    ids.push(abandonedLeadId);
    const sessionId = `session-${runId}`;
    const started = await call(trackHandler, { body: { leadId: abandonedLeadId, eventType: "READINESS_FORM_STARTED", sessionId, idempotencyKey: `${abandonedLeadId}:started:${sessionId}`, metadata: { formKey: "readiness_check", fieldKey: "athleteGrade", queueAbandonmentRecovery: true } } });
    assert.equal(started.statusCode, 200);
    await makeDue(supabase, abandonedLeadId, "readiness_abandoned_30m");
    result = await runWorker(abandonedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, abandonedLeadId, "readiness_abandoned_30m"), 1);

    const completedLeadId = await createLead(`${runId}-completed`);
    ids.push(completedLeadId);
    const readiness = await call(readinessHandler, { body: { leadId: completedLeadId, formSessionId: `complete-${runId}`, athleteGrade: "Junior", highSchool: "Automation High", position: "QB", height: "6-1", weight: "185", gpa: "3.6", schoolsOfInterest: "Iowa, UNI", coachOutreachStatus: "None yet", campsOrVisits: "One camp", biggestConcern: "Level fit", additionalContext: "test" } });
    assert.equal(readiness.statusCode, 200);
    await makeDue(supabase, completedLeadId, "review_completed_readiness_check");
    await makeDue(supabase, completedLeadId, "readiness_followup_24h");
    result = await runWorker(completedLeadId);
    assert.ok(result.processed >= 2);
    assert.equal(await campaignCount(supabase, completedLeadId, "readiness_followup_24h"), 1);

    const { count: reviewCount, error: reviewError } = await supabase.from("lead_events").select("*", { count: "exact", head: true }).eq("lead_id", completedLeadId).eq("event_type", "READINESS_REVIEW_QUEUED");
    assert.ifError(reviewError);
    assert.equal(reviewCount, 1);
  } finally {
    await cleanup(supabase, ids);
  }
});
