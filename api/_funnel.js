const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const rawSupabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const CENTRAL_TIME_ZONE = "America/Chicago";

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
  INACTIVE: "inactive",
  UNCOMMITTED: "uncommitted",
  COMMITTED: "committed"
});

const FUNNEL_STAGES = Object.freeze({
  LEAD: "lead",
  ENGAGED: "engaged",
  OFFERED: "offered",
  COMMITTED: "committed",
  UNCOMMITTED: "uncommitted"
});

const FUNNEL_STAGE_ORDER = Object.freeze({
  [FUNNEL_STAGES.LEAD]: 1,
  [FUNNEL_STAGES.ENGAGED]: 2,
  [FUNNEL_STAGES.OFFERED]: 3,
  [FUNNEL_STAGES.COMMITTED]: 4,
  [FUNNEL_STAGES.UNCOMMITTED]: 99
});

const ACTIVE_FOLLOWUP_STAGES = Object.freeze([
  FUNNEL_STAGES.LEAD,
  FUNNEL_STAGES.ENGAGED,
  FUNNEL_STAGES.OFFERED
]);

const EVENT_STATE_MAP = Object.freeze({
  LEAD_CREATED: LEAD_STATES.LEAD_CREATED,
  EMAIL_SENT: LEAD_STATES.EMAIL_SENT,
  EMAIL_OPENED: LEAD_STATES.EMAIL_OPENED,
  EMAIL_CLICKED: LEAD_STATES.EMAIL_CLICKED,
  READINESS_FORM_STARTED: LEAD_STATES.FORM_STARTED,
  READINESS_FORM_SUBMITTED: LEAD_STATES.FORM_COMPLETED,
  FORM_ABANDONED: LEAD_STATES.FORM_ABANDONED,
  AI_CONTEXT_STARTED: LEAD_STATES.AI_PROCESSING,
  PLAN_DELIVERED: LEAD_STATES.PLAN_DELIVERED,
  PAYMENT_COMPLETED: LEAD_STATES.COMMITTED,
  LEAD_UNCOMMITTED: LEAD_STATES.UNCOMMITTED
});

const EVENT_FUNNEL_STAGE_MAP = Object.freeze({
  LEAD_CREATED: FUNNEL_STAGES.LEAD,
  EMAIL_CLICKED: FUNNEL_STAGES.ENGAGED,
  READINESS_FORM_STARTED: FUNNEL_STAGES.ENGAGED,
  READINESS_FORM_SUBMITTED: FUNNEL_STAGES.OFFERED,
  PAYMENT_COMPLETED: FUNNEL_STAGES.COMMITTED,
  LEAD_UNCOMMITTED: FUNNEL_STAGES.UNCOMMITTED
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
  PAYMENT_COMPLETED: 250,
  LEAD_UNCOMMITTED: 0,
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

  const rollup = await updateLeadRollup(supabase, leadId, {
    scoreDelta,
    nextState: EVENT_STATE_MAP[eventType] || null,
    nextFunnelStage: EVENT_FUNNEL_STAGE_MAP[eventType] || null,
    lastEventType: eventType
  });

  if (rollup?.funnelStageChanged && ACTIVE_FOLLOWUP_STAGES.includes(rollup.funnelStage)) {
    await scheduleFunnelStageAutomations(supabase, {
      leadId,
      stage: rollup.funnelStage,
      baseDate: eventPayload.occurred_at,
      sourceEventType: eventType
    });
  }

  return { data, error: null };
}

function resolveNextFunnelStage(currentStage, nextStage) {
  if (!nextStage) return null;
  if (!currentStage) return nextStage;
  if (currentStage === nextStage) return nextStage;
  if (nextStage === FUNNEL_STAGES.UNCOMMITTED) return currentStage === FUNNEL_STAGES.COMMITTED ? null : nextStage;
  if (currentStage === FUNNEL_STAGES.UNCOMMITTED) return nextStage === FUNNEL_STAGES.COMMITTED ? nextStage : null;
  if (currentStage === FUNNEL_STAGES.COMMITTED) return null;

  const currentOrder = FUNNEL_STAGE_ORDER[currentStage] || 0;
  const nextOrder = FUNNEL_STAGE_ORDER[nextStage] || 0;
  return nextOrder >= currentOrder ? nextStage : null;
}

async function updateLeadRollup(supabase, leadId, { scoreDelta = 0, nextState = null, nextFunnelStage = null, lastEventType = null } = {}) {
  if (!supabase || !leadId) return null;

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("lead_score, current_state, funnel_stage")
    .eq("id", leadId)
    .single();

  if (leadError) {
    console.error("Lead rollup lookup failed:", leadError);
    return null;
  }

  const nextScore = Math.max(0, Number(lead?.lead_score || 0) + Number(scoreDelta || 0));
  const patch = {
    lead_score: nextScore,
    last_event_type: lastEventType,
    last_event_at: new Date().toISOString()
  };

  if (nextState) {
    patch.current_state = nextState;
  }

  const resolvedFunnelStage = resolveNextFunnelStage(lead?.funnel_stage, nextFunnelStage);
  const funnelStageChanged = Boolean(resolvedFunnelStage && resolvedFunnelStage !== lead?.funnel_stage);

  if (resolvedFunnelStage) {
    patch.funnel_stage = resolvedFunnelStage;
  }

  const { error: updateError } = await supabase.from("leads").update(patch).eq("id", leadId);
  if (updateError) console.error("Lead rollup update failed:", updateError);

  const { error: scoreError } = await supabase
    .from("lead_scores")
    .upsert({ lead_id: leadId, score: nextScore, updated_at: new Date().toISOString() }, { onConflict: "lead_id" });

  if (scoreError) console.error("Lead score upsert failed:", scoreError);
  return { funnelStage: resolvedFunnelStage || lead?.funnel_stage || null, funnelStageChanged };
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

async function scheduleFunnelStageAutomations(supabase, { leadId, stage, baseDate = new Date(), sourceEventType = null } = {}) {
  if (!ACTIVE_FOLLOWUP_STAGES.includes(stage)) return;

  for (const day of [1, 3, 5]) {
    await enqueueAutomation(supabase, {
      leadId,
      ruleKey: `${stage}_followup_day_${day}`,
      runAfter: central9amAfterDays(baseDate, day),
      priority: 50 + day,
      payload: { stage, day, sourceEventType },
      dedupeKey: `${leadId}:${stage}:followup:${day}`
    });
  }

  await enqueueAutomation(supabase, {
    leadId,
    ruleKey: `${stage}_mark_uncommitted_day_10`,
    runAfter: central9amAfterDays(baseDate, 10),
    priority: 150,
    payload: { stage, day: 10, sourceEventType },
    dedupeKey: `${leadId}:${stage}:mark_uncommitted:10`
  });
}

function getCentralDateParts(dateInput) {
  const date = new Date(dateInput);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(date);

  const values = {};
  for (const part of parts) {
    if (part.type === "year" || part.type === "month" || part.type === "day") {
      values[part.type] = Number(part.value);
    }
  }

  return values;
}

function addDaysToDateParts(parts, days) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function nthWeekdayOfMonth(year, month, weekday, nth) {
  let count = 0;
  for (let day = 1; day <= 31; day += 1) {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1) break;
    if (date.getUTCDay() === weekday) {
      count += 1;
      if (count === nth) return day;
    }
  }
  return null;
}

function isCentralDaylightDate({ year, month, day }) {
  const secondSundayInMarch = nthWeekdayOfMonth(year, 3, 0, 2);
  const firstSundayInNovember = nthWeekdayOfMonth(year, 11, 0, 1);

  if (month < 3 || month > 11) return false;
  if (month > 3 && month < 11) return true;
  if (month === 3) return day >= secondSundayInMarch;
  if (month === 11) return day < firstSundayInNovember;
  return false;
}

function central9amAfterDays(baseDate, days) {
  const baseParts = getCentralDateParts(baseDate);
  const targetParts = addDaysToDateParts(baseParts, days);
  const centralOffsetHours = isCentralDaylightDate(targetParts) ? 5 : 6;
  return new Date(Date.UTC(targetParts.year, targetParts.month - 1, targetParts.day, 9 + centralOffsetHours, 0, 0)).toISOString();
}

function addHours(date, hours) {
  const copy = new Date(date);
  copy.setHours(copy.getHours() + hours);
  return copy.toISOString();
}

module.exports = {
  LEAD_STATES,
  FUNNEL_STAGES,
  getSupabaseClient,
  normalizeSupabaseUrl,
  recordLeadEvent,
  enqueueAutomation,
  scheduleFunnelStageAutomations,
  central9amAfterDays,
  addHours
};
