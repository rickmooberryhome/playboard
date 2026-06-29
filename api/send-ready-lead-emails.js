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
    <tr>
      <td style="padding:0 28px 8px 28px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#090b0f; border:1px solid rgba(113,246,251,0.28); border-radius:18px;">
          <tr>
            <td style="padding:20px;">
              <div style="color:#71f6fb; font-size:11px; line-height:16px; font-weight:900; text-transform:uppercase; letter-spacing:0.14em; margin-bottom:10px;">${safeLabel}</div>
              <p style="margin:0 0 14px 0; color:#ffffff; font-size:17px; line-height:26px; font-weight:800;">&ldquo;${safeQuote}&rdquo;</p>
              <p style="margin:0; color:#b5bec8; font-size:15px; line-height:24px;">${safeText}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

function buildFirstEmail(lead) {
  const athleteName = clean(lead.athlete_first_name) || "your athlete";
  const readinessCheckUrl = clean(lead.readiness_check_url);
  const safeAthleteName = escapeHtml(athleteName);
  const safeReadinessCheckUrl = escapeHtml(readinessCheckUrl);
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

  const html = `
    <!doctype html>
    <html>
      <body style="margin:0; padding:0; background:#050505; color:#ffffff; font-family: Arial, Helvetica, sans-serif;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#050505; margin:0; padding:0; width:100%;">
          <tr>
            <td align="center" style="padding:28px 14px;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; max-width:680px; border-collapse:collapse;">
                <tr>
                  <td style="padding:0 0 14px 0;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td align="left" style="vertical-align:middle;">
                          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                              <td style="width:40px; height:40px; border-radius:13px; background:#ee1b9c; color:#ffffff; font-size:13px; font-weight:900; text-align:center; vertical-align:middle; letter-spacing:-0.02em;">PB</td>
                              <td style="padding-left:12px; color:#ffffff; font-size:20px; line-height:24px; font-weight:900; letter-spacing:-0.04em;">PlayBoard</td>
                            </tr>
                          </table>
                        </td>
                        <td align="right" style="vertical-align:middle; color:#71f6fb; font-size:11px; line-height:15px; font-weight:900; text-transform:uppercase; letter-spacing:0.12em;">
                          Recruiting Readiness
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="height:4px; line-height:4px; font-size:4px; background:#71f6fb; border-radius:999px 999px 0 0;">&nbsp;</td>
                </tr>

                <tr>
                  <td style="background:#12161b; border:1px solid rgba(255,255,255,0.14); border-top:0; border-radius:0 0 24px 24px; overflow:hidden;">
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="padding:34px 28px 18px 28px; background:#12161b;">
                          <div style="color:#71f6fb; font-size:11px; line-height:16px; font-weight:900; text-transform:uppercase; letter-spacing:0.14em; margin-bottom:12px;">Next Step</div>
                          <h1 style="margin:0; color:#ffffff; font-size:34px; line-height:36px; font-weight:900; letter-spacing:-0.05em; text-transform:uppercase;">Build the plan.</h1>
                          <p style="margin:16px 0 0 0; color:#e6ebf0; font-size:17px; line-height:26px;">Thanks for reaching out about PlayBoard for <strong style="color:#ffffff;">${safeAthleteName}</strong>.</p>
                        </td>
                      </tr>

                      ${questionContextHtml}

                      <tr>
                        <td style="padding:8px 28px 8px 28px;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#090b0f; border:1px solid rgba(113,246,251,0.28); border-radius:18px;">
                            <tr>
                              <td style="padding:20px 20px 18px 20px;">
                                <p style="margin:0 0 12px 0; color:#ffffff; font-size:18px; line-height:27px; font-weight:800;">Most families are not short on effort.</p>
                                <p style="margin:0; color:#b5bec8; font-size:16px; line-height:25px;">They are short on a clear recruiting plan.</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:14px 28px 0 28px;">
                          <p style="margin:0 0 16px 0; color:#b5bec8; font-size:16px; line-height:25px;">PlayBoard helps <strong style="color:#ffffff;">${safeAthleteName}</strong> understand where he stands, build a realistic school-target board, and know what to do next each week.</p>
                          <p style="margin:0 0 16px 0; color:#b5bec8; font-size:16px; line-height:25px;">But this is not a parent-only process.</p>
                          <p style="margin:0 0 12px 0; color:#ffffff; font-size:17px; line-height:26px; font-weight:800;">College coaches want to see the athlete take ownership.</p>
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:0 28px 8px 28px;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate; border-spacing:0 8px;">
                            <tr>
                              <td style="width:10px; vertical-align:top; padding-top:9px;"><span style="display:block; width:7px; height:7px; border-radius:999px; background:#f7e913;">&nbsp;</span></td>
                              <td style="color:#e6ebf0; font-size:15px; line-height:23px; padding-left:8px;">Can he communicate?</td>
                            </tr>
                            <tr>
                              <td style="width:10px; vertical-align:top; padding-top:9px;"><span style="display:block; width:7px; height:7px; border-radius:999px; background:#f7e913;">&nbsp;</span></td>
                              <td style="color:#e6ebf0; font-size:15px; line-height:23px; padding-left:8px;">Can he follow up?</td>
                            </tr>
                            <tr>
                              <td style="width:10px; vertical-align:top; padding-top:9px;"><span style="display:block; width:7px; height:7px; border-radius:999px; background:#f7e913;">&nbsp;</span></td>
                              <td style="color:#e6ebf0; font-size:15px; line-height:23px; padding-left:8px;">Can he handle responsibility?</td>
                            </tr>
                            <tr>
                              <td style="width:10px; vertical-align:top; padding-top:9px;"><span style="display:block; width:7px; height:7px; border-radius:999px; background:#f7e913;">&nbsp;</span></td>
                              <td style="color:#e6ebf0; font-size:15px; line-height:23px; padding-left:8px;">Does he understand his own recruiting process?</td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:8px 28px 8px 28px;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#171d24; border:1px solid rgba(255,255,255,0.14); border-radius:18px;">
                            <tr>
                              <td style="padding:20px;">
                                <div style="color:#71f6fb; font-size:11px; line-height:16px; font-weight:900; text-transform:uppercase; letter-spacing:0.14em; margin-bottom:10px;">How PlayBoard Works</div>
                                <p style="margin:0 0 14px 0; color:#ffffff; font-size:17px; line-height:26px; font-weight:800;">That is why PlayBoard works directly with ${safeAthleteName}.</p>
                                <p style="margin:0 0 14px 0; color:#b5bec8; font-size:15px; line-height:24px;">We mentor and guide him through the recruiting process so he knows what to do, why it matters, and what to report back.</p>
                                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:separate; border-spacing:0 7px;">
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">&bull; Reviewing film, Hudl, social media, academics, and outreach</td></tr>
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">&bull; Building a realistic school-target board</td></tr>
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">&bull; Knowing which coaches to contact</td></tr>
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">&bull; Preparing better coach emails</td></tr>
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">&bull; Following up the right way</td></tr>
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">&bull; Setting weekly recruiting goals</td></tr>
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">&bull; Tracking progress and staying accountable</td></tr>
                                </table>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:8px 28px 8px 28px;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#090b0f; border:1px solid rgba(247,233,19,0.34); border-radius:18px;">
                            <tr>
                              <td style="padding:20px;">
                                <div style="color:#f7e913; font-size:11px; line-height:16px; font-weight:900; text-transform:uppercase; letter-spacing:0.14em; margin-bottom:10px;">Parent Updates</div>
                                <p style="margin:0; color:#b5bec8; font-size:15px; line-height:24px;">You will receive weekly email updates on what <strong style="color:#ffffff;">${safeAthleteName}</strong> worked on, what progress was made, what needs attention, and how you can support him without taking over.</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:8px 28px 8px 28px;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#171d24; border:1px solid rgba(255,255,255,0.14); border-radius:18px;">
                            <tr>
                              <td style="padding:20px;">
                                <div style="color:#71f6fb; font-size:11px; line-height:16px; font-weight:900; text-transform:uppercase; letter-spacing:0.14em; margin-bottom:10px;">Weekly Work</div>
                                <p style="margin:0 0 12px 0; color:#ffffff; font-size:17px; line-height:26px; font-weight:800;">Most athletes should expect to spend 1 to 5+ hours per week on recruiting.</p>
                                <p style="margin:0 0 12px 0; color:#b5bec8; font-size:15px; line-height:24px;">Some weeks may be simple: a short check-in, a follow-up, or a profile update.</p>
                                <p style="margin:0; color:#b5bec8; font-size:15px; line-height:24px;">Other weeks may take more time: sending coach emails, reviewing film, researching schools, preparing for camps, or responding to coach interest.</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:18px 28px 20px 28px;">
                          <h2 style="margin:0 0 12px 0; color:#ffffff; font-size:24px; line-height:29px; font-weight:900; letter-spacing:-0.04em; text-transform:uppercase;">The next step is the Recruiting Readiness Check.</h2>
                          <p style="margin:0 0 14px 0; color:#b5bec8; font-size:16px; line-height:25px;">It gives us enough information to understand where <strong style="color:#ffffff;">${safeAthleteName}</strong> is right now and what kind of plan he may need.</p>
                          <p style="margin:0 0 22px 0; color:#b5bec8; font-size:16px; line-height:25px;">You do not need to have every answer. If something is missing, that helps us see where the plan needs to start.</p>
                          <table role="presentation" cellspacing="0" cellpadding="0" border="0">
                            <tr>
                              <td style="border-radius:999px; background:#f7e913;">
                                <a href="${safeReadinessCheckUrl}" style="display:inline-block; padding:15px 22px; color:#080808; font-size:13px; line-height:16px; font-weight:900; text-decoration:none; text-transform:uppercase; letter-spacing:0.08em; border-radius:999px;">Complete the Readiness Check</a>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:0 28px 26px 28px;">
                          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#090b0f; border:1px solid rgba(238,27,156,0.35); border-radius:18px;">
                            <tr>
                              <td style="padding:18px 20px;">
                                <p style="margin:0 0 10px 0; color:#ffffff; font-size:15px; line-height:23px; font-weight:800;">There are only 4 spots left right now.</p>
                                <p style="margin:0; color:#b5bec8; font-size:15px; line-height:23px;">There is also a 30-day money-back guarantee. If the first month does not give your family a clearer recruiting plan and a better understanding of what needs to happen next, we will refund your first month.</p>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      <tr>
                        <td style="padding:24px 28px 30px 28px; border-top:1px solid rgba(255,255,255,0.12); background:#090b0f;">
                          <p style="margin:0; color:#ffffff; font-size:20px; line-height:28px; font-weight:900; letter-spacing:-0.03em;">Recruiting is not a hope. <span style="color:#f7e913;">It is a plan.</span></p>
                          <p style="margin:16px 0 0 0; color:#b5bec8; font-size:14px; line-height:22px;">- PlayBoard</p>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="padding:18px 8px 0 8px; color:#7e8792; font-size:12px; line-height:18px; text-align:center;">
                    You received this because you requested information from PlayBoard.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
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
