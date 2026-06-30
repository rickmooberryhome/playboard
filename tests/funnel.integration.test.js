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
const emailOpenHandler = require("../api/email-open");
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
    socket: {
      remoteAddress: "127.0.0.1"
    }
  };
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    redirectedTo: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    redirect(code, url) {
      this.statusCode = code;
      this.redirectedTo = url;
      return this;
    }
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
    if (error && error.code !== "42P01") {
      throw new Error(`Cleanup failed for ${table}: ${error.message}`);
    }
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
    const { count, error } = await supabase
      .from(table)
      .select("id", { count: "exact", head: true })
      .in(column, ids);

    if (error && error.code !== "42P01") {
      throw new Error(`Cleanup verification failed for ${table}: ${error.message}`);
    }

    assert.equal(count || 0, 0, `${table} should not contain test data after cleanup`);
  }
}

test("Phase 1 funnel tracks lead, email, form progress, completion, scoring, queues, and cleanup", {
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
    assert.equal(lead.funnel_stage, "lead_created");
    assert.equal(lead.lead_score, 5);
    assert.equal(lead.last_event_type, "LEAD_CREATED");

    let events = await getLeadEvents(supabase, leadId);
    assert.deepEqual(events.map((event) => event.event_type), ["LEAD_CREATED"]);
    assert.equal(events[0].score_delta, 5);

    const { data: initialQueue, error: initialQueueError } = await supabase
      .from("automation_queue")
      .select("rule_key, status, priority")
      .eq("lead_id", leadId)
      .order("priority", { ascending: true });

    assert.ifError(initialQueueError);
    assert.deepEqual(initialQueue.map((item) => item.rule_key).sort(), [
      "first_email_unopened_24h",
      "generate_first_email_context"
    ]);
    assert.ok(initialQueue.every((item) => item.status === "pending"));

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

    const openRes = await callHandler(emailOpenHandler, {
      method: "GET",
      query: {
        lead: leadId,
        message: emailMessage.id
      }
    });

    assert.equal(openRes.statusCode, 200);
    assert.equal(openRes.headers["content-type"], "image/gif");
    assert.ok(Buffer.isBuffer(openRes.body));

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

    const { data: trackedEmail, error: trackedEmailError } = await supabase
      .from("email_messages")
      .select("status, opened_at, clicked_at")
      .eq("id", emailMessage.id)
      .single();

    assert.ifError(trackedEmailError);
    assert.equal(trackedEmail.status, "clicked");
    assert.ok(trackedEmail.opened_at);
    assert.ok(trackedEmail.clicked_at);

    const formSessionId = `session-${runId}`;

    const startRes = await callHandler(trackHandler, {
      method: "POST",
      body: {
        leadId,
        eventType: "READINESS_FORM_STARTED",
        sessionId: formSessionId,
        idempotencyKey: `${leadId}:READINESS_FORM_STARTED:${formSessionId}`,
        metadata: {
          formKey: "readiness_check",
          fieldKey: "athleteGrade"
        }
      }
    });

    assert.equal(startRes.statusCode, 200);
    assert.equal(startRes.body.success, true);

    for (const [fieldKey, answerValue] of [
      ["athleteGrade", "Junior"],
      ["highSchool", "Automation High School"]
    ]) {
      const answerRes = await callHandler(trackHandler, {
        method: "POST",
        body: {
          leadId,
          eventType: "READINESS_QUESTION_ANSWERED",
          sessionId: formSessionId,
          idempotencyKey: `${leadId}:READINESS_QUESTION_ANSWERED:${formSessionId}:${fieldKey}`,
          metadata: {
            formKey: "readiness_check",
            fieldKey,
            answerValue
          }
        }
      });

      assert.equal(answerRes.statusCode, 200);
      assert.equal(answerRes.body.success, true);
    }

    const { data: startedSession, error: startedSessionError } = await supabase
      .from("form_sessions")
      .select("status, fields_completed, session_id")
      .eq("lead_id", leadId)
      .eq("form_key", "readiness_check")
      .eq("session_id", formSessionId)
      .single();

    assert.ifError(startedSessionError);
    assert.equal(startedSession.status, "started");
    assert.equal(startedSession.fields_completed, 2);

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
    assert.equal(lead.funnel_stage, "form_completed");
    assert.equal(lead.last_event_type, "READINESS_FORM_SUBMITTED");
    assert.equal(lead.lead_score, 164);
    assert.ok(lead.readiness_started_at);
    assert.ok(lead.readiness_completed_at);

    events = await getLeadEvents(supabase, leadId);
    assert.deepEqual(events.map((event) => event.event_type), [
      "LEAD_CREATED",
      "EMAIL_OPENED",
      "EMAIL_CLICKED",
      "READINESS_FORM_STARTED",
      "READINESS_QUESTION_ANSWERED",
      "READINESS_QUESTION_ANSWERED",
      "READINESS_FORM_SUBMITTED"
    ]);

    const { data: completedSession, error: completedSessionError } = await supabase
      .from("form_sessions")
      .select("status, fields_completed, completed_at")
      .eq("lead_id", leadId)
      .eq("form_key", "readiness_check")
      .eq("session_id", formSessionId)
      .single();

    assert.ifError(completedSessionError);
    assert.equal(completedSession.status, "completed");
    assert.equal(completedSession.fields_completed, 13);
    assert.ok(completedSession.completed_at);

    const { count: answerCount, error: answerCountError } = await supabase
      .from("form_answers")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId)
      .eq("form_key", "readiness_check");

    assert.ifError(answerCountError);
    assert.equal(answerCount, 13);

    const { data: finalQueue, error: finalQueueError } = await supabase
      .from("automation_queue")
      .select("rule_key")
      .eq("lead_id", leadId);

    assert.ifError(finalQueueError);
    assert.deepEqual(finalQueue.map((item) => item.rule_key).sort(), [
      "first_email_unopened_24h",
      "generate_first_email_context",
      "readiness_followup_24h",
      "review_completed_readiness_check"
    ]);

    const { data: leadScore, error: leadScoreError } = await supabase
      .from("lead_scores")
      .select("score, score_band")
      .eq("lead_id", leadId)
      .single();

    assert.ifError(leadScoreError);
    assert.equal(leadScore.score, 164);
    assert.equal(leadScore.score_band, "sales_ready");
  } finally {
    await cleanupLeadData(supabase, leadIds);
    await assertNoTestDataLeft(supabase, leadIds);
  }
});
