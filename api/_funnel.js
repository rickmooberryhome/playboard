const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const rawSupabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const LEAD_STATES = Object.freeze({
  LEAD_CREATED: "lead_created",
  EMAIL_SENT: "email_sent",
  EMAIL_OPENED: "email_opened",
  EMAIL_CLICKED: "email_clicked",
  FORM_STARTED: "form_started",
  FORM_ABANDONED: "form_abandoned",
  FORM_COMPLETED: "form_completed",
  AI_PROCESSING: "ai_processing",
  PLAN_DELIVERED: "plan_delivered",
  ACTIVE: "active",
  INACTIVE: "inactive"
});

const EVENT_STATE_MAP = Object.freeze({
  LEAD_CREATED: LEAD_STATES.LEAD_CREATED,
  EMAIL_SENT: LEAD_STATES.EMAIL_SENT,
  EMAIL_OPENED: LEAD_STATES.EMAIL_OPENED,
  EMAIL_CLICKED: LEAD_STATES.EMAIL_CLICKED,
  READINESS_FORM_STARTED: LEAD_STATES.FORM_STARTED,
  READINESS_FORM_SUBMITTED: LEAD_STATES.FORM_COMPLETED,
  FORM_ABANDONED: LEAD_STATES.FORM_ABANDONED,
  AI_CONTEXT_STARTED: LEAD_STATES.AI_PROCESSING,
  PLAN_DELIVERED: LEAD_STATES.PLAN_DELIVERED
});

const EVENT_SCORE_MAP = Object.freeze({
  LEAD_CREATED: 5,
  EMAIL_SENT: 0,
  EMAIL_DELIVERED: 5,
  EMAIL_OPENED: 10,
  EMAIL_CLICKED: 25,
  READINESS_FORM_VIEWED: 10,
  READINESS_FORM_STARTED: 40,
  READINESS_QUESTION_ANSWERED: 2,
  READINESS_FORM_SUBMITTED: 80,
  EMAIL_REPLY_RECEIVED: 100,
  CALL_BOOKED: 150,
  UNSUBSCRIBED: -100,
  EMAIL_BOUNCED: -50
});

function normalizeSupabaseUrl(value) {
  if (!value) return "";
  try {
    return new URL(String(value).trim()).origin;
  } catch (error) {
    return "";
  }
}

function getSupabaseClient() {
  const supabaseUrl = normalizeSupabaseUrl(rawSupabaseUrl);
  if (!supabaseUrl || !supabaseSecretKey) return null;
  return createClient(supabaseUrl, supabaseSecretKey);
}

function getClientIp(req) {
  const forwardedFor = req?.headers?.["x-forwarded-for"];
  if (typeof forwardedFor === "string" && forwardedFor.length > 0) {
    return forwardedFor.split(",")[0].trim();
  }
  return req?.socket?.remoteAddress || "";
}

function hashValue(value) {
  if (!value) return null;
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function getRequestContext(req) {
  return {
    user_agent: req?.headers?.["user-agent"] || null,
    referrer: req?.headers?.referer || req?.headers?.referrer || null,
    ip_hash: hashValue(getClientIp(req))
  };
}

async function recordLeadEvent(supabase, options) {
  const {
    leadId,
    eventType,
    source = "server",
    metadata = {},
    req = null,
    idempotencyKey = null,
    sessionId = null,
    occurredAt = null
  } = options || {};

  if (!supabase || !leadId || !eventType) {
    return { data: null, error: null, skipped: true };
  }

  const scoreDelta = EVENT_SCORE_MAP[eventType] || 0;
  const eventPayload = {
    lead_id: leadId,
    event_type: eventType,
    event_source: source,
    event_metadata: metadata || {},
    score_delta: scoreDelta,
    session_id: sessionId || null,
    idempotency_key: idempotencyKey || null,
    occurred_at: occurredAt || new Date().toISOString(),
    ...getRequestContext(req)
  };

  const { data, error } = await supabase
    .from("lead_events")
    .insert(eventPayload)
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return { data: null, error: null, duplicate: true };
    console.error("Lead event insert failed:", error);
    return { data: null, error };
  }

  await updateLeadRollup(supabase, leadId, {
    scoreDelta,
    nextState: EVENT_STATE_MAP[eventType] || null,
    lastEventType: eventType
  });

  return { data, error: null };
}

async function updateLeadRollup(supabase, leadId, { scoreDelta = 0, nextState = null, lastEventType = null } = {}) {
  if (!supabase || !leadId) return;

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("lead_score, current_state")
    .eq("id", leadId)
    .single();

  if (leadError) {
    console.error("Lead rollup lookup failed:", leadError);
    return;
  }

  const nextScore = Math.max(0, Number(lead?.lead_score || 0) + Number(scoreDelta || 0));
  const patch = {
    lead_score: nextScore,
    last_event_type: lastEventType,
    last_event_at: new Date().toISOString()
  };

  if (nextState) {
    patch.current_state = nextState;
    patch.funnel_stage = nextState;
  }

  const { error: updateError } = await supabase.from("leads").update(patch).eq("id", leadId);
  if (updateError) console.error("Lead rollup update failed:", updateError);

  const { error: scoreError } = await supabase
    .from("lead_scores")
    .upsert({ lead_id: leadId, score: nextScore, updated_at: new Date().toISOString() }, { onConflict: "lead_id" });

  if (scoreError) console.error("Lead score upsert failed:", scoreError);
}

async function enqueueAutomation(supabase, options) {
  const {
    leadId,
    ruleKey,
    runAfter = new Date().toISOString(),
    payload = {},
    priority = 100,
    dedupeKey = null
  } = options || {};

  if (!supabase || !leadId || !ruleKey) {
    return { data: null, error: null, skipped: true };
  }

  const { data, error } = await supabase
    .from("automation_queue")
    .insert({
      lead_id: leadId,
      rule_key: ruleKey,
      run_after: runAfter,
      payload,
      priority,
      dedupe_key: dedupeKey || `${leadId}:${ruleKey}:${runAfter}`
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return { data: null, error: null, duplicate: true };
    console.error("Automation queue insert failed:", error);
  }

  return { data, error };
}

function addHours(date, hours) {
  const copy = new Date(date);
  copy.setHours(copy.getHours() + hours);
  return copy.toISOString();
}

module.exports = {
  LEAD_STATES,
  getSupabaseClient,
  normalizeSupabaseUrl,
  recordLeadEvent,
  enqueueAutomation,
  addHours
};
