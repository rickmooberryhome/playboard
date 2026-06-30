const assert = require("node:assert/strict");
const test = require("node:test");
const { createClient } = require("@supabase/supabase-js");

const hasDbConfig = Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY));
const analyticsHandler = require("../api/analytics");

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY);
}

function req({ method = "GET", query = {}, body = {}, headers = {} } = {}) {
  return { method, query, body, headers, socket: { remoteAddress: "127.0.0.1" } };
}

function res() {
  return { statusCode: 200, body: undefined, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
}

async function call(handler, options) {
  const response = res();
  await handler(req(options), response);
  return response;
}

async function insertLead(supabase, runId, suffix) {
  const { data, error } = await supabase.from("leads").insert({
    athlete_first_name: "Analytics",
    athlete_last_name: suffix,
    parent_email: `analytics+${runId}-${suffix}@example.com`,
    source: "analytics_test",
    current_state: "lead_created",
    funnel_stage: "lead_created",
    lead_score: 5
  }).select("id").single();

  assert.ifError(error);
  return data.id;
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

test("Phase 3 analytics reports funnel, email, form, drop-off data and cleans up", { skip: hasDbConfig ? false : "database env vars required" }, async () => {
  const supabase = db();
  const runId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const ids = [];

  try {
    const leadA = await insertLead(supabase, runId, "submitted");
    const leadB = await insertLead(supabase, runId, "abandoned");
    const leadC = await insertLead(supabase, runId, "opened");
    ids.push(leadA, leadB, leadC);

    const now = new Date().toISOString();
    const events = [
      [leadA, "LEAD_CREATED"], [leadA, "EMAIL_SENT"], [leadA, "EMAIL_OPENED"], [leadA, "EMAIL_CLICKED"], [leadA, "READINESS_FORM_STARTED"], [leadA, "READINESS_FORM_SUBMITTED"], [leadA, "READINESS_REVIEW_QUEUED"],
      [leadB, "LEAD_CREATED"], [leadB, "EMAIL_SENT"], [leadB, "EMAIL_OPENED"], [leadB, "EMAIL_CLICKED"], [leadB, "READINESS_FORM_STARTED"],
      [leadC, "LEAD_CREATED"], [leadC, "EMAIL_SENT"], [leadC, "EMAIL_OPENED"]
    ].map(([lead_id, event_type]) => ({ lead_id, event_type, event_source: "test", occurred_at: now, event_metadata: {}, idempotency_key: `${runId}:${lead_id}:${event_type}` }));

    let result = await supabase.from("lead_events").insert(events);
    assert.ifError(result.error);

    result = await supabase.from("email_messages").insert([
      { lead_id: leadA, campaign_key: "phase3_submit", to_email: `a-${runId}@example.com`, subject: "A", status: "clicked", sent_at: now, opened_at: now, clicked_at: now },
      { lead_id: leadB, campaign_key: "phase3_abandon", to_email: `b-${runId}@example.com`, subject: "B", status: "clicked", sent_at: now, opened_at: now, clicked_at: now },
      { lead_id: leadC, campaign_key: "phase3_open", to_email: `c-${runId}@example.com`, subject: "C", status: "opened", sent_at: now, opened_at: now }
    ]);
    assert.ifError(result.error);

    result = await supabase.from("form_sessions").insert([
      { lead_id: leadA, form_key: "readiness_check", status: "completed", fields_completed: 3, started_at: now, last_activity_at: now, completed_at: now },
      { lead_id: leadB, form_key: "readiness_check", status: "started", fields_completed: 1, started_at: now, last_activity_at: now }
    ]);
    assert.ifError(result.error);

    result = await supabase.from("form_answers").insert([
      { lead_id: leadA, form_key: "readiness_check", field_key: "athleteGrade", answer_value: "Junior", answered_at: now },
      { lead_id: leadA, form_key: "readiness_check", field_key: "highSchool", answer_value: "Analytics High", answered_at: now },
      { lead_id: leadA, form_key: "readiness_check", field_key: "position", answer_value: "QB", answered_at: now },
      { lead_id: leadB, form_key: "readiness_check", field_key: "athleteGrade", answer_value: "Sophomore", answered_at: now }
    ]);
    assert.ifError(result.error);

    result = await supabase.from("automation_history").insert([
      { lead_id: leadA, rule_key: "readiness_followup_24h", action_type: "send_email", status: "completed", payload: {}, result: {} },
      { lead_id: leadB, rule_key: "readiness_abandoned_30m", action_type: "send_email", status: "completed", payload: {}, result: {} }
    ]);
    assert.ifError(result.error);

    const response = await call(analyticsHandler, { query: { days: "7" } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);

    const analytics = response.body.analytics;
    assert.ok(analytics.summary.leads >= 3);
    assert.ok(analytics.funnel.find((stage) => stage.key === "lead_created").count >= 3);
    assert.ok(analytics.funnel.find((stage) => stage.key === "form_submitted").count >= 1);
    assert.ok(analytics.email.openRate >= 100 || analytics.email.openRate > 0);
    assert.ok(analytics.email.campaigns.some((campaign) => campaign.campaignKey === "phase3_submit"));
    assert.ok(analytics.form.completionRate > 0);
    assert.ok(analytics.form.fields.some((field) => field.fieldKey === "athleteGrade"));
    assert.ok(analytics.dropOff.biggestStageDrops.length > 0);
    assert.ok(analytics.dropOff.weakestFormFields.length > 0);
  } finally {
    await cleanup(supabase, ids);
  }
});

test("Phase 3 analytics key blocks unauthorized requests when configured", async () => {
  const original = process.env.PLAYBOARD_ANALYTICS_KEY;
  process.env.PLAYBOARD_ANALYTICS_KEY = "phase3-secret";

  try {
    const blocked = await call(analyticsHandler, { query: { days: "7" } });
    assert.equal(blocked.statusCode, 401);

    const allowed = await call(analyticsHandler, { query: { days: "7", key: "phase3-secret" } });
    assert.notEqual(allowed.statusCode, 401);
  } finally {
    if (original === undefined) delete process.env.PLAYBOARD_ANALYTICS_KEY;
    else process.env.PLAYBOARD_ANALYTICS_KEY = original;
  }
});
