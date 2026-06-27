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

function buildFirstEmail({ athleteFirstName, readinessCheckUrl }) {
  const athleteName = athleteFirstName || "your athlete";
  const safeAthleteName = escapeHtml(athleteName);
  const safeReadinessCheckUrl = escapeHtml(readinessCheckUrl);

  const text = `Hi,

Thanks for reaching out about PlayBoard for ${athleteName}.

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

- Reviewing film, Hudl, X, academics, and outreach
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
    <div style="font-family: Arial, sans-serif; color: #111111; line-height: 1.5; max-width: 640px; margin: 0 auto;">
      <p>Hi,</p>
      <p>Thanks for reaching out about PlayBoard for ${safeAthleteName}.</p>
      <p>Most families are not short on effort.</p>
      <p>They are short on a clear recruiting plan.</p>
      <p>PlayBoard helps ${safeAthleteName} understand where he stands, build a realistic school-target board, and know what to do next each week.</p>
      <p>But this is not a parent-only process.</p>
      <p>College coaches want to see the athlete take ownership.</p>
      <p>They want to know:</p>
      <ul>
        <li>Can he communicate?</li>
        <li>Can he follow up?</li>
        <li>Can he handle responsibility?</li>
        <li>Does he understand his own recruiting process?</li>
      </ul>
      <p>That is why PlayBoard works directly with ${safeAthleteName}.</p>
      <p>We mentor and guide him through the recruiting process so he knows what to do, why it matters, and what to report back.</p>
      <p>That work may include:</p>
      <ul>
        <li>Reviewing film, Hudl, X, academics, and outreach</li>
        <li>Building a realistic school-target board</li>
        <li>Knowing which coaches to contact</li>
        <li>Preparing better coach emails</li>
        <li>Following up the right way</li>
        <li>Setting weekly recruiting goals</li>
        <li>Tracking progress</li>
        <li>Staying accountable to the plan</li>
      </ul>
      <p>Parents stay informed.</p>
      <p>You will receive weekly email updates on what ${safeAthleteName} worked on, what progress was made, what needs attention, and how you can support him without taking over.</p>
      <p>Most athletes should expect to spend 1 to 5+ hours per week on recruiting.</p>
      <p>Some weeks may be simple: a short check-in, a follow-up, or a profile update.</p>
      <p>Other weeks may take more time: sending coach emails, reviewing film, researching schools, preparing for camps, or responding to coach interest.</p>
      <p>The next step is the Recruiting Readiness Check.</p>
      <p>It gives us enough information to understand where ${safeAthleteName} is right now and what kind of plan he may need.</p>
      <p>You do not need to have every answer.</p>
      <p>If something is missing, that helps us see where the plan needs to start.</p>
      <p>
        <a href="${safeReadinessCheckUrl}" style="display: inline-block; padding: 12px 18px; border-radius: 999px; background: #111111; color: #ffffff; text-decoration: none; font-weight: 700;">
          Complete the Recruiting Readiness Check
        </a>
      </p>
      <p>There are only 4 spots left right now, so families who are ready to move forward should act quickly.</p>
      <p>There is also a 30-day money-back guarantee. If the first month does not give your family a clearer recruiting plan and a better understanding of what needs to happen next, we will refund your first month.</p>
      <p><strong>Recruiting is not a hope. It is a plan.</strong></p>
      <p>— PlayBoard</p>
    </div>
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
          readinessCheckUrl: finalReadinessCheckUrl
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
