const { getSupabaseClient, recordLeadEvent } = require("./_funnel");

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeRedirectUrl(value) {
  const fallback = "/readiness-check.html";
  const raw = cleanText(value);
  if (!raw) return fallback;

  try {
    const parsed = new URL(raw, "https://playboard.local");
    if (parsed.origin === "https://playboard.local") {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return raw;
  } catch (error) {
    return fallback;
  }
}

module.exports = async function handler(req, res) {
  const leadId = cleanText(req.query.lead || req.query.leadId);
  const messageId = cleanText(req.query.message || req.query.messageId);
  const targetUrl = safeRedirectUrl(req.query.url || req.query.redirect);
  const supabase = getSupabaseClient();

  if (supabase && leadId) {
    await recordLeadEvent(supabase, {
      leadId,
      eventType: "EMAIL_CLICKED",
      source: "email_link",
      metadata: { messageId: messageId || null, targetUrl },
      req,
      idempotencyKey: messageId ? `email-click:${messageId}:${targetUrl}` : null
    });

    if (messageId) {
      await supabase
        .from("email_messages")
        .update({ status: "clicked", clicked_at: new Date().toISOString() })
        .eq("id", messageId);
    }
  }

  return res.redirect(302, targetUrl);
};
