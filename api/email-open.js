const { getSupabaseClient, recordLeadEvent } = require("./_funnel");

const PIXEL = Buffer.from("R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");

  const leadId = cleanText(req.query.lead || req.query.leadId);
  const messageId = cleanText(req.query.message || req.query.messageId);
  const supabase = getSupabaseClient();

  if (supabase && leadId) {
    await recordLeadEvent(supabase, {
      leadId,
      eventType: "EMAIL_OPENED",
      source: "email_pixel",
      metadata: { messageId: messageId || null },
      req,
      idempotencyKey: messageId ? `email-open:${messageId}` : null
    });

    if (messageId) {
      await supabase
        .from("email_messages")
        .update({ status: "opened", opened_at: new Date().toISOString() })
        .eq("id", messageId);
    }
  }

  return res.status(200).send(PIXEL);
};
