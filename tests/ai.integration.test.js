const assert = require("node:assert/strict");
const test = require("node:test");
const { createClient } = require("@supabase/supabase-js");

process.env.PLAYBOARD_AI_DRY_RUN = "true";
process.env.PLAYBOARD_AUTOMATION_DRY_RUN = "true";
process.env.PLAYBOARD_SITE_URL = process.env.PLAYBOARD_SITE_URL || "https://playboard.test";

const hasDbConfig = Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY));
const leadHandler = require("../api/leads");
const readinessHandler = require("../api/readiness-check");
const automationWorker = require("../api/run-automation-queue");
const aiLeadHandler = require("../api/ai-lead");
const { inferEngagement, summarizeLeadDeterministic, buildDynamicEmailDeterministic } = require("../api/_ai");

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY);
}

function req({ method = "POST", body = {}, query = {}, headers = {} } = {}) {
  return { method, body, query, headers: { host: "playboard.test", "x-forwarded-proto": "https", "user-agent": "phase-4-ai-test", ...headers }, socket: { remoteAddress: "127.0.0.1" } };
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
  const response = await call(leadHandler, { body: { firstName: "PhaseFour", lastName: "AI", email: `phase4+${runId}@example.com`, biggestQuestion: "How do we know what schools fit?" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  return response.body.leadId;
}

async function submitReadiness(leadId, runId) {
  const response = await call(readinessHandler, { body: { leadId, formSessionId: `ai-${runId}`, athleteGrade: "Junior", highSchool: "AI High", position: "QB", height: "6-1", weight: "185", hudlLink: "https://hudl.com/test", xAccount: "https://x.com/test", gpa: "3.7", schoolsOfInterest: "Iowa, UNI, Wartburg", coachOutreachStatus: "No outreach yet", campsOrVisits: "One camp planned", biggestConcern: "We do not know which schools are realistic.", additionalContext: "AI test context" } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  return response.body.readinessCheckId;
}

async function insertRule(supabase, leadId, ruleKey, suffix) {
  const { data, error } = await supabase.from("automation_queue").insert({ lead_id: leadId, rule_key: ruleKey, status: "pending", priority: 1, run_after: new Date(Date.now() - 1000).toISOString(), payload: { test: true }, dedupe_key: `${leadId}:${ruleKey}:${suffix}` }).select("id").single();
  assert.ifError(error);
  return data.id;
}

async function runWorker(leadId) {
  const response = await call(automationWorker, { body: { leadId } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  return response.body;
}

test("Phase 4 deterministic AI helpers summarize, predict, and write dynamic email copy", () => {
  const lead = { athlete_first_name: "Jordan", biggest_question: "Where should we start?", lead_score: 75, readiness_check_url: "/readiness-check.html?lead=test" };
  const events = [{ event_type: "EMAIL_OPENED" }, { event_type: "EMAIL_CLICKED" }, { event_type: "READINESS_FORM_STARTED" }];
  const answers = [{ field_key: "position", answer_value: "QB" }, { field_key: "athleteGrade", answer_value: "Junior" }, { field_key: "highSchool", answer_value: "AI High" }, { field_key: "biggestConcern", answer_value: "Finding the right fit" }];
  const engagement = inferEngagement({ lead, events, answers });
  assert.equal(engagement.prediction, "high");
  assert.ok(engagement.confidence >= 0.6);
  const summary = summarizeLeadDeterministic({ lead, events, answers });
  assert.match(summary.summary, /Jordan/);
  assert.match(summary.nextBestAction, /readiness/i);
  const email = buildDynamicEmailDeterministic({ lead, summary, sequenceKey: "ai_personalized_followup" });
  assert.match(email.subject, /Jordan/);
  assert.match(email.text, /Recommended next step/);
});

test("Phase 4 AI endpoint and automation generate summaries and personalized follow-ups with cleanup", { skip: hasDbConfig ? false : "database env vars required" }, async () => {
  const supabase = db();
  const ids = [];
  const runId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const leadId = await createLead(runId);
    ids.push(leadId);
    await submitReadiness(leadId, runId);

    let response = await call(aiLeadHandler, { method: "GET", query: { leadId, includeEmail: "true" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.ok(response.body.summary.summary.includes("PhaseFour"));
    assert.ok(response.body.summary.engagementPrediction.prediction);
    assert.ok(response.body.dynamicEmail.subject);
    assert.equal(response.body.summary.aiUsed, false);

    await insertRule(supabase, leadId, "generate_ai_lead_summary", "summary");
    await insertRule(supabase, leadId, "ai_personalized_followup", "email");
    const worker = await runWorker(leadId);
    assert.ok(worker.processed >= 2);

    const { count: summaryCount, error: summaryError } = await supabase.from("lead_events").select("*", { count: "exact", head: true }).eq("lead_id", leadId).eq("event_type", "AI_LEAD_SUMMARY_GENERATED");
    assert.ifError(summaryError);
    assert.ok(summaryCount >= 2);

    const { count: emailEventCount, error: emailEventError } = await supabase.from("lead_events").select("*", { count: "exact", head: true }).eq("lead_id", leadId).eq("event_type", "AI_DYNAMIC_EMAIL_GENERATED");
    assert.ifError(emailEventError);
    assert.equal(emailEventCount, 1);

    const { data: aiEmail, error: aiEmailError } = await supabase.from("email_messages").select("campaign_key, provider, status, metadata").eq("lead_id", leadId).eq("campaign_key", "ai_personalized_followup").single();
    assert.ifError(aiEmailError);
    assert.equal(aiEmail.provider, "dry_run");
    assert.equal(aiEmail.status, "sent");
    assert.equal(aiEmail.metadata.aiUsed, false);
  } finally {
    await cleanup(supabase, ids);
  }
});
