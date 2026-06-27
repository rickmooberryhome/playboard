const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

const rawSupabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const resendApiKey = process.env.RESEND_API_KEY;
const playboardFromEmail = process.env.PLAYBOARD_FROM_EMAIL;
const playboardReplyToEmail = process.env.PLAYBOARD_REPLY_TO_EMAIL;
const configuredSiteUrl = process.env.PLAYBOARD_SITE_URL;

function normalizeSupabaseUrl(value) {
  if (!value) {
    return "";
  }

  try {
    const parsedUrl = new URL(value.trim());
    return parsedUrl.origin;
  } catch (error) {
    return "";
  }
}

const supabaseUrl = normalizeSupabaseUrl(rawSupabaseUrl);
const supabase = supabaseUrl && supabaseSecretKey
  ? createClient(supabaseUrl, supabaseSecretKey)
  : null;
const resend = resendApiKey ? new Resend(resendApiKey) : null;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getBaseUrl(req) {
  const siteUrl = cleanText(configuredSiteUrl);

  if (siteUrl) {
    return siteUrl.replace(/\/$/, "");
  }

  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host;

  return `${protocol}://${host}`;
}

function buildReadinessCheckUrl(req, leadId) {
  return `${getBaseUrl(req)}/readiness-check.html?lead=${encodeURIComponent(leadId)}`;
}

function limitEmailText(value, maxLength = 600) {
  const cleanValue = cleanText(value);

  if (cleanValue.length <= maxLength) {
    return cleanValue;
  }

  return `${cleanValue.slice(0, maxLength - 3)}...`;
}

function buildQuestionContext({ athleteName, biggestQuestion }) {
  const question = limitEmailText(biggestQuestion);

  if (!question) {
    return {
      text: `Even if you are not sure what to ask yet, that is okay.

Most families know recruiting matters, but they do not know where to start. The Readiness Check gives us the starting point so we can see what is clear, what is missing, and what needs attention first.`,
      html: `
        <tr>
          <td style="padding:0 28px 8px 28px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#090b0f; border:1px solid rgba(113,246,251,0.28); border-radius:18px;">
              <tr>
                <td style="padding:20px;">
                  <div style="color:#71f6fb; font-size:11px; line-height:16px; font-weight:900; text-transform:uppercase; letter-spacing:0.14em; margin-bottom:10px;">Where To Start</div>
                  <p style="margin:0 0 12px 0; color:#ffffff; font-size:17px; line-height:26px; font-weight:800;">Even if you are not sure what to ask yet, that is okay.</p>
                  <p style="margin:0; color:#b5bec8; font-size:15px; line-height:24px;">Most families know recruiting matters, but they do not know where to start. The Readiness Check gives us the starting point so we can see what is clear, what is missing, and what needs attention first.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      `
    };
  }

  const safeQuestion = escapeHtml(question);
  const safeAthleteName = escapeHtml(athleteName);

  return {
    text: `You mentioned this question:

"${question}"

That is the right kind of question to ask. Recruiting gets hard when families are trying to make decisions with partial information. The Readiness Check gives us the details we need to understand ${athleteName}'s film, academics, outreach, school list, and timing before pointing you toward the next step.`,
    html: `
      <tr>
        <td style="padding:0 28px 8px 28px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#090b0f; border:1px solid rgba(113,246,251,0.28); border-radius:18px;">
            <tr>
              <td style="padding:20px;">
                <div style="color:#71f6fb; font-size:11px; line-height:16px; font-weight:900; text-transform:uppercase; letter-spacing:0.14em; margin-bottom:10px;">What You Shared</div>
                <p style="margin:0 0 14px 0; color:#ffffff; font-size:17px; line-height:26px; font-weight:800;">“${safeQuestion}”</p>
                <p style="margin:0; color:#b5bec8; font-size:15px; line-height:24px;">That is the right kind of question to ask. Recruiting gets hard when families are trying to make decisions with partial information. The Readiness Check gives us the details we need to understand ${safeAthleteName}'s film, academics, outreach, school list, and timing before pointing you toward the next step.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    `
  };
}

function buildFirstEmail({ athleteFirstName, readinessCheckUrl, biggestQuestion }) {
  const athleteName = athleteFirstName || "your athlete";
  const safeAthleteName = escapeHtml(athleteName);
  const safeReadinessCheckUrl = escapeHtml(readinessCheckUrl);
  const questionContext = buildQuestionContext({ athleteName, biggestQuestion });

  const text = `Hi,

Thanks for reaching out about PlayBoard for ${athleteName}.

${questionContext.text}

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

— PlayBoard`;

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

                      ${questionContext.html}

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
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">• Reviewing film, Hudl, social media, academics, and outreach</td></tr>
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">• Building a realistic school-target board</td></tr>
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">• Knowing which coaches to contact</td></tr>
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">• Preparing better coach emails</td></tr>
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">• Following up the right way</td></tr>
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">• Setting weekly recruiting goals</td></tr>
                                  <tr><td style="color:#e6ebf0; font-size:15px; line-height:23px;">• Tracking progress and staying accountable</td></tr>
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
                          <p style="margin:16px 0 0 0; color:#b5bec8; font-size:14px; line-height:22px;">— PlayBoard</p>
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

  return { text, html };
}

async function markFirstEmailResult({ leadId, readinessCheckUrl, emailSent, resendId, errorMessage }) {
  const update = {
    readiness_check_url: readinessCheckUrl,
    first_email_sent: emailSent,
    first_email_sent_at: emailSent ? new Date().toISOString() : null,
    first_email_resend_id: resendId || null,
    first_email_error: errorMessage || null
  };

  const { error } = await supabase
    .from("leads")
    .update(update)
    .eq("id", leadId);

  if (error) {
    console.error("Lead email tracking update error:", error);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      code: "METHOD_NOT_ALLOWED",
      message: "Method not allowed"
    });
  }

  if (!rawSupabaseUrl || !supabaseSecretKey) {
    console.error("Missing Supabase environment variables.");

    return res.status(500).json({
      success: false,
      code: "SUPABASE_CONFIG_MISSING",
      message: "The lead system is not configured yet. Check SUPABASE_URL and SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY in Vercel."
    });
  }

  if (!supabaseUrl || !supabase) {
    console.error("Invalid Supabase URL.");

    return res.status(500).json({
      success: false,
      code: "SUPABASE_URL_INVALID",
      message: "The Supabase project URL is invalid. Use the project URL format: https://YOUR-PROJECT-REF.supabase.co"
    });
  }

  try {
    const athleteFirstName = cleanText(req.body.firstName);
    const athleteLastName = cleanText(req.body.lastName);
    const parentEmail = cleanText(req.body.email || req.body.Email);
    const biggestQuestion = cleanText(req.body.biggestQuestion);

    if (!athleteFirstName || !athleteLastName || !parentEmail) {
      return res.status(400).json({
        success: false,
        code: "MISSING_REQUIRED_FIELDS",
        message: "Please enter the athlete's first name, last name, and email."
      });
    }

    if (!isValidEmail(parentEmail)) {
      return res.status(400).json({
        success: false,
        code: "INVALID_EMAIL",
        message: "Please enter a valid email address."
      });
    }

    const readinessCheckUrl = buildReadinessCheckUrl(req, "PENDING_LEAD_ID");

    const { data, error } = await supabase
      .from("leads")
      .insert({
        athlete_first_name: athleteFirstName,
        athlete_last_name: athleteLastName,
        parent_email: parentEmail.toLowerCase(),
        biggest_question: biggestQuestion || null,
        source: "landing_page",
        funnel_stage: "simple_lead",
        user_agent: req.headers["user-agent"] || null,
        referrer: req.headers.referer || null
      })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase insert error:", error);

      return res.status(500).json({
        success: false,
        code: "SUPABASE_INSERT_FAILED",
        supabaseCode: error.code || null,
        message: error.code === "PGRST125"
          ? "The Supabase URL appears to include an invalid path. In Vercel, SUPABASE_URL should be the project URL only: https://YOUR-PROJECT-REF.supabase.co"
          : "Something went wrong saving your request. Please check the Supabase leads table columns."
      });
    }

    const finalReadinessCheckUrl = readinessCheckUrl.replace("PENDING_LEAD_ID", data.id);
    let emailSent = false;
    let emailResendId = null;
    let emailError = null;

    if (!resend || !playboardFromEmail) {
      emailError = "Missing RESEND_API_KEY or PLAYBOARD_FROM_EMAIL.";
    } else {
      try {
        const email = buildFirstEmail({
          athleteFirstName,
          readinessCheckUrl: finalReadinessCheckUrl,
          biggestQuestion
        });

        const emailPayload = {
          from: playboardFromEmail,
          to: parentEmail.toLowerCase(),
          subject: "Your next step with PlayBoard",
          text: email.text,
          html: email.html
        };

        if (playboardReplyToEmail) {
          emailPayload.replyTo = playboardReplyToEmail;
        }

        const { data: emailData, error: resendError } = await resend.emails.send(emailPayload);

        if (resendError) {
          emailError = resendError.message || JSON.stringify(resendError);
          console.error("Resend email error:", resendError);
        } else {
          emailSent = true;
          emailResendId = emailData?.id || null;
        }
      } catch (error) {
        emailError = error.message || "Unknown Resend email error.";
        console.error("Lead email send error:", error);
      }
    }

    await markFirstEmailResult({
      leadId: data.id,
      readinessCheckUrl: finalReadinessCheckUrl,
      emailSent,
      resendId: emailResendId,
      errorMessage: emailError
    });

    return res.status(200).json({
      success: true,
      leadId: data.id,
      emailSent,
      message: "Got it. We have your information. Check your email for the next step with PlayBoard."
    });
  } catch (error) {
    console.error("Lead API error:", error);

    return res.status(500).json({
      success: false,
      code: "LEAD_API_ERROR",
      message: "Something went wrong. Please try again."
    });
  }
};
