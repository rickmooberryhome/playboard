const { createClient } = require("@supabase/supabase-js");
const { createAndSendEmail, escapeHtml, buildBaseTemplate } = require("./_automation-email");
const { recordLeadEvent } = require("./_funnel");

const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const cronSecret = process.env.CRON_SECRET;
const batchLimit = clampBatchLimit(process.env.PLAYBOARD_SEND_BATCH_LIMIT || 10);
const dryRun = String(process.env.PLAYBOARD_AUTOMATION_DRY_RUN || "").toLowerCase() === "true";

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

function normalizeSupabaseUrl(value) {
  if (!value) return "";

  try {
    return new URL(String(value).trim()).origin;
  } catch {
    return "";
  }
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

function limitEmailText(value, maxLength = 600) {
  const cleanValue = clean(value).replace(/\s+/g, " ");

  if (cleanValue.length <= maxLength) {
    return cleanValue;
  }

  return `${cleanValue.slice(0, maxLength - 3)}...`;
}

function buildQuestionContext(lead) {
  const question = limitEmailText(lead.biggest_question);

  if (!question) {
    return null;
  }

  const context = limitEmailText(lead.first_email_question_context, 520);

  if (context) {
    return {
      label: "What You Asked",
      quote: question,
      text: context
    };
  }

  return {
    label: "What You Asked",
    quote: question,
    text: "That is the right kind of question to ask. Recruiting gets hard when families are trying to make decisions with partial information. The Readiness Check gives us the starting point so the next step is clearer."
  };
}

function buildQuestionContextText(questionContext) {
  if (!questionContext) {
    return "";
  }

  return `You mentioned this question:\n\n"${questionContext.quote}"\n\n${questionContext.text}`;
}

function buildQuestionContextHtml(questionContext) {
  if (!questionContext) {
    return "";
  }

  const safeLabel = escapeHtml(questionContext.label || "What You Asked");
  const safeText = escapeHtml(questionContext.text);
  const safeQuote = escapeHtml(questionContext.quote);

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#090b0f; border:1px solid rgba(113,246,251,0.28); border-radius:18px; margin:18px 0;">
      <tr>
        <td style="padding:20px;">
          <div style="color:#71f6fb; font-size:11px; line-height:16px; font-weight:900; text-transform:uppercase; letter-spacing:0.14em; margin-bottom:10px;">${safeLabel}</div>
          <p style="margin:0 0 14px 0; color:#ffffff; font-size:17px; line-height:26px; font-weight:800;">&ldquo;${safeQuote}&rdquo;</p>
          <p style="margin:0; color:#b5bec8; font-size:15px; line-height:24px;">${safeText}</p>
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

  const text = `Hi,

Thanks for reaching out about PlayBoard for ${athleteName}.${questionContextTextBlock}

Most families are not short on effort.

They are short on a clear recruiting plan.

PlayBoard helps ${athleteName} understand where he stands, build a realistic school-target board, and know what to do next each week.

But this is not a parent-only process.

College coaches want to see the athlete take ownership.

They want to know:

- Can he communicate?
- Can he follow up?
- Can he handle responsibility?
- Does he understand his own recruiting process?

That is why PlayBoard works directly with ${athleteName}.

We mentor and guide him through the recruiting process so he knows what to do, why it matters, and what to report back.

That work may include:

- Reviewing film, Hudl, social media, academics, and outreach
- Building a realistic school-target board
- Knowing which coaches to contact
- Preparing better coach emails
- Following up the right way
- Setting weekly recruiting goals
- Tracking progress
- Staying accountable to the plan

Parents stay informed.

You will receive weekly email updates on what ${athleteName} worked on, what progress was made, what needs attention, and how you can support him without taking over.

Most athletes should expect to spend 1 to 5+ hours per week on recruiting.

Some weeks may be simple: a short check-in, a follow-up, or a profile update.

Other weeks may take more time: sending coach emails, reviewing film, researching schools, preparing for camps, or responding to coach interest.

The next step is the Recruiting Readiness Check.

It gives us enough information to understand where ${athleteName} is right now and what kind of plan he may need.

You do not need to have every answer.

If something is missing, that helps us see where the plan needs to start.

Complete the Recruiting Readiness Check here:

${readinessCheckUrl}

There are only 4 spots left right now, so families who are ready to move forward should act quickly.

There is also a 30-day money-back guarantee. If the first month does not give your family a clearer recruiting plan and a better understanding of what needs to happen next, we will refund your first month.

Recruiting is not a hope. It is a plan.

- PlayBoard`;

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
      ${bullet("Knowing which coaches to contact")}
      ${bullet("Preparing better coach emails")}
      ${bullet("Following up the right way")}
      ${bullet("Setting weekly recruiting goals")}
      ${bullet("Tracking progress and staying accountable")}
    </table>
    ${paragraph("Parents stay informed.", { color: "#ffffff", bold: true })}
    ${paragraph(`You will receive weekly email updates on what <strong style="color:#ffffff;">${safeAthleteName}</strong> worked on, what progress was made, what needs attention, and how you can support him without taking over.`)}
    ${paragraph("Most athletes should expect to spend 1 to 5+ hours per week on recruiting.", { color: "#ffffff", bold: true })}
    ${paragraph("Some weeks may be simple: a short check-in, a follow-up, or a profile update.")}
    ${paragraph("Other weeks may take more time: sending coach emails, reviewing film, researching schools, preparing for camps, or responding to coach interest.")}
    ${paragraph("The next step is the Recruiting Readiness Check.", { color: "#ffffff", bold: true })}
    ${paragraph(`It gives us enough information to understand where <strong style="color:#ffffff;">${safeAthleteName}</strong> is right now and what kind of plan he may need.`)}
    ${paragraph("You do not need to have every answer. If something is missing, that helps us see where the plan needs to start.")}
    ${paragraph("There are only 4 spots left right now.", { color: "#ffffff", bold: true })}
    ${paragraph("There is also a 30-day money-back guarantee. If the first month does not give your family a clearer recruiting plan and a better understanding of what needs to happen next, we will refund your first month.")}
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
    .select("id, athlete_first_name, parent_email, biggest_question, readiness_check_url, first_email_question_context, first_email_send_attempts")
    .eq("first_email_status", "ready_to_send")
    .or("first_email_sent.is.false,first_email_sent.is.null")
    .order("created_at", { ascending: true })
    .limit(batchLimit);

  if (targetLeadId) {
    query = query.eq("id", targetLeadId);
  }

  const { data, error } = await query;

  if (error) throw new Error(`Ready lead query failed: ${error.message}`);
  return data || [];
}

async function claimLead(lead) {
  const { data, error } = await supabase
    .from("leads")
    .update({
      first_email_status: "sending",
      first_email_error: null,
      first_email_last_attempt_at: new Date().toISOString(),
      first_email_send_attempts: Number(lead.first_email_send_attempts || 0) + 1
    })
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
    .update({
      first_email_status: "sent",
      first_email_sent: true,
      email_sent: true,
      first_email_sent_at: new Date().toISOString(),
      first_email_resend_id: sendResult?.providerMessageId || null,
      first_email_error: null
    })
    .eq("id", lead.id)
    .eq("first_email_status", "sending");

  if (error) throw new Error(`Sent update failed: ${error.message}`);
}

async function markFailed(lead, message) {
  const { error } = await supabase
    .from("leads")
    .update({
      first_email_status: "send_failed",
      first_email_sent: false,
      first_email_error: String(message || "Unknown email send error.").slice(0, 2000),
      first_email_last_attempt_at: new Date().toISOString()
    })
    .eq("id", lead.id);

  if (error) console.error("Failure update failed:", error);
}

async function sendLead(lead, req) {
  const email = buildFirstEmail(lead);
  const result = await createAndSendEmail({
    supabase,
    lead,
    email,
    req,
    metadata: {
      source: "first_email_sender",
      campaignKey: email.campaignKey
    }
  });

  await recordLeadEvent(supabase, {
    leadId: lead.id,
    eventType: "EMAIL_SENT",
    source: "first_email_sender",
    metadata: {
      campaignKey: email.campaignKey,
      emailMessageId: result.emailMessageId,
      providerMessageId: result.providerMessageId,
      dryRun: result.dryRun
    },
    req,
    idempotencyKey: `first-email-sent:${lead.id}`
  });

  return result;
}

async function runWorkflow(req = {}) {
  const targetLeadId = getTargetLeadId(req);
  const leads = await fetchReadyLeads(targetLeadId);
  const result = { checked: leads.length, sent: 0, failed: 0, skipped: 0, targetLeadId: targetLeadId || null };

  for (const lead of leads) {
    try {
      if (!clean(lead.parent_email)) throw new Error("Missing parent_email.");
      if (!clean(lead.readiness_check_url)) throw new Error("Missing readiness_check_url.");

      const claimed = await claimLead(lead);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

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
