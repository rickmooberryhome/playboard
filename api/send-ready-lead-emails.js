const { createClient } = require("@supabase/supabase-js");
const { createAndSendEmail, escapeHtml, buildBaseTemplate } = require("./_automation-email");
const { recordLeadEvent } = require("./_funnel");

const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const cronSecret = process.env.CRON_SECRET;
const batchLimit = clampBatchLimit(process.env.PLAYBOARD_SEND_BATCH_LIMIT || 10);
const dryRun = String(process.env.PLAYBOARD_AUTOMATION_DRY_RUN || "").toLowerCase() === "true";
const QUESTION_LEAD_SEND_DELAY_MINUTES = Number(process.env.PLAYBOARD_QUESTION_LEAD_SEND_DELAY_MINUTES || 90);

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function normalizeSupabaseUrl(value) {
  if (!value) return "";
  try { return new URL(String(value).trim()).origin; } catch { return ""; }
}

function clampBatchLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return 10;
  return Math.min(parsed, 50);
}

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isAuthorized(req) {
  if (!cronSecret) return true;
  return clean(req?.headers?.authorization) === `Bearer ${cronSecret}`;
}

function getTargetLeadId(req) {
  return clean(req?.query?.leadId || req?.body?.leadId || req?.query?.testLeadId || req?.body?.testLeadId);
}

function getConfigErrors() {
  const errors = [];
  if (!supabaseUrl) errors.push("SUPABASE_URL is missing or invalid.");
  if (!supabaseKey) errors.push("SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is missing.");
  if (!dryRun) {
    if (!process.env.RESEND_API_KEY) errors.push("RESEND_API_KEY is missing.");
    if (!process.env.PLAYBOARD_FROM_EMAIL) errors.push("PLAYBOARD_FROM_EMAIL is missing.");
  }
  return errors;
}

function limitEmailText(value, maxLength = 900) {
  const cleanValue = clean(value).replace(/\s+/g, " ");
  if (cleanValue.length <= maxLength) return cleanValue;
  return `${cleanValue.slice(0, maxLength - 3)}...`;
}

function hasBiggestQuestion(lead) {
  return Boolean(clean(lead?.biggest_question));
}

function getQuestionLeadEligibility(lead) {
  if (!hasBiggestQuestion(lead)) {
    return { eligible: true, reason: null };
  }

  if (lead.first_email_ai_used !== true) {
    return { eligible: false, reason: "waiting_for_agent_context" };
  }

  if (!clean(lead.first_email_question_context)) {
    return { eligible: false, reason: "missing_question_context" };
  }

  const createdAtMs = new Date(lead.created_at).getTime();
  if (!Number.isFinite(createdAtMs)) {
    return { eligible: false, reason: "missing_created_at" };
  }

  const eligibleAtMs = createdAtMs + QUESTION_LEAD_SEND_DELAY_MINUTES * 60 * 1000;
  if (Date.now() < eligibleAtMs) {
    return { eligible: false, reason: "waiting_for_send_window", eligibleAt: new Date(eligibleAtMs).toISOString() };
  }

  return { eligible: true, reason: null, eligibleAt: new Date(eligibleAtMs).toISOString() };
}

function buildQuestionContext(lead) {
  const question = limitEmailText(lead.biggest_question, 600);
  if (!question) return null;

  const context = limitEmailText(lead.first_email_question_context, 900);
  if (!context) return null;

  return { label: "What You Asked", quote: question, text: context };
}

function buildQuestionContextText(questionContext) {
  if (!questionContext) return "";
  return `You asked:\n\n"${questionContext.quote}"\n\n${questionContext.text}`;
}

function buildQuestionContextHtml(questionContext) {
  if (!questionContext) return "";

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#090b0f; border:1px solid rgba(113,246,251,0.28); border-radius:18px; margin:18px 0;">
      <tr>
        <td style="padding:20px;">
          <div style="color:#71f6fb; font-size:11px; line-height:16px; font-weight:900; text-transform:uppercase; letter-spacing:0.14em; margin-bottom:10px;">${escapeHtml(questionContext.label)}</div>
          <p style="margin:0 0 14px 0; color:#ffffff; font-size:17px; line-height:26px; font-weight:800;">&ldquo;${escapeHtml(questionContext.quote)}&rdquo;</p>
          <p style="margin:0; color:#b5bec8; font-size:15px; line-height:24px;">${escapeHtml(questionContext.text)}</p>
        </td>
      </tr>
    </table>
  `;
}

function paragraph(value, options = {}) {
  const color = options.color || "#b5bec8";
  const weight = options.bold ? "font-weight:800;" : "";
  return `<p style="margin:0 0 14px 0; color:${color}; font-size:16px; line-height:25px; ${weight}">${value}</p>`;
}

function bullet(value) {
  return `<tr><td style="color:#e6ebf0; font-size:15px; line-height:23px; padding:3px 0;">&bull; ${value}</td></tr>`;
}

function buildFirstEmail(lead) {
  const athleteName = clean(lead.athlete_first_name) || "your athlete";
  const readinessCheckUrl = clean(lead.readiness_check_url) || "/readiness-check.html";
  const safeAthleteName = escapeHtml(athleteName);
  const questionContext = buildQuestionContext(lead);
  const questionContextText = buildQuestionContextText(questionContext);
  const questionContextTextBlock = questionContextText ? `\n\n${questionContextText}` : "";
  const questionContextHtml = buildQuestionContextHtml(questionContext);

  const text = `Hi,\n\nThanks for reaching out about PlayBoard for ${athleteName}.${questionContextTextBlock}\n\nMost families are not short on effort. They are short on a clear recruiting plan.\n\nPlayBoard helps ${athleteName} understand where he stands, build a realistic school-target board, and know what to do next each week.\n\nThis is not a parent-only process. College coaches want to see the athlete take ownership.\n\nPlayBoard works directly with ${athleteName} so he knows what to do, why it matters, and what to report back.\n\nThat work may include reviewing film, Hudl, social media, academics, outreach, school targets, coach emails, follow-up, weekly goals, and progress.\n\nParents stay informed with updates on what was worked on, what progress was made, what needs attention, and how to support without taking over.\n\nThe next step is the Recruiting Readiness Check. It gives us enough information to understand where ${athleteName} is right now and what kind of plan he may need.\n\nComplete it here:\n\n${readinessCheckUrl}\n\nRecruiting is not a hope. It is a plan.\n\n- PlayBoard`;

  const bodyHtml = `
    ${paragraph(`Thanks for reaching out about PlayBoard for <strong style="color:#ffffff;">${safeAthleteName}</strong>.`, { color: "#e6ebf0" })}
    ${questionContextHtml}
    ${paragraph("Most families are not short on effort.", { color: "#ffffff", bold: true })}
    ${paragraph("They are short on a clear recruiting plan.")}
    ${paragraph(`PlayBoard helps <strong style="color:#ffffff;">${safeAthleteName}</strong> understand where he stands, build a realistic school-target board, and know what to do next each week.`)}
    ${paragraph("But this is not a parent-only process.")}
    ${paragraph("College coaches want to see the athlete take ownership.", { color: "#ffffff", bold: true })}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse; margin:0 0 18px 0;">
      ${bullet("Can he communicate?")}
      ${bullet("Can he follow up?")}
      ${bullet("Can he handle responsibility?")}
      ${bullet("Does he understand his own recruiting process?")}
    </table>
    ${paragraph(`That is why PlayBoard works directly with <strong style="color:#ffffff;">${safeAthleteName}</strong>.`, { color: "#ffffff", bold: true })}
    ${paragraph("We mentor and guide him through the recruiting process so he knows what to do, why it matters, and what to report back.")}
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#090b0f; border:1px solid rgba(255,255,255,0.14); border-radius:18px; border-collapse:separate; padding:16px; margin:18px 0;">
      ${bullet("Reviewing film, Hudl, social media, academics, and outreach")}
      ${bullet("Building a realistic school-target board")}
      ${bullet("Preparing better coach emails and follow-ups")}
      ${bullet("Setting weekly recruiting goals and staying accountable")}
    </table>
    ${paragraph("Parents stay informed.", { color: "#ffffff", bold: true })}
    ${paragraph(`You will receive updates on what <strong style="color:#ffffff;">${safeAthleteName}</strong> worked on, what progress was made, what needs attention, and how you can support him without taking over.`)}
    ${paragraph("The next step is the Recruiting Readiness Check.", { color: "#ffffff", bold: true })}
    ${paragraph(`It gives us enough information to understand where <strong style="color:#ffffff;">${safeAthleteName}</strong> is right now and what kind of plan he may need.`)}
    ${paragraph("You do not need to have every answer. If something is missing, that helps us see where the plan needs to start.")}
  `;

  return {
    campaignKey: "first_email",
    subject: "Your next step with PlayBoard",
    text,
    html: buildBaseTemplate({
      eyebrow: "Recruiting Readiness",
      headline: "Build the plan.",
      bodyHtml,
      actionLabel: "Complete the Readiness Check",
      fallbackText: `Direct link: ${readinessCheckUrl}`
    }),
    targetUrl: readinessCheckUrl
  };
}

async function fetchReadyLeads(targetLeadId = "") {
  let query = supabase
    .from("leads")
    .select("id, created_at, athlete_first_name, parent_email, biggest_question, readiness_check_url, first_email_question_context, first_email_ai_used, first_email_send_attempts")
    .eq("first_email_status", "ready_to_send")
    .or("first_email_sent.is.false,first_email_sent.is.null")
    .order("created_at", { ascending: true })
    .limit(batchLimit);

  if (targetLeadId) query = query.eq("id", targetLeadId);

  const { data, error } = await query;
  if (error) throw new Error(`Ready lead query failed: ${error.message}`);
  return data || [];
}

async function claimLead(lead) {
  const { data, error } = await supabase
    .from("leads")
    .update({ first_email_status: "sending", first_email_error: null, first_email_last_attempt_at: new Date().toISOString(), first_email_send_attempts: Number(lead.first_email_send_attempts || 0) + 1 })
    .eq("id", lead.id)
    .eq("first_email_status", "ready_to_send")
    .or("first_email_sent.is.false,first_email_sent.is.null")
    .select("id")
    .maybeSingle();

  if (error) throw new Error(`Lead claim failed: ${error.message}`);
  return Boolean(data?.id);
}

async function markSent(lead, sendResult) {
  const { error } = await supabase
    .from("leads")
    .update({ first_email_status: "sent", first_email_sent: true, email_sent: true, first_email_sent_at: new Date().toISOString(), first_email_resend_id: sendResult?.providerMessageId || null, first_email_error: null })
    .eq("id", lead.id)
    .eq("first_email_status", "sending");

  if (error) throw new Error(`Sent update failed: ${error.message}`);
}

async function markFailed(lead, message) {
  const { error } = await supabase
    .from("leads")
    .update({ first_email_status: "send_failed", first_email_sent: false, first_email_error: String(message || "Unknown email send error.").slice(0, 2000), first_email_last_attempt_at: new Date().toISOString() })
    .eq("id", lead.id);

  if (error) console.error("Failure update failed:", error);
}

async function sendLead(lead, req) {
  const email = buildFirstEmail(lead);
  const result = await createAndSendEmail({ supabase, lead, email, req, metadata: { source: "first_email_sender", campaignKey: email.campaignKey } });

  await recordLeadEvent(supabase, {
    leadId: lead.id,
    eventType: "EMAIL_SENT",
    source: "first_email_sender",
    metadata: { campaignKey: email.campaignKey, emailMessageId: result.emailMessageId, providerMessageId: result.providerMessageId, dryRun: result.dryRun },
    req,
    idempotencyKey: `first-email-sent:${lead.id}`
  });

  return result;
}

async function runWorkflow(req = {}) {
  const targetLeadId = getTargetLeadId(req);
  const leads = await fetchReadyLeads(targetLeadId);
  const result = { checked: leads.length, sent: 0, failed: 0, skipped: 0, waitingForContext: 0, waitingForSendWindow: 0, targetLeadId: targetLeadId || null };

  for (const lead of leads) {
    try {
      const eligibility = getQuestionLeadEligibility(lead);
      if (!eligibility.eligible) {
        result.skipped += 1;
        if (eligibility.reason === "waiting_for_send_window") result.waitingForSendWindow += 1;
        else result.waitingForContext += 1;
        continue;
      }

      if (!clean(lead.parent_email)) throw new Error("Missing parent_email.");
      if (!clean(lead.readiness_check_url)) throw new Error("Missing readiness_check_url.");

      const claimed = await claimLead(lead);
      if (!claimed) { result.skipped += 1; continue; }

      const sendResult = await sendLead(lead, req);
      await markSent(lead, sendResult);
      result.sent += 1;
    } catch (error) {
      await markFailed(lead, error.message);
      result.failed += 1;
      console.error("Ready lead email failed:", { leadId: lead.id, message: error.message });
    }
  }

  return result;
}

async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, code: "UNAUTHORIZED" });
  }

  const configErrors = getConfigErrors();
  if (configErrors.length) {
    console.error("Email sender config errors:", configErrors);
    return res.status(500).json({ success: false, code: "EMAIL_SENDER_CONFIG_ERROR", errors: configErrors });
  }

  try {
    const result = await runWorkflow(req);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Ready lead sender failed:", error);
    return res.status(500).json({ success: false, code: "EMAIL_SENDER_FAILED", message: error.message });
  }
}

module.exports = handler;
module.exports.runWorkflow = runWorkflow;
module.exports.fetchReadyLeads = fetchReadyLeads;
module.exports.buildFirstEmail = buildFirstEmail;
module.exports.isAuthorized = isAuthorized;
module.exports.getQuestionLeadEligibility = getQuestionLeadEligibility;
