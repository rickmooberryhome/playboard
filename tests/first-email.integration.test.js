const assert = require("node:assert/strict");
const test = require("node:test");
const { createClient } = require("@supabase/supabase-js");

process.env.PLAYBOARD_SITE_URL = process.env.PLAYBOARD_SITE_URL || "https://playboard.test";
process.env.PLAYBOARD_AUTOMATION_DRY_RUN = "true";

const hasDbConfig = Boolean(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY));

const leadHandler = require("../api/leads");
const sendReadyLeadEmails = require("../api/send-ready-lead-emails");

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY);
}

function req({ method = "POST", body = {}, query = {}, headers = {} } = {}) {
  return {
    method,
    body,
    query,
    headers: {
      host: "playboard.test",
      "x-forwarded-proto": "https",
      "user-agent": "first-email-test",
      ...(process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {}),
      ...headers
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
}

async function createReadyLead(runId) {
  const response = await call(leadHandler, {
    body: {
      firstName: "Tracked",
      lastName: "FirstEmail",
      email: `tracked-first-email+${runId}@example.com`,
      biggestQuestion: ""
    }
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.success, true);
  assert.equal(response.body.emailStatus, "ready_to_send");
  return response.body.leadId;
}

test("first email sender creates tracked email message and records EMAIL_SENT", { skip: hasDbConfig ? false : "database env vars required" }, async () => {
  const supabase = db();
  const ids = [];
  const runId = `test-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const sampleEmail = sendReadyLeadEmails.buildFirstEmail({
      athlete_first_name: "Sample",
      readiness_check_url: "https://playboard.test/readiness-check.html?lead=sample"
    });
    assert.equal(sampleEmail.campaignKey, "first_email");
    assert.equal(sampleEmail.targetUrl, "https://playboard.test/readiness-check.html?lead=sample");
    assert.ok(sampleEmail.html.includes("{{ACTION_URL}}"), "HTML CTA should use tracked action placeholder");

    const leadId = await createReadyLead(runId);
    ids.push(leadId);

    const sendResponse = await call(sendReadyLeadEmails, { method: "POST", body: { leadId } });
    assert.equal(sendResponse.statusCode, 200);
    assert.equal(sendResponse.body.success, true);
    assert.equal(sendResponse.body.targetLeadId, leadId);
    assert.equal(sendResponse.body.checked, 1);
    assert.equal(sendResponse.body.sent, 1);
    assert.equal(sendResponse.body.failed, 0);

    const { data: lead, error: leadError } = await supabase
      .from("leads")
      .select("first_email_status, first_email_sent, email_sent, first_email_sent_at, first_email_resend_id")
      .eq("id", leadId)
      .single();
    assert.ifError(leadError);
    assert.equal(lead.first_email_status, "sent");
    assert.equal(lead.first_email_sent, true);
    assert.equal(lead.email_sent, true);
    assert.ok(lead.first_email_sent_at);
    assert.equal(lead.first_email_resend_id, null, "dry run should not store a Resend id");

    const { data: message, error: messageError } = await supabase
      .from("email_messages")
      .select("id, campaign_key, provider, status, sent_at, tracking_open_url, tracking_click_url, metadata")
      .eq("lead_id", leadId)
      .eq("campaign_key", "first_email")
      .single();
    assert.ifError(messageError);
    assert.equal(message.provider, "dry_run");
    assert.equal(message.status, "sent");
    assert.ok(message.sent_at);
    assert.ok(message.tracking_open_url.includes("/api/email-open"));
    assert.ok(message.tracking_open_url.includes(`lead=${encodeURIComponent(leadId)}`));
    assert.ok(message.tracking_click_url.includes("/api/email-click"));
    assert.ok(message.tracking_click_url.includes(`message=${encodeURIComponent(message.id)}`));
    assert.equal(message.metadata.source, "first_email_sender");
    assert.equal(message.metadata.dryRun, true);

    const { count: sentEventCount, error: eventError } = await supabase
      .from("lead_events")
      .select("*", { count: "exact", head: true })
      .eq("lead_id", leadId)
      .eq("event_type", "EMAIL_SENT");
    assert.ifError(eventError);
    assert.equal(sentEventCount, 1);

    const secondSend = await call(sendReadyLeadEmails, { method: "POST", body: { leadId } });
    assert.equal(secondSend.statusCode, 200);
    assert.equal(secondSend.body.success, true);
    assert.equal(secondSend.body.checked, 0, "sent lead should not be selected again");
    assert.equal(secondSend.body.sent, 0);
  } finally {
    await cleanup(supabase, ids);
  }
});
