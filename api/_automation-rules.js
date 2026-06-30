const { recordLeadEvent, enqueueAutomation, addHours } = require("./_funnel");
const { buildSequenceEmail, buildAiSequenceEmail, createAndSendEmail } = require("./_automation-email");
const { getLeadAiContext, generateLeadSummary } = require("./_ai");

function clean(value) { return typeof value === "string" ? value.trim() : ""; }
function minutesFromNow(minutes) { const date = new Date(); date.setMinutes(date.getMinutes() + minutes); return date.toISOString(); }

async function getLead(supabase, leadId) {
  const { data, error } = await supabase.from("leads").select("id, athlete_first_name, athlete_last_name, parent_email, readiness_check_url, current_state, funnel_stage, lead_score, first_email_sent, first_email_sent_at, readiness_started_at, readiness_completed_at").eq("id", leadId).single();
  if (error) throw new Error(`Lead lookup failed: ${error.message}`);
  return data;
}

async function hasEvent(supabase, leadId, eventTypes) {
  const types = Array.isArray(eventTypes) ? eventTypes : [eventTypes];
  const { count, error } = await supabase.from("lead_events").select("*", { count: "exact", head: true }).eq("lead_id", leadId).in("event_type", types);
  if (error) throw new Error(`Event lookup failed: ${error.message}`);
  return Number(count || 0) > 0;
}

async function hasEmailCampaign(supabase, leadId, campaignKey) {
  const { count, error } = await supabase.from("email_messages").select("*", { count: "exact", head: true }).eq("lead_id", leadId).eq("campaign_key", campaignKey);
  if (error) throw new Error(`Email lookup failed: ${error.message}`);
  return Number(count || 0) > 0;
}

async function sendPreparedEmail({ supabase, lead, email, sequenceKey, req, queueItem, metadata = {} }) {
  const alreadySent = await hasEmailCampaign(supabase, lead.id, sequenceKey);
  if (alreadySent) return { skipped: true, reason: "already_sent" };

  const result = await createAndSendEmail({
    supabase,
    lead,
    email,
    req,
    metadata: { automationQueueId: queueItem.id, ruleKey: queueItem.rule_key, sequenceKey, ...metadata }
  });

  await recordLeadEvent(supabase, {
    leadId: lead.id,
    eventType: "EMAIL_SENT",
    source: "automation",
    metadata: { campaignKey: sequenceKey, emailMessageId: result.emailMessageId, providerMessageId: result.providerMessageId, dryRun: result.dryRun, ...metadata },
    req,
    idempotencyKey: `automation-email-sent:${queueItem.id}:${sequenceKey}`
  });

  return { skipped: false, ...result };
}

async function sendSequenceEmail({ supabase, lead, sequenceKey, req, queueItem }) {
  const email = buildSequenceEmail({ sequenceKey, lead });
  if (!email) throw new Error(`Unknown email sequence: ${sequenceKey}`);
  return sendPreparedEmail({ supabase, lead, email, sequenceKey, req, queueItem });
}

async function sendAiSequenceEmail({ supabase, lead, sequenceKey, req, queueItem }) {
  const { email, summary, generated } = await buildAiSequenceEmail({ supabase, lead, sequenceKey });
  return sendPreparedEmail({
    supabase,
    lead,
    email,
    sequenceKey,
    req,
    queueItem,
    metadata: { aiUsed: Boolean(generated.aiUsed), aiModel: generated.model || summary.model || null, prediction: summary.engagementPrediction?.prediction || null }
  });
}

async function completeAutomation(supabase, queueItem, result) {
  const { error } = await supabase.from("automation_queue").update({ status: "completed", completed_at: new Date().toISOString(), error_message: null }).eq("id", queueItem.id);
  if (error) throw new Error(`Automation completion update failed: ${error.message}`);
  await supabase.from("automation_history").insert({ automation_queue_id: queueItem.id, lead_id: queueItem.lead_id, rule_key: queueItem.rule_key, action_type: result?.actionType || "rule_completed", status: result?.skipped ? "skipped" : "completed", payload: queueItem.payload || {}, result: result || {} });
}

async function failAutomation(supabase, queueItem, error) {
  const attempts = Number(queueItem.attempts || 0) + 1;
  const maxAttempts = Number(queueItem.max_attempts || 3);
  const exhausted = attempts >= maxAttempts;
  await supabase.from("automation_queue").update({ status: exhausted ? "failed" : "pending", attempts, run_after: exhausted ? queueItem.run_after : minutesFromNow(Math.min(60, 5 * attempts)), failed_at: exhausted ? new Date().toISOString() : null, error_message: String(error?.message || error || "Unknown automation error").slice(0, 2000), locked_at: null, locked_by: null }).eq("id", queueItem.id);
  await supabase.from("automation_history").insert({ automation_queue_id: queueItem.id, lead_id: queueItem.lead_id, rule_key: queueItem.rule_key, action_type: "rule_failed", status: exhausted ? "failed" : "retrying", payload: queueItem.payload || {}, result: { attempts, maxAttempts }, error_message: String(error?.message || error || "Unknown automation error").slice(0, 2000) });
}

async function handleFirstEmailUnopened24h({ supabase, queueItem, req }) {
  const lead = await getLead(supabase, queueItem.lead_id);
  if (lead.current_state === "form_completed" || lead.readiness_completed_at) return { skipped: true, reason: "form_completed", actionType: "no_email_needed" };
  const opened = await hasEvent(supabase, lead.id, "EMAIL_OPENED");
  if (opened) {
    await enqueueAutomation(supabase, { leadId: lead.id, ruleKey: "opened_no_click_24h", runAfter: minutesFromNow(1), priority: 60, payload: { sourceRule: queueItem.rule_key }, dedupeKey: `${lead.id}:opened_no_click_24h` });
    return { skipped: true, reason: "email_opened", actionType: "queued_opened_no_click" };
  }
  const result = await sendSequenceEmail({ supabase, lead, sequenceKey: "first_email_unopened_24h", req, queueItem });
  await enqueueAutomation(supabase, { leadId: lead.id, ruleKey: "first_email_unopened_72h", runAfter: addHours(new Date(), 48), priority: 100, payload: { sourceRule: queueItem.rule_key }, dedupeKey: `${lead.id}:first_email_unopened_72h` });
  return { ...result, actionType: "send_email" };
}

async function handleOpenedNoClick24h({ supabase, queueItem, req }) {
  const lead = await getLead(supabase, queueItem.lead_id);
  if (lead.current_state === "form_completed" || lead.readiness_completed_at) return { skipped: true, reason: "form_completed", actionType: "no_email_needed" };
  if (await hasEvent(supabase, lead.id, "EMAIL_CLICKED")) return { skipped: true, reason: "already_clicked", actionType: "no_email_needed" };
  const result = await sendSequenceEmail({ supabase, lead, sequenceKey: "opened_no_click_24h", req, queueItem });
  return { ...result, actionType: "send_email" };
}

async function handleFirstEmailUnopened72h({ supabase, queueItem, req }) {
  const lead = await getLead(supabase, queueItem.lead_id);
  if (lead.current_state === "form_completed" || lead.readiness_completed_at) return { skipped: true, reason: "form_completed", actionType: "no_email_needed" };
  if (await hasEvent(supabase, lead.id, "EMAIL_OPENED")) return { skipped: true, reason: "email_opened", actionType: "no_email_needed" };
  const result = await sendSequenceEmail({ supabase, lead, sequenceKey: "first_email_unopened_24h", req, queueItem });
  return { ...result, actionType: "send_email" };
}

async function handleReadinessAbandoned({ supabase, queueItem, req, sequenceKey }) {
  const lead = await getLead(supabase, queueItem.lead_id);
  if (lead.current_state === "form_completed" || lead.readiness_completed_at) return { skipped: true, reason: "form_completed", actionType: "no_email_needed" };
  const { data: session, error } = await supabase.from("form_sessions").select("id, status, last_activity_at").eq("lead_id", lead.id).eq("form_key", "readiness_check").neq("status", "completed").order("last_activity_at", { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Form session lookup failed: ${error.message}`);
  if (!session) return { skipped: true, reason: "no_active_session", actionType: "no_email_needed" };
  const result = await sendSequenceEmail({ supabase, lead, sequenceKey, req, queueItem });
  return { ...result, actionType: "send_email", formSessionId: session.id };
}

async function handleReadinessFollowup24h({ supabase, queueItem, req }) {
  const lead = await getLead(supabase, queueItem.lead_id);
  if (!lead.readiness_completed_at && lead.current_state !== "form_completed") return { skipped: true, reason: "form_not_completed", actionType: "no_email_needed" };
  const result = await sendSequenceEmail({ supabase, lead, sequenceKey: "readiness_followup_24h", req, queueItem });
  await enqueueAutomation(supabase, { leadId: lead.id, ruleKey: "ai_personalized_followup", runAfter: addHours(new Date(), 24), priority: 70, payload: { sourceRule: queueItem.rule_key }, dedupeKey: `${lead.id}:ai_personalized_followup` });
  return { ...result, actionType: "send_email" };
}

async function handleReviewCompletedReadinessCheck({ supabase, queueItem }) {
  const lead = await getLead(supabase, queueItem.lead_id);
  if (!lead.readiness_completed_at && lead.current_state !== "form_completed") return { skipped: true, reason: "form_not_completed", actionType: "no_review_needed" };
  await recordLeadEvent(supabase, { leadId: lead.id, eventType: "READINESS_REVIEW_QUEUED", source: "automation", metadata: { automationQueueId: queueItem.id, readinessCheckId: queueItem.payload?.readinessCheckId || null }, idempotencyKey: `readiness-review-queued:${queueItem.id}` });
  await enqueueAutomation(supabase, { leadId: lead.id, ruleKey: "generate_ai_lead_summary", runAfter: minutesFromNow(1), priority: 30, payload: { readinessCheckId: queueItem.payload?.readinessCheckId || null }, dedupeKey: `${lead.id}:generate_ai_lead_summary` });
  return { skipped: false, actionType: "queue_manual_review" };
}

async function handleGenerateFirstEmailContext({ supabase, queueItem }) {
  const lead = await getLead(supabase, queueItem.lead_id);
  const { error } = await supabase.from("leads").update({ first_email_status: "ready_to_send", first_email_context_ready_at: new Date().toISOString(), first_email_question_context: "That is the right question to ask. Recruiting gets easier when the athlete has a clear starting point, a realistic board, and a weekly plan to follow.", biggest_question_theme: "recruiting_plan", first_email_ai_used: false, first_email_ai_error: null }).eq("id", lead.id);
  if (error) throw new Error(`First email context update failed: ${error.message}`);
  await enqueueAutomation(supabase, { leadId: lead.id, ruleKey: "send_first_email", runAfter: minutesFromNow(1), priority: 20, payload: { sourceRule: queueItem.rule_key }, dedupeKey: `${lead.id}:send_first_email` });
  return { skipped: false, actionType: "prepared_first_email" };
}

async function handleSendFirstEmail({ supabase, queueItem }) {
  const lead = await getLead(supabase, queueItem.lead_id);
  if (lead.first_email_sent || lead.first_email_sent_at) return { skipped: true, reason: "already_sent", actionType: "no_email_needed" };
  return { skipped: false, actionType: "ready_for_existing_sender" };
}

async function handleGenerateAiLeadSummary({ supabase, queueItem, req }) {
  const context = await getLeadAiContext(supabase, queueItem.lead_id);
  const summary = await generateLeadSummary(context);
  await recordLeadEvent(supabase, { leadId: queueItem.lead_id, eventType: "AI_LEAD_SUMMARY_GENERATED", source: "automation", metadata: { automationQueueId: queueItem.id, aiUsed: Boolean(summary.aiUsed), model: summary.model || null, prediction: summary.engagementPrediction?.prediction || null, summary }, req, idempotencyKey: `ai-summary-generated:${queueItem.id}` });
  return { skipped: false, actionType: "generate_ai_summary", prediction: summary.engagementPrediction?.prediction || null, aiUsed: Boolean(summary.aiUsed) };
}

async function handleAiPersonalizedFollowup({ supabase, queueItem, req }) {
  const lead = await getLead(supabase, queueItem.lead_id);
  const result = await sendAiSequenceEmail({ supabase, lead, sequenceKey: "ai_personalized_followup", req, queueItem });
  await recordLeadEvent(supabase, { leadId: lead.id, eventType: "AI_DYNAMIC_EMAIL_GENERATED", source: "automation", metadata: { automationQueueId: queueItem.id, campaignKey: "ai_personalized_followup", aiUsed: Boolean(result.aiUsed), prediction: result.prediction || null }, req, idempotencyKey: `ai-dynamic-email:${queueItem.id}` });
  return { ...result, actionType: "send_ai_email" };
}

const RULE_HANDLERS = {
  generate_first_email_context: handleGenerateFirstEmailContext,
  send_first_email: handleSendFirstEmail,
  first_email_unopened_24h: handleFirstEmailUnopened24h,
  first_email_unopened_72h: handleFirstEmailUnopened72h,
  opened_no_click_24h: handleOpenedNoClick24h,
  readiness_abandoned_30m: (context) => handleReadinessAbandoned({ ...context, sequenceKey: "readiness_abandoned_30m" }),
  readiness_abandoned_24h: (context) => handleReadinessAbandoned({ ...context, sequenceKey: "readiness_abandoned_24h" }),
  readiness_followup_24h: handleReadinessFollowup24h,
  review_completed_readiness_check: handleReviewCompletedReadinessCheck,
  generate_ai_lead_summary: handleGenerateAiLeadSummary,
  ai_personalized_followup: handleAiPersonalizedFollowup
};

async function runAutomationRule({ supabase, queueItem, req }) {
  const handler = RULE_HANDLERS[queueItem.rule_key];
  if (!handler) return { skipped: true, reason: "unknown_rule", actionType: "unknown_rule" };
  try {
    const result = await handler({ supabase, queueItem, req });
    await completeAutomation(supabase, queueItem, result);
    return result;
  } catch (error) {
    await failAutomation(supabase, queueItem, error);
    throw error;
  }
}

module.exports = { runAutomationRule, RULE_HANDLERS, hasEvent, hasEmailCampaign };
