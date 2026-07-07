const assert = require("node:assert/strict");
const test = require("node:test");
const { createClient } = require("@supabase/supabase-js");

process.env.PLAYBOARD_SITE_URL = process.env.PLAYBOARD_SITE_URL || "https://playboard.test";
process.env.PLAYBOARD_AUTOMATION_DRY_RUN = "true";

const hasDbConfig = Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY));

const leadHandler = require("../api/leads");
const readinessHandler = require("../api/readiness-check");
const automationWorker = require("../api/run-automation-queue");
const { recordLeadEvent } = require("../api/_funnel");

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY);
}

function req({ method = "POST", body = {}, query = {} } = {}) {
  return {
    method,
    body,
    query,
    headers: {
      host: "playboard.test",
      "x-forwarded-proto": "https",
      "user-agent": "phase-2-test"
    },
    socket: { remoteAddress: "127.0.0.1" }
  };
}

function res() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

async function call(handler, options) {
  const response = res();
  await handler(req(options), response);
  return response;
}

const CLEANUP_TABLES = [
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

async function cleanup(supabase, ids) {
  const leadIds = [...new Set(ids.filter(Boolean))];
  if (!leadIds.length) return;

  for (const [table, column] of CLEANUP_TABLES) {
    const { error } = await supabase.from(table).delete().in(column, leadIds);
    if (error && error.code !== "42P01") throw new Error(`Cleanup failed for ${table}: ${error.message}`);
  }
}

async function createLead(runId, biggestQuestion = "What level should we target?") {
  const response = await call(leadHandler, {
    body: {
      firstName: "PhaseTwo",
      lastName: "Automation",
      email: `phase2+${runId}@example.com`,
      biggestQuestion
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  return response.body.leadId;
}

async function makeDue(supabase, leadId, ruleKey) {
  const { error } = await supabase
    .from("automation_queue")
    .update({ run_after: new Date(Date.now() - 1000).toISOString() })
    .eq("lead_id", leadId)
    .eq("rule_key", ruleKey)
    .eq("status", "pending");

  assert.ifError(error);
}

async function campaignCount(supabase, leadId, campaignKey) {
  const { count, error } = await supabase
    .from("email_messages")
    .select("*", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("campaign_key", campaignKey);

  assert.ifError(error);
  return count || 0;
}

async function ruleStatus(supabase, leadId, ruleKey) {
  const { data, error } = await supabase
    .from("automation_queue")
    .select("status")
    .eq("lead_id", leadId)
    .eq("rule_key", ruleKey)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  assert.ifError(error);
  return data?.status || null;
}

async function runWorker(leadId) {
  const response = await call(automationWorker, { body: { leadId } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.targetLeadId, leadId);
  return response.body;
}

async function submitReadiness(leadId, runId) {
  const readiness = await call(readinessHandler, {
    body: {
      leadId,
      formSessionId: `complete-${runId}`,
      athleteGrade: "Junior",
      highSchool: "Automation High",
      position: "QB",
      height: "6-1",
      weight: "185",
      gpa: "3.6",
      schoolsOfInterest: "Iowa, UNI",
      coachOutreachStatus: "None yet",
      campsOrVisits: "One camp",
      biggestConcern: "Level fit",
      additionalContext: "test"
    }
  });

  assert.equal(readiness.statusCode, 200);
  assert.equal(readiness.body.success, true);
  return readiness.body.readinessCheckId;
}

test("Phase 2 automation handles stage follow-ups, stage skip paths, uncommitted status, and AI context", { skip: hasDbConfig ? false : "database env vars required" }, async () => {
  const supabase = db();
  const ids = [];
  const runId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const contextLeadId = await createLead(`${runId}-context`);
    ids.push(contextLeadId);
    await makeDue(supabase, contextLeadId, "generate_first_email_context");
    let result = await runWorker(contextLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await ruleStatus(supabase, contextLeadId, "generate_first_email_context"), "completed");
    assert.equal(await ruleStatus(supabase, contextLeadId, "send_first_email"), "pending");

    const engagedLeadId = await createLead(`${runId}-engaged`);
    ids.push(engagedLeadId);
    await makeDue(supabase, engagedLeadId, "lead_followup_day_1");
    await recordLeadEvent(supabase, {
      leadId: engagedLeadId,
      eventType: "EMAIL_CLICKED",
      source: "test",
      metadata: { runId },
      idempotencyKey: `test-clicked:${engagedLeadId}`
    });
    result = await runWorker(engagedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, engagedLeadId, "lead_followup_day_1"), 0, "old lead-stage email should not send after engagement");
    assert.equal(await ruleStatus(supabase, engagedLeadId, "lead_followup_day_1"), "completed");

    await makeDue(supabase, engagedLeadId, "engaged_followup_day_1");
    result = await runWorker(engagedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, engagedLeadId, "engaged_followup_day_1"), 1);

    const offeredLeadId = await createLead(`${runId}-offered`);
    ids.push(offeredLeadId);
    await submitReadiness(offeredLeadId, runId);
    await makeDue(supabase, offeredLeadId, "offered_followup_day_1");
    result = await runWorker(offeredLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, offeredLeadId, "offered_followup_day_1"), 1);

    const uncommittedLeadId = await createLead(`${runId}-uncommitted`);
    ids.push(uncommittedLeadId);
    await makeDue(supabase, uncommittedLeadId, "lead_mark_uncommitted_day_10");
    result = await runWorker(uncommittedLeadId);
    assert.ok(result.processed >= 1);

    const { data: uncommittedLead, error: uncommittedError } = await supabase
      .from("leads")
      .select("current_state, funnel_stage, last_event_type")
      .eq("id", uncommittedLeadId)
      .single();
    assert.ifError(uncommittedError);
    assert.equal(uncommittedLead.current_state, "uncommitted");
    assert.equal(uncommittedLead.funnel_stage, "uncommitted");
    assert.equal(uncommittedLead.last_event_type, "LEAD_UNCOMMITTED");
  } finally {
    await cleanup(supabase, ids);
  }
});
