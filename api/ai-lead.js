const { getSupabaseClient, recordLeadEvent } = require("./_funnel");
const { getLeadAiContext, generateLeadSummary, generateDynamicEmail } = require("./_ai");

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value);
}

function requireAiAccess(req) {
  const key = clean(process.env.PLAYBOARD_AI_KEY || process.env.PLAYBOARD_ANALYTICS_KEY);
  if (!key) return true;
  const provided = clean(req?.headers?.["x-playboard-ai-key"] || req?.headers?.["x-playboard-analytics-key"] || req?.query?.key || req?.body?.key);
  return provided === key;
}

async function buildAiLeadPayload({ supabase, leadId, req, includeEmail = false, sequenceKey = "ai_personalized_followup" }) {
  const context = await getLeadAiContext(supabase, leadId);
  const summary = await generateLeadSummary(context);
  const dynamicEmail = includeEmail ? await generateDynamicEmail({ ...context, summary }, sequenceKey) : null;

  await recordLeadEvent(supabase, {
    leadId,
    eventType: "AI_LEAD_SUMMARY_GENERATED",
    source: "ai",
    metadata: {
      aiUsed: Boolean(summary.aiUsed),
      model: summary.model || null,
      prediction: summary.engagementPrediction?.prediction || null,
      includeEmail
    },
    req,
    idempotencyKey: `ai-summary:${leadId}:${Date.now()}`
  });

  return { lead: context.lead, summary, dynamicEmail };
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }

  if (!requireAiAccess(req)) {
    return res.status(401).json({ success: false, code: "UNAUTHORIZED" });
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(500).json({ success: false, code: "SUPABASE_CONFIG_MISSING" });
  }

  try {
    const leadId = clean(req.query?.leadId || req.body?.leadId);
    const includeEmail = String(req.query?.includeEmail || req.body?.includeEmail || "false").toLowerCase() === "true";
    const sequenceKey = clean(req.query?.sequenceKey || req.body?.sequenceKey) || "ai_personalized_followup";

    if (!isUuid(leadId)) {
      return res.status(400).json({ success: false, code: "INVALID_LEAD_ID" });
    }

    const payload = await buildAiLeadPayload({ supabase, leadId, req, includeEmail, sequenceKey });
    return res.status(200).json({ success: true, ...payload });
  } catch (error) {
    console.error("AI lead API error:", error);
    return res.status(500).json({ success: false, code: "AI_LEAD_FAILED", message: error.message });
  }
};

module.exports.buildAiLeadPayload = buildAiLeadPayload;
