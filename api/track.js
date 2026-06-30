const { getSupabaseClient, recordLeadEvent } = require("./_funnel");

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value);
}

async function upsertFormSession(supabase, { leadId, formKey, sessionId, status, currentField, metadata = {} }) {
  if (!sessionId) return null;

  const payload = {
    lead_id: leadId,
    form_key: formKey,
    session_id: sessionId,
    status,
    current_field: currentField || null,
    metadata,
    last_activity_at: new Date().toISOString()
  };

  if (status === "started") payload.started_at = new Date().toISOString();

  const { data: existing } = await supabase
    .from("form_sessions")
    .select("id")
    .eq("lead_id", leadId)
    .eq("form_key", formKey)
    .eq("session_id", sessionId)
    .maybeSingle();

  if (existing?.id) {
    const { data } = await supabase.from("form_sessions").update(payload).eq("id", existing.id).select("id").single();
    return data;
  }

  const { data } = await supabase.from("form_sessions").insert(payload).select("id").single();
  return data;
}

async function saveQuestionAnswer(supabase, { leadId, formKey, sessionId, fieldKey, answerValue }) {
  if (!fieldKey) return;

  const session = await upsertFormSession(supabase, {
    leadId,
    formKey,
    sessionId,
    status: "started",
    currentField: fieldKey
  });

  await supabase.from("form_answers").upsert({
    lead_id: leadId,
    form_session_id: session?.id || null,
    form_key: formKey,
    field_key: fieldKey,
    answer_value: answerValue || null,
    answered_at: new Date().toISOString()
  }, { onConflict: "lead_id,form_key,field_key" });

  const { count } = await supabase
    .from("form_answers")
    .select("id", { count: "exact", head: true })
    .eq("lead_id", leadId)
    .eq("form_key", formKey);

  if (session?.id) {
    await supabase.from("form_sessions").update({ fields_completed: count || 0 }).eq("id", session.id);
  }
}

async function handleFormTracking(supabase, { leadId, eventType, metadata, sessionId }) {
  const formKey = cleanText(metadata.formKey) || "readiness_check";

  if (eventType === "READINESS_FORM_STARTED") {
    await upsertFormSession(supabase, {
      leadId,
      formKey,
      sessionId,
      status: "started",
      currentField: cleanText(metadata.fieldKey),
      metadata
    });

    await supabase.from("leads").update({ readiness_started_at: new Date().toISOString() }).eq("id", leadId).is("readiness_started_at", null);
  }

  if (eventType === "READINESS_QUESTION_ANSWERED") {
    await saveQuestionAnswer(supabase, {
      leadId,
      formKey,
      sessionId,
      fieldKey: cleanText(metadata.fieldKey),
      answerValue: cleanText(metadata.answerValue).slice(0, 500)
    });
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED", message: "Method not allowed" });
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return res.status(500).json({ success: false, code: "SUPABASE_CONFIG_MISSING", message: "Tracking is not configured yet." });
  }

  try {
    const leadId = cleanText(req.body.leadId);
    const eventType = cleanText(req.body.eventType).toUpperCase();
    const sessionId = cleanText(req.body.sessionId);
    const idempotencyKey = cleanText(req.body.idempotencyKey);
    const metadata = req.body.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {};

    if (!leadId || !isUuid(leadId)) {
      return res.status(400).json({ success: false, code: "INVALID_LEAD_ID", message: "A valid lead ID is required." });
    }

    if (!eventType) {
      return res.status(400).json({ success: false, code: "MISSING_EVENT_TYPE", message: "An event type is required." });
    }

    const { error } = await recordLeadEvent(supabase, {
      leadId,
      eventType,
      source: "client",
      metadata,
      req,
      sessionId: sessionId || null,
      idempotencyKey: idempotencyKey || null
    });

    if (error) {
      return res.status(500).json({ success: false, code: "TRACKING_FAILED", message: "Could not save the tracking event." });
    }

    await handleFormTracking(supabase, { leadId, eventType, metadata, sessionId });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Tracking API error:", error);
    return res.status(500).json({ success: false, code: "TRACKING_API_ERROR", message: "Something went wrong." });
  }
};
