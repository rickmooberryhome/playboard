const assert = require("node:assert/strict");
const test = require("node:test");
const { createClient } = require("@supabase/supabase-js");

process.env.PLAYBOARD_SITE_URL = process.env.PLAYBOARD_SITE_URL || "https://playboard.test";

const hasSupabaseConfig = Boolean(
  process.env.SUPABASE_URL &&
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)
);

const leadHandler = require("../api/leads");
const trackHandler = require("../api/track");
const emailClickHandler = require("../api/email-click");
const readinessHandler = require("../api/readiness-check");

function getSupabaseClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
  );
}

function makeReq({ method = "POST", body = {}, query = {}, headers = {} } = {}) {
  return {
    method,
    body,
    query,
    headers: {
      host: "playboard.test",
      "x-forwarded-proto": "https",
      "user-agent": "playboard-automation-test",
      referer: "https://playboard.test/test-run",
      ...headers
    },
    socket: { remoteAddress: "127.0.0.1" }
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    redirectedTo: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    send(payload) { this.body = payload; return this; },
    redirect(code, url) { this.statusCode = code; this.redirectedTo = url; return this; }
  };
}

async function callHandler(handler, reqOptions) {
  const req = makeReq(reqOptions);
  const res = makeRes();
  await handler(req, res);
  return res;
}

async function getLead(supabase, leadId) {
  const { data, error } = await supabase
    .from("leads")
    .select("id, parent_email, current_state, funnel_stage, lead_score, last_event_type, readiness_started_at, readiness_completed_at")
    .eq("id", leadId)
    .single();

  assert.ifError(error);
  return data;
}

async function getLeadEvents(supabase, leadId) {
  const { data, error } = await supabase
    .from("lead_events")
    .select("event_type, score_delta, event_source, event_metadata")
    .eq("lead_id", leadId)
    .order("occurred_at", { ascending: true });

  assert.ifError(error);
  return data;
}

async function getQueueKeys(supabase, leadId) {
  const { data, error } = await supabase
    .from("automation_queue")
    .select("rule_key")
    .eq("lead_id", leadId)
    .order("rule_key", { ascending: true });

  assert.ifError(error);
  return data.map((item) => item.rule_key);
}

async function cleanupLeadData(supabase, leadIds) {
  const ids = [...new Set(leadIds.filter(Boolean))];
  if (ids.length === 0) return;

  const deleteSteps = [
    ["readiness_checks", "lead_id"],
    ["automation_history", "lead_id"],
    ["automation_queue", "lead_id"],
    ["email_events", "lead_id"],
    ["email_messages", "lead_id"],
    ["form_answers", "lead_id"],
    ["form_sessions", "lead_id"],
    ["lead_scores", "lead_id"],
    ["lead_events", "lead_id"],
    ["leads", "id"]
  ];

  for (const [table, column] of deleteSteps) {
    const { error } = await supabase.from(table).delete().in(column, ids);
    if (error && error.code !== "42P01") throw new Error(`Cleanup failed for ${table}: ${error.message}`);
  }
}

async function assertNoTestDataLeft(supabase, leadIds) {
  const ids = [...new Set(leadIds.filter(Boolean))];
  if (ids.length === 0) return;

  const checks = [
    ["readiness_checks", "lead_id"],
    ["automation_history", "lead_id"],
    ["automation_queue", "lead_id"],
    ["email_events", "lead_id"],
    ["email_messages", "lead_id"],
    ["form_answers", "lead_id"],
    ["form_sessions", "lead_id"],
    ["lead_scores", "lead_id"],
    ["lead_events", "lead_id"],
    ["leads", "id"]
  ];

  for (const [table, column] of checks) {
    const { count, error } = await supabase.select ? { count: 0, error: null } : { count: 0, error: null };
    const result = await supabase.from(table).select("*", { count: "exact", head: true }).in(column, ids);
    if (result.error && result.error.code !== "42P01") throw new Error(`Cleanup verification failed for ${table}: ${result.error.message}`);
    assert.equal(result.count || 0, 0, `${table} should not contain test data after cleanup`);
  }
}

test("Phase 1 funnel tracks lead, engaged, offered stages and queues stage follow-ups", {
  skip: hasSupabaseConfig ? false : "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for integration tests."
}, async () => {
  const supabase = getSupabaseClient();
  const runId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const leadIds = [];

  try {
    const leadRes = await callHandler(leadHandler, {
      method: "POST",
      body: {
        firstName: "Automation",
        lastName: "Tester",
        email: `automation+${runId}@example.com`,
        biggestQuestion: "How do we know which schools are realistic?"
      }
    });

    assert.equal(leadRes.statusCode, 200);
    assert.equal(leadRes.body.success, true);
    assert.match(leadRes.body.leadId, /^[0-9a-f-]{36}$/i);
    assert.equal(leadRes.body.emailStatus, "pending_ai_context");

    const leadId = leadRes.body.leadId;
    leadIds.push(leadId);

    let lead = await getLead(supabase, leadId);
    assert.equal(lead.current_state, "lead_created");
    assert.equal(lead.funnel_stage, "lead");
    assert.equal(lead.lead_score, 5);
    assert.equal(lead.last_event_type, "LEAD_CREATED");

    assert.deepEqual(await getQueueKeys(supabase, leadId), [
      "generate_first_email_context",
      "lead_followup_day_1",
      "lead_followup_day_3",
      "lead_followup_day_5",
      "lead_mark_uncommitted_day_10"
    ]);

    const { data: emailMessage, error: emailMessageError } = await supabase
      .from("email_messages")
      .insert({
        lead_id: leadId,
        campaign_key: "phase_1_test_email",
        to_email: `automation+${runId}@example.com`,
        subject: "Phase 1 test email",
        status: "sent"
      })
      .select("id")
      .single();

    assert.ifError(emailMessageError);

    const clickRes = await callHandler(emailClickHandler, {
      method: "GET",
      query: {
        lead: leadId,
        message: emailMessage.id,
        url: `/readiness-check.html?lead=${leadId}`
      }
    });

    assert.equal(clickRes.statusCode, 302);
    assert.equal(clickRes.redirectedTo, `/readiness-check.html?lead=${leadId}`);

    lead = await getLead(supabase, leadId);
    assert.equal(lead.current_state, "email_clicked");
    assert.equal(lead.funnel_stage, "engaged");

    for (const key of ["engaged_followup_day_1", "engaged_followup_day_3", "engaged_followup_day_5", "engaged_mark_uncommitted_day_10"]) {
      assert.ok((await getQueueKeys(supabase, leadId)).includes(key), `${key} should be queued`);
    }

    const formSessionId = `session-${runId}`;
    const startRes = await callHandler(trackHandler, {
      method: "POST",
      body: {
        leadId,
        eventType: "READINESS_FORM_STARTED",
        sessionId: formSessionId,
        idempotencyKey: `${leadId}:READINESS_FORM_STARTED:${formSessionId}`,
        metadata: { formKey: "readiness_check", fieldKey: "athleteGrade" }
      }
    });

    assert.equal(startRes.statusCode, 200);
    assert.equal(startRes.body.success, true);

    const readinessRes = await callHandler(readinessHandler, {
      method: "POST",
      body: {
        leadId,
        formSessionId,
        athleteGrade: "Junior",
        highSchool: "Automation High School",
        position: "QB",
        height: "6'1\"",
        weight: "185",
        hudlLink: "https://www.hudl.com/profile/automation-test",
        xAccount: "https://x.com/automationtest",
        gpa: "3.6",
        schoolsOfInterest: "Iowa, UNI, Wartburg",
        coachOutreachStatus: "No coaches contacted yet.",
        campsOrVisits: "One summer camp planned.",
        biggestConcern: "We do not know what level to target.",
        additionalContext: "Created by automated test and should be deleted."
      }
    });

    assert.equal(readinessRes.statusCode, 200);
    assert.equal(readinessRes.body.success, true);
    assert.match(readinessRes.body.readinessCheckId, /^[0-9a-f-]{36}$/i);

    lead = await getLead(supabase, leadId);
    assert.equal(lead.current_state, "form_completed");
    assert.equal(lead.funnel_stage, "offered");
    assert.equal(lead.last_event_type, "READINESS_FORM_SUBMITTED");
    assert.equal(lead.lead_score, 154);
    assert.ok(lead.readiness_started_at);
    assert.ok(lead.readiness_completed_at);

    const events = await getLeadEvents(supabase, leadId);
    assert.deepEqual(events.map((event) => event.event_type), [
      "LEAD_CREATED",
      "EMAIL_CLICKED",
      "READINESS_FORM_STARTED",
      "READINESS_FORM_SUBMITTED"
    ]);

    const finalQueueKeys = await getQueueKeys(supabase, leadId);
    for (const key of [
      "offered_followup_day_1",
      "offered_followup_day_3",
      "offered_followup_day_5",
      "offered_mark_uncommitted_day_10",
      "review_completed_readiness_check"
    ]) {
      assert.ok(finalQueueKeys.includes(key), `${key} should be queued`);
    }

    const { data: leadScore, error: leadScoreError } = await supabase
      .from("lead_scores")
      .select("score, score_band")
      .eq("lead_id", leadId)
      .single();

    assert.ifError(leadScoreError);
    assert.equal(leadScore.score, 154);
    assert.equal(leadScore.score_band, "sales_ready");
  } finally {
    await cleanupLeadData(supabase, leadIds);
    await assertNoTestDataLeft(supabase, leadIds);
  }
});
