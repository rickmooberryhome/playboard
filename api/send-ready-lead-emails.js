const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

const supabaseUrl = normalizeSupabaseUrl(process.env.SUPABASE_URL);
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const resendKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.PLAYBOARD_FROM_EMAIL;
const replyToEmail = process.env.PLAYBOARD_REPLY_TO_EMAIL;
const cronSecret = process.env.CRON_SECRET;
const batchLimit = clampBatchLimit(process.env.PLAYBOARD_SEND_BATCH_LIMIT || 10);

const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
const resend = resendKey ? new Resend(resendKey) : null;

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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isAuthorized(req) {
  if (!cronSecret) return true;
  return req.headers.authorization === `Bearer ${cronSecret}`;
}

function getConfigErrors() {
  const errors = [];

  if (!supabaseUrl) errors.push("SUPABASE_URL is missing or invalid.");
  if (!supabaseKey) errors.push("SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY is missing.");
  if (!resend) errors.push("RESEND_API_KEY is missing.");
  if (!fromEmail) errors.push("PLAYBOARD_FROM_EMAIL is missing.");

  return errors;
}

function buildQuestionBlock(lead) {
  const question = clean(lead.biggest_question);
  const context = clean(lead.first_email_question_context);

  if (question && context) {
    return `You mentioned this question:\n\n"${question}"\n\n${context}`;
  }

  if (context) return context;

  if (question) {
    return "That is the right kind of question to ask. Recruiting gets hard when families are trying to make decisions with partial information. The Readiness Check gives us the starting point so the next step is clearer.";
  }

  return "Even if you are not sure what to ask yet, that is okay. Most families know recruiting matters, but they do not know where to start. The Readiness Check gives us the starting point so we can see what is clear, what is missing, and what needs attention first.";
}

function buildFirstEmail(lead) {
  const athleteName = clean(lead.athlete_first_name) || "your athlete";
  const readinessCheckUrl = clean(lead.readiness_check_url);
  const questionBlock = buildQuestionBlock(lead);

  const text = `Hi,

Thanks for reaching out about PlayBoard for ${athleteName}.

${questionBlock}

Most families are not short on effort.

They are short on a clear recruiting plan.

PlayBoard helps ${athleteName} understand where they stand, build a realistic school-target board, and know what to do next each week.

But this is not a parent-only process.

College coaches want to see the athlete take ownership.

That is why PlayBoard works directly with the athlete.

The next step is the Recruiting Readiness Check.

Complete it here:

${readinessCheckUrl}

Recruiting is not hope. It is a plan.

— PlayBoard`;

  const html = `
    <div style="font-family: Arial, sans-serif; color: #111111; line-height: 1.5; max-width: 640px; margin: 0 auto;">
      <p>Hi,</p>
      <p>Thanks for reaching out about PlayBoard for <strong>${escapeHtml(athleteName)}</strong>.</p>
      <p>${escapeHtml(questionBlock).replace(/\n/g, "<br>")}</p>
      <p><strong>Most families are not short on effort.</strong></p>
      <p>They are short on a clear recruiting plan.</p>
      <p>PlayBoard helps ${escapeHtml(athleteName)} understand where they stand, build a realistic school-target board, and know what to do next each week.</p>
      <p>But this is not a parent-only process.</p>
      <p>College coaches want to see the athlete take ownership.</p>
      <p>That is why PlayBoard works directly with the athlete.</p>
      <p>The next step is the Recruiting Readiness Check.</p>
      <p><a href="${escapeHtml(readinessCheckUrl)}" style="display:inline-block; padding:12px 18px; border-radius:999px; background:#111111; color:#ffffff; text-decoration:none; font-weight:700;">Complete the Recruiting Readiness Check</a></p>
      <p><strong>Recruiting is not hope. It is a plan.</strong></p>
      <p>— PlayBoard</p>
    </div>
  `;

  return {
    subject: "Your next step with PlayBoard",
    text,
    html
  };
}

async function fetchReadyLeads() {
  const { data, error } = await supabase
    .from("leads")
    .select("id, athlete_first_name, parent_email, biggest_question, readiness_check_url, first_email_question_context, first_email_send_attempts")
    .eq("first_email_status", "ready_to_send")
    .or("first_email_sent.is.false,first_email_sent.is.null")
    .order("created_at", { ascending: true })
    .limit(batchLimit);

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

async function markSent(lead, resendId) {
  const { error } = await supabase
    .from("leads")
    .update({
      first_email_status: "sent",
      first_email_sent: true,
      email_sent: true,
      first_email_sent_at: new Date().toISOString(),
      first_email_resend_id: resendId || null,
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

async function sendLead(lead) {
  const email = buildFirstEmail(lead);
  const payload = {
    from: fromEmail,
    to: lead.parent_email,
    subject: email.subject,
    text: email.text,
    html: email.html
  };

  if (replyToEmail) payload.replyTo = replyToEmail;

  const { data, error } = await resend.emails.send(payload);
  if (error) throw new Error(error.message || JSON.stringify(error));
  return data?.id || null;
}

async function runWorkflow() {
  const leads = await fetchReadyLeads();
  const result = { checked: leads.length, sent: 0, failed: 0, skipped: 0 };

  for (const lead of leads) {
    try {
      if (!clean(lead.parent_email)) throw new Error("Missing parent_email.");
      if (!clean(lead.readiness_check_url)) throw new Error("Missing readiness_check_url.");

      const claimed = await claimLead(lead);
      if (!claimed) {
        result.skipped += 1;
        continue;
      }

      const resendId = await sendLead(lead);
      await markSent(lead, resendId);
      result.sent += 1;
    } catch (error) {
      await markFailed(lead, error.message);
      result.failed += 1;
      console.error("Ready lead email failed:", { leadId: lead.id, message: error.message });
    }
  }

  return result;
}

module.exports = async function handler(req, res) {
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
    const result = await runWorkflow();
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error("Ready lead sender failed:", error);
    return res.status(500).json({ success: false, code: "EMAIL_SENDER_FAILED", message: error.message });
  }
};
