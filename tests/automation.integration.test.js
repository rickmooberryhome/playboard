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
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
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

  for (const [table, column] of CLEANUP_TABLES) {
    const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true }).in(column, leadIds);
    if (error && error.code !== "42P01") throw new Error(`Cleanup check failed for ${table}: ${error.message}`);
    assert.equal(count || 0, 0, `${table} should be clean`);
  }
}

async function createLead(runId) {
  const response = await call(leadHandler, {
    body: {
      firstName: "PhaseTwo",
      lastName: "Automation",
      email: `phase2+${runId}@example.com`,
      biggestQuestion: "What level should we target?"
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  return response.body.leadId;
}

async function insertRule(supabase, leadId, ruleKey, suffix = "manual") {
  const { data, error } = await supabase
    .from("automation_queue")
    .insert({
      lead_id: leadId,
      rule_key: ruleKey,
      status: "pending",
      priority: 1,
      run_after: new Date(Date.now() - 1000).toISOString(),
      payload: { test: true, suffix },
      dedupe_key: `${leadId}:${ruleKey}:${suffix}`
    })
    .select("id")
    .single();

  assert.ifError(error);
  return data.id;
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

async function historyCount(supabase, leadId, ruleKey, status = null) {
  let query = supabase
    .from("automation_history")
    .select("*", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("rule_key", ruleKey);

  if (status) query = query.eq("status", status);

  const { count, error } = await query;
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

test("Phase 2 automation sends sequence emails, handles skip paths, records history, and cleans up", { skip: hasDbConfig ? false : "database env vars required" }, async () => {
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

    const unopenedLeadId = await createLead(`${runId}-unopened`);
    ids.push(unopenedLeadId);
    await makeDue(supabase, unopenedLeadId, "first_email_unopened_24h");
    result = await runWorker(unopenedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, unopenedLeadId, "first_email_unopened_24h"), 1);
    assert.equal(await ruleStatus(supabase, unopenedLeadId, "first_email_unopened_24h"), "completed");
    assert.equal(await ruleStatus(supabase, unopenedLeadId, "first_email_unopened_72h"), "pending");

    await makeDue(supabase, unopenedLeadId, "first_email_unopened_72h");
    result = await runWorker(unopenedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, unopenedLeadId, "first_email_unopened_24h"), 1, "duplicate unopened campaign should not be sent twice");
    assert.ok(await historyCount(supabase, unopenedLeadId, "first_email_unopened_72h", "skipped") >= 1);

    const openedLeadId = await createLead(`${runId}-opened`);
    ids.push(openedLeadId);
    await recordLeadEvent(supabase, {
      leadId: openedLeadId,
      eventType: "EMAIL_OPENED",
      source: "test",
      metadata: { runId },
      idempotencyKey: `test-opened:${openedLeadId}`
    });
    await makeDue(supabase, openedLeadId, "first_email_unopened_24h");
    result = await runWorker(openedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, openedLeadId, "first_email_unopened_24h"), 0);
    assert.equal(await ruleStatus(supabase, openedLeadId, "opened_no_click_24h"), "pending");

    await makeDue(supabase, openedLeadId, "opened_no_click_24h");
    result = await runWorker(openedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, openedLeadId, "opened_no_click_24h"), 1);

    const clickedLeadId = await createLead(`${runId}-clicked`);
    ids.push(clickedLeadId);
    await recordLeadEvent(supabase, {
      leadId: clickedLeadId,
      eventType: "EMAIL_CLICKED",
      source: "test",
      metadata: { runId },
      idempotencyKey: `test-clicked:${clickedLeadId}`
    });
    await insertRule(supabase, clickedLeadId, "opened_no_click_24h", "clicked-skip");
    result = await runWorker(clickedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, clickedLeadId, "opened_no_click_24h"), 0);
    assert.ok(await historyCount(supabase, clickedLeadId, "opened_no_click_24h", "skipped") >= 1);

    const abandonedLeadId = await createLead(`${runId}-abandoned`);
    ids.push(abandonedLeadId);
    const sessionId = `session-${runId}`;
    const started = await call(trackHandler, {
      body: {
        leadId: abandonedLeadId,
        eventType: "READINESS_FORM_STARTED",
        sessionId,
        idempotencyKey: `${abandonedLeadId}:started:${sessionId}`,
        metadata: { formKey: "readiness_check", fieldKey: "athleteGrade", queueAbandonmentRecovery: true }
      }
    });
    assert.equal(started.statusCode, 200);
    assert.equal(await ruleStatus(supabase, abandonedLeadId, "readiness_abandoned_30m"), "pending");
    assert.equal(await ruleStatus(supabase, abandonedLeadId, "readiness_abandoned_24h"), "pending");

    await makeDue(supabase, abandonedLeadId, "readiness_abandoned_30m");
    result = await runWorker(abandonedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, abandonedLeadId, "readiness_abandoned_30m"), 1);

    await makeDue(supabase, abandonedLeadId, "readiness_abandoned_24h");
    result = await runWorker(abandonedLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, abandonedLeadId, "readiness_abandoned_24h"), 1);

    const completedLeadId = await createLead(`${runId}-completed`);
    ids.push(completedLeadId);
    await submitReadiness(completedLeadId, runId);
    await makeDue(supabase, completedLeadId, "review_completed_readiness_check");
    await makeDue(supabase, completedLeadId, "readiness_followup_24h");
    result = await runWorker(completedLeadId);
    assert.ok(result.processed >= 2);
    assert.equal(await campaignCount(supabase, completedLeadId, "readiness_followup_24h"), 1);

    const { count: reviewCount, error: reviewError } = await supabase
      .from("lead_events")
      .select("*", { count: "exact", head: true })
      .eq("lead_id", completedLeadId)
      .eq("event_type", "READINESS_REVIEW_QUEUED");
    assert.ifError(reviewError);
    assert.equal(reviewCount, 1);

    const completedSkipLeadId = await createLead(`${runId}-completed-skip`);
    ids.push(completedSkipLeadId);
    await submitReadiness(completedSkipLeadId, `${runId}-skip`);
    await insertRule(supabase, completedSkipLeadId, "readiness_abandoned_30m", "completed-skip");
    result = await runWorker(completedSkipLeadId);
    assert.ok(result.processed >= 1);
    assert.equal(await campaignCount(supabase, completedSkipLeadId, "readiness_abandoned_30m"), 0);
    assert.ok(await historyCount(supabase, completedSkipLeadId, "readiness_abandoned_30m", "skipped") >= 1);

    const { count: totalHistory, error: historyError } = await supabase
      .from("automation_history")
      .select("*", { count: "exact", head: true })
      .in("lead_id", ids);
    assert.ifError(historyError);
    assert.ok(totalHistory >= 10, "automation history should record completed and skipped actions");
  } finally {
    await cleanup(supabase, ids);
  }
});
