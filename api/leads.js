const { createClient } = require("@supabase/supabase-js");
const { recordLeadEvent, enqueueAutomation, scheduleFunnelStageAutomations } = require("./_funnel");

const rawSupabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const configuredSiteUrl = process.env.PLAYBOARD_SITE_URL;

function normalizeSupabaseUrl(value) {
  if (!value) return "";
  try { return new URL(value.trim()).origin; } catch (error) { return ""; }
}

const supabaseUrl = normalizeSupabaseUrl(rawSupabaseUrl);
const supabase = supabaseUrl && supabaseSecretKey ? createClient(supabaseUrl, supabaseSecretKey) : null;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function getBaseUrl(req) {
  const siteUrl = cleanText(configuredSiteUrl);
  if (siteUrl) return siteUrl.replace(/\/$/, "");
  const protocol = req.headers["x-forwarded-proto"] || "https";
  return `${protocol}://${req.headers.host}`;
}

function buildReadinessCheckUrl(req, leadId) {
  return `${getBaseUrl(req)}/readiness-check.html?lead=${encodeURIComponent(leadId)}`;
}

function getDefaultQuestionContext() {
  return "Even if you are not sure what to ask yet, that is okay. Most families know recruiting matters, but they do not know where to start. The Readiness Check gives us the starting point so we can see what is clear, what is missing, and what needs attention first.";
}

function getInitialEmailQueueFields(biggestQuestion) {
  const hasQuestion = Boolean(cleanText(biggestQuestion));
  const now = new Date().toISOString();

  if (hasQuestion) {
    return {
      first_email_status: "pending_ai_context",
      first_email_queued_at: now,
      first_email_context_ready_at: null,
      first_email_question_context: null,
      biggest_question_theme: null,
      first_email_ai_used: false,
      first_email_ai_error: null
    };
  }

  return {
    first_email_status: "ready_to_send",
    first_email_queued_at: now,
    first_email_context_ready_at: now,
    first_email_question_context: getDefaultQuestionContext(),
    biggest_question_theme: "unclear",
    first_email_ai_used: false,
    first_email_ai_error: null
  };
}

async function seedPhaseOneAutomations({ leadId, biggestQuestion, readinessCheckUrl }) {
  const hasQuestion = Boolean(cleanText(biggestQuestion));

  await enqueueAutomation(supabase, {
    leadId,
    ruleKey: hasQuestion ? "generate_first_email_context" : "send_first_email",
    runAfter: new Date().toISOString(),
    priority: 10,
    payload: { biggestQuestion: biggestQuestion || null, readinessCheckUrl },
    dedupeKey: `${leadId}:${hasQuestion ? "generate_first_email_context" : "send_first_email"}`
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED", message: "Method not allowed" });
  }

  if (!rawSupabaseUrl || !supabaseSecretKey) {
    console.error("Missing Supabase environment variables.");
    return res.status(500).json({ success: false, code: "SUPABASE_CONFIG_MISSING", message: "The lead system is not configured yet." });
  }

  if (!supabaseUrl || !supabase) {
    console.error("Invalid Supabase URL.");
    return res.status(500).json({ success: false, code: "SUPABASE_URL_INVALID", message: "The Supabase project URL is invalid." });
  }

  try {
    const athleteFirstName = cleanText(req.body.firstName);
    const athleteLastName = cleanText(req.body.lastName);
    const parentEmail = cleanText(req.body.email || req.body.Email);
    const biggestQuestion = cleanText(req.body.biggestQuestion);

    if (!athleteFirstName || !athleteLastName || !parentEmail) {
      return res.status(400).json({ success: false, code: "MISSING_REQUIRED_FIELDS", message: "Please enter the athlete's first name, last name, and email." });
    }

    if (!isValidEmail(parentEmail)) {
      return res.status(400).json({ success: false, code: "INVALID_EMAIL", message: "Please enter a valid email address." });
    }

    const { data, error } = await supabase
      .from("leads")
      .insert({
        athlete_first_name: athleteFirstName,
        athlete_last_name: athleteLastName,
        parent_email: parentEmail.toLowerCase(),
        biggest_question: biggestQuestion || null,
        source: "landing_page",
        funnel_stage: "lead",
        current_state: "lead_created",
        lead_score: 0,
        user_agent: req.headers["user-agent"] || null,
        referrer: req.headers.referer || null
      })
      .select("id")
      .single();

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({ success: false, code: "SUPABASE_INSERT_FAILED", supabaseCode: error.code || null, message: "Something went wrong saving your request. Please check the Supabase leads table columns." });
    }

    const readinessCheckUrl = buildReadinessCheckUrl(req, data.id);
    const emailQueueFields = getInitialEmailQueueFields(biggestQuestion);

    const { error: updateError } = await supabase
      .from("leads")
      .update({ readiness_check_url: readinessCheckUrl, ...emailQueueFields })
      .eq("id", data.id);

    if (updateError) console.error("Lead email queue update error:", updateError);

    await recordLeadEvent(supabase, {
      leadId: data.id,
      eventType: "LEAD_CREATED",
      source: "landing_page",
      metadata: { hasBiggestQuestion: Boolean(biggestQuestion), readinessCheckUrl },
      req,
      idempotencyKey: `lead-created:${data.id}`
    });

    await scheduleFunnelStageAutomations(supabase, {
      leadId: data.id,
      stage: "lead",
      sourceEventType: "LEAD_CREATED"
    });

    await seedPhaseOneAutomations({ leadId: data.id, biggestQuestion, readinessCheckUrl });

    return res.status(200).json({ success: true, leadId: data.id, emailStatus: emailQueueFields.first_email_status, message: "Got it. We have your information. We will email the next step shortly." });
  } catch (error) {
    console.error("Lead API error:", error);
    return res.status(500).json({ success: false, code: "LEAD_API_ERROR", message: "Something went wrong. Please try again." });
  }
};
