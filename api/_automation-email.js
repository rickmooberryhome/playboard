const { Resend } = require("resend");
const { generateLeadSummary, generateDynamicEmail, getLeadAiContext } = require("./_ai");

const resendKey = process.env.RESEND_API_KEY;
const fromEmail = process.env.PLAYBOARD_FROM_EMAIL;
const replyToEmail = process.env.PLAYBOARD_REPLY_TO_EMAIL;
const configuredSiteUrl = process.env.PLAYBOARD_SITE_URL;
const dryRun = String(process.env.PLAYBOARD_AUTOMATION_DRY_RUN || "").toLowerCase() === "true";
const resend = resendKey ? new Resend(resendKey) : null;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getBaseUrl(req) {
  const siteUrl = clean(configuredSiteUrl);
  if (siteUrl) return siteUrl.replace(/\/$/, "");
  const protocol = req?.headers?.["x-forwarded-proto"] || "https";
  const host = req?.headers?.host || "playboardfootball.com";
  return `${protocol}://${host}`;
}

function addTrackingToHtml({ html, baseUrl, leadId, messageId, targetUrl }) {
  const openUrl = `${baseUrl}/api/email-open?lead=${encodeURIComponent(leadId)}&message=${encodeURIComponent(messageId)}`;
  const clickUrl = `${baseUrl}/api/email-click?lead=${encodeURIComponent(leadId)}&message=${encodeURIComponent(messageId)}&url=${encodeURIComponent(targetUrl || "/")}`;
  const linkedHtml = html.replace(/\{\{ACTION_URL\}\}/g, escapeHtml(clickUrl));
  return `${linkedHtml}<img src="${escapeHtml(openUrl)}" width="1" height="1" alt="" style="display:none; opacity:0;" />`;
}

function buildBaseTemplate({ eyebrow, headline, bodyHtml, actionLabel, fallbackText, actionUrl }) {
  return `<!doctype html>
<html>
  <body style="margin:0; padding:0; background:#050505; color:#ffffff; font-family:Arial, Helvetica, sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#050505; width:100%;">
      <tr>
        <td align="center" style="padding:28px 14px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; max-width:640px; border-collapse:collapse;">
            <tr><td style="height:4px; line-height:4px; font-size:4px; background:#71f6fb; border-radius:999px 999px 0 0;">&nbsp;</td></tr>
            <tr>
              <td style="background:#12161b; border:1px solid rgba(255,255,255,0.14); border-top:0; border-radius:0 0 24px 24px; padding:30px 28px;">
                <div style="color:#71f6fb; font-size:11px; line-height:16px; font-weight:900; text-transform:uppercase; letter-spacing:0.14em; margin-bottom:12px;">${escapeHtml(eyebrow)}</div>
                <h1 style="margin:0 0 16px 0; color:#ffffff; font-size:32px; line-height:36px; font-weight:900; letter-spacing:-0.05em; text-transform:uppercase;">${escapeHtml(headline)}</h1>
                ${bodyHtml}
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px;"><tr><td style="border-radius:999px; background:#f7e913;"><a href="${actionUrl || "{{ACTION_URL}}"}" style="display:inline-block; padding:15px 22px; color:#080808; font-size:13px; line-height:16px; font-weight:900; text-decoration:none; text-transform:uppercase; letter-spacing:0.08em; border-radius:999px;">${escapeHtml(actionLabel)}</a></td></tr></table>
                <p style="margin:22px 0 0 0; color:#7e8792; font-size:12px; line-height:18px;">${escapeHtml(fallbackText)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function emailFromGenerated({ generated, campaignKey }) {
  return {
    campaignKey,
    subject: generated.subject,
    text: generated.text,
    html: buildBaseTemplate({
      eyebrow: "Personalized Follow-Up",
      headline: generated.headline || "Your next recruiting step.",
      bodyHtml: generated.bodyHtml,
      actionLabel: generated.actionLabel || "Continue in PlayBoard",
      fallbackText: `Direct link: ${generated.targetUrl || "/"}`
    }),
    targetUrl: generated.targetUrl || "/"
  };
}

async function buildAiSequenceEmail({ supabase, lead, sequenceKey }) {
  const context = await getLeadAiContext(supabase, lead.id);
  const summary = await generateLeadSummary(context);
  const generated = await generateDynamicEmail({ ...context, summary }, sequenceKey);
  return { email: emailFromGenerated({ generated, campaignKey: sequenceKey }), summary, generated };
}

function paragraph(value, bold = false) {
  return `<p style="margin:0 0 14px 0; color:${bold ? "#ffffff" : "#b5bec8"}; font-size:16px; line-height:25px; ${bold ? "font-weight:800;" : ""}">${value}</p>`;
}

function buildEmail({ campaignKey, subject, eyebrow, headline, paragraphs, actionLabel, fallbackText, targetUrl }) {
  const bodyHtml = paragraphs.map((item) => paragraph(item.text, item.bold)).join("");
  return {
    campaignKey,
    subject,
    text: paragraphs.map((item) => item.text.replace(/<[^>]+>/g, "")).join("\n\n") + `\n\n${fallbackText}`,
    html: buildBaseTemplate({ eyebrow, headline, bodyHtml, actionLabel, fallbackText }),
    targetUrl
  };
}

function buildStageFollowupEmail({ sequenceKey, lead }) {
  const athleteName = clean(lead.athlete_first_name) || "your athlete";
  const safeAthleteName = escapeHtml(athleteName);
  const readinessUrl = clean(lead.readiness_check_url) || "/readiness-check.html";
  const siteUrl = clean(configuredSiteUrl) || "https://playboardfootball.com";

  const stageEmails = {
    lead_followup_day_1: buildEmail({
      campaignKey: sequenceKey,
      subject: "Next step for the recruiting plan",
      eyebrow: "PlayBoard Follow-Up",
      headline: "Start with the next step.",
      paragraphs: [
        { text: `I wanted to make sure you saw the next step for <strong style="color:#ffffff;">${safeAthleteName}</strong>.` },
        { text: "The Readiness Check gives us the starting point: where things stand, what is missing, and what should happen next." },
        { text: "You do not need perfect answers. Missing information helps us see where the plan needs to begin.", bold: true }
      ],
      actionLabel: "Complete the Readiness Check",
      fallbackText: `Direct link: ${readinessUrl}`,
      targetUrl: readinessUrl
    }),
    lead_followup_day_3: buildEmail({
      campaignKey: sequenceKey,
      subject: "Recruiting needs a starting point",
      eyebrow: "Still Interested?",
      headline: "Do not guess.",
      paragraphs: [
        { text: "Most families are trying to help, but they are working without a clear recruiting baseline." },
        { text: `For <strong style="color:#ffffff;">${safeAthleteName}</strong>, the Readiness Check helps us see the school fit, outreach, film, academics, and next steps.` },
        { text: "Once that is done, we can talk about what kind of plan makes sense.", bold: true }
      ],
      actionLabel: "Finish the Readiness Check",
      fallbackText: `Direct link: ${readinessUrl}`,
      targetUrl: readinessUrl
    }),
    lead_followup_day_5: buildEmail({
      campaignKey: sequenceKey,
      subject: "Should we keep this open?",
      eyebrow: "Last Nudge For Now",
      headline: "Keep moving or pause.",
      paragraphs: [
        { text: `I do not want to keep sending reminders if PlayBoard is not the right fit for <strong style="color:#ffffff;">${safeAthleteName}</strong> right now.` },
        { text: "If you still want help building a recruiting plan, complete the Readiness Check and we will take the next step from there." },
        { text: "If now is not the right time, no problem. We will close the loop for now.", bold: true }
      ],
      actionLabel: "Complete the Check",
      fallbackText: `Direct link: ${readinessUrl}`,
      targetUrl: readinessUrl
    }),
    engaged_followup_day_1: buildEmail({
      campaignKey: sequenceKey,
      subject: "You opened the next step",
      eyebrow: "Readiness Check",
      headline: "Finish the baseline.",
      paragraphs: [
        { text: `Looks like you made it to the Readiness Check for <strong style="color:#ffffff;">${safeAthleteName}</strong>.` },
        { text: "That is the right next step. The answers help us understand what is clear, what is missing, and where recruiting effort should go first." },
        { text: "Write 'not sure' anywhere you need to. That is useful information too.", bold: true }
      ],
      actionLabel: "Continue the Check",
      fallbackText: `Direct link: ${readinessUrl}`,
      targetUrl: readinessUrl
    }),
    engaged_followup_day_3: buildEmail({
      campaignKey: sequenceKey,
      subject: "Finish the recruiting baseline",
      eyebrow: "Still Open",
      headline: "One step left.",
      paragraphs: [
        { text: "The Readiness Check is not about having everything figured out." },
        { text: `It is about seeing where <strong style="color:#ffffff;">${safeAthleteName}</strong> stands right now so the plan is realistic.` },
        { text: "A few honest answers are better than waiting for perfect information.", bold: true }
      ],
      actionLabel: "Finish the Baseline",
      fallbackText: `Direct link: ${readinessUrl}`,
      targetUrl: readinessUrl
    }),
    engaged_followup_day_5: buildEmail({
      campaignKey: sequenceKey,
      subject: "Do you still want us to review this?",
      eyebrow: "Decision Point",
      headline: "Should we keep going?",
      paragraphs: [
        { text: `If you still want PlayBoard to review the starting point for <strong style="color:#ffffff;">${safeAthleteName}</strong>, finish the Readiness Check.` },
        { text: "After that, we can look at what kind of plan makes sense and whether PlayBoard is a fit." },
        { text: "If now is not the right time, we will stop the reminders for this round.", bold: true }
      ],
      actionLabel: "Finish the Check",
      fallbackText: `Direct link: ${readinessUrl}`,
      targetUrl: readinessUrl
    }),
    offered_followup_day_1: buildEmail({
      campaignKey: sequenceKey,
      subject: "We have the readiness check",
      eyebrow: "Readiness Received",
      headline: "The baseline is in.",
      paragraphs: [
        { text: `Thanks for completing the Readiness Check for <strong style="color:#ffffff;">${safeAthleteName}</strong>.` },
        { text: "The next step is turning that starting point into a clear recruiting plan." },
        { text: "We will look at school fit, outreach, film, academics, and the weekly work that needs to happen next.", bold: true }
      ],
      actionLabel: "Back to PlayBoard",
      fallbackText: "You received this because you completed the PlayBoard readiness check.",
      targetUrl: siteUrl
    }),
    offered_followup_day_3: buildEmail({
      campaignKey: sequenceKey,
      subject: "Ready to build the plan?",
      eyebrow: "Next Step",
      headline: "Turn the baseline into action.",
      paragraphs: [
        { text: `The Readiness Check gave us the starting point for <strong style="color:#ffffff;">${safeAthleteName}</strong>.` },
        { text: "The next move is deciding if you want help turning that into weekly recruiting work." },
        { text: "PlayBoard is built for athletes who are ready to take ownership, communicate, follow up, and stay accountable.", bold: true }
      ],
      actionLabel: "Back to PlayBoard",
      fallbackText: "You received this because you completed the PlayBoard readiness check.",
      targetUrl: siteUrl
    }),
    offered_followup_day_5: buildEmail({
      campaignKey: sequenceKey,
      subject: "Should we close this loop?",
      eyebrow: "Final Follow-Up",
      headline: "Keep going or pause.",
      paragraphs: [
        { text: `I do not want to keep chasing if now is not the right time for <strong style="color:#ffffff;">${safeAthleteName}</strong>.` },
        { text: "If you want to keep moving, reply and we can talk through the next step." },
        { text: "If we do not hear back, we will close this out for now and may send future PlayBoard updates later.", bold: true }
      ],
      actionLabel: "Back to PlayBoard",
      fallbackText: "Reply to this email if you want to keep moving.",
      targetUrl: siteUrl
    })
  };

  return stageEmails[sequenceKey] || null;
}

function buildSequenceEmail({ sequenceKey, lead }) {
  const stageEmail = buildStageFollowupEmail({ sequenceKey, lead });
  if (stageEmail) return stageEmail;

  const athleteName = clean(lead.athlete_first_name) || "your athlete";
  const readinessUrl = clean(lead.readiness_check_url) || "/readiness-check.html";
  const safeAthleteName = escapeHtml(athleteName);

  const emails = {
    first_email_unopened_24h: {
      campaignKey: "first_email_unopened_24h",
      subject: "Still want help with the recruiting plan?",
      text: `Hi,\n\nI wanted to make sure you saw the next step for PlayBoard.\n\nThe Recruiting Readiness Check gives us the starting point for ${athleteName}: where he stands, what is missing, and what needs to happen next.\n\nComplete it here:\n\n${readinessUrl}\n\n- PlayBoard`,
      html: buildBaseTemplate({ eyebrow: "Reminder", headline: "Start with the readiness check.", bodyHtml: `<p style="margin:0 0 14px 0; color:#b5bec8; font-size:16px; line-height:25px;">I wanted to make sure you saw the next step for PlayBoard.</p><p style="margin:0; color:#b5bec8; font-size:16px; line-height:25px;">The Recruiting Readiness Check gives us the starting point for <strong style="color:#ffffff;">${safeAthleteName}</strong>: where he stands, what is missing, and what needs to happen next.</p>`, actionLabel: "Complete the Readiness Check", fallbackText: `Direct link: ${readinessUrl}` }),
      targetUrl: readinessUrl
    },
    opened_no_click_24h: {
      campaignKey: "opened_no_click_24h",
      subject: "The plan starts with one clear step",
      text: `Hi,\n\nRecruiting gets easier when the next step is clear.\n\nIf you are still interested in PlayBoard, the Readiness Check is where we start. You do not need every answer. Missing information helps us see where the plan needs to begin.\n\n${readinessUrl}\n\n- PlayBoard`,
      html: buildBaseTemplate({ eyebrow: "Next Step", headline: "One clear starting point.", bodyHtml: `<p style="margin:0 0 14px 0; color:#b5bec8; font-size:16px; line-height:25px;">Recruiting gets easier when the next step is clear.</p><p style="margin:0; color:#b5bec8; font-size:16px; line-height:25px;">If you are still interested in PlayBoard, the Readiness Check is where we start. You do not need every answer. Missing information helps us see where the plan needs to begin.</p>`, actionLabel: "Take the Next Step", fallbackText: `Direct link: ${readinessUrl}` }),
      targetUrl: readinessUrl
    },
    readiness_abandoned_30m: {
      campaignKey: "readiness_abandoned_30m",
      subject: "We saved the starting point",
      text: `Hi,\n\nLooks like you started the Recruiting Readiness Check.\n\nYou do not need perfect answers. If something is missing, write Not sure and keep moving. The goal is to understand the starting point.\n\nFinish here:\n\n${readinessUrl}\n\n- PlayBoard`,
      html: buildBaseTemplate({ eyebrow: "Finish the Check", headline: "Not sure is okay.", bodyHtml: `<p style="margin:0 0 14px 0; color:#b5bec8; font-size:16px; line-height:25px;">Looks like you started the Recruiting Readiness Check.</p><p style="margin:0; color:#b5bec8; font-size:16px; line-height:25px;">You do not need perfect answers. If something is missing, write <strong style="color:#ffffff;">Not sure</strong> and keep moving. The goal is to understand the starting point.</p>`, actionLabel: "Finish the Check", fallbackText: `Direct link: ${readinessUrl}` }),
      targetUrl: readinessUrl
    },
    readiness_abandoned_24h: {
      campaignKey: "readiness_abandoned_24h",
      subject: "Finish building the recruiting baseline",
      text: `Hi,\n\nThe Readiness Check helps us see what ${athleteName} already has and what needs attention first.\n\nA complete baseline helps us build a better plan.\n\nFinish here:\n\n${readinessUrl}\n\n- PlayBoard`,
      html: buildBaseTemplate({ eyebrow: "Recruiting Baseline", headline: "Finish the baseline.", bodyHtml: `<p style="margin:0 0 14px 0; color:#b5bec8; font-size:16px; line-height:25px;">The Readiness Check helps us see what <strong style="color:#ffffff;">${safeAthleteName}</strong> already has and what needs attention first.</p><p style="margin:0; color:#b5bec8; font-size:16px; line-height:25px;">A complete baseline helps us build a better plan.</p>`, actionLabel: "Finish the Baseline", fallbackText: `Direct link: ${readinessUrl}` }),
      targetUrl: readinessUrl
    },
    readiness_followup_24h: {
      campaignKey: "readiness_followup_24h",
      subject: "We have the readiness check",
      text: `Hi,\n\nThanks for completing the Recruiting Readiness Check.\n\nThe next step is reviewing the starting point and turning it into a clear plan. We will look at fit, film, academics, outreach, and what should happen next.\n\n- PlayBoard`,
      html: buildBaseTemplate({ eyebrow: "Received", headline: "The baseline is in.", bodyHtml: `<p style="margin:0 0 14px 0; color:#b5bec8; font-size:16px; line-height:25px;">Thanks for completing the Recruiting Readiness Check.</p><p style="margin:0; color:#b5bec8; font-size:16px; line-height:25px;">The next step is reviewing the starting point and turning it into a clear plan. We will look at fit, film, academics, outreach, and what should happen next.</p>`, actionLabel: "Back to PlayBoard", fallbackText: "You received this because you completed the PlayBoard readiness check.", actionUrl: configuredSiteUrl || "https://playboardfootball.com" }),
      targetUrl: configuredSiteUrl || "https://playboardfootball.com"
    }
  };

  return emails[sequenceKey] || null;
}

async function createAndSendEmail({ supabase, lead, email, req, metadata = {} }) {
  if (!email) throw new Error("Missing email content.");
  if (!clean(lead?.parent_email)) throw new Error("Missing parent email.");

  const baseUrl = getBaseUrl(req);
  const { data: message, error: insertError } = await supabase.from("email_messages").insert({ lead_id: lead.id, campaign_key: email.campaignKey, provider: dryRun ? "dry_run" : "resend", to_email: lead.parent_email, subject: email.subject, status: "queued", metadata }).select("id").single();
  if (insertError) throw new Error(`Email message insert failed: ${insertError.message}`);

  const html = addTrackingToHtml({ html: email.html, baseUrl, leadId: lead.id, messageId: message.id, targetUrl: email.targetUrl });
  const trackingOpenUrl = `${baseUrl}/api/email-open?lead=${encodeURIComponent(lead.id)}&message=${encodeURIComponent(message.id)}`;
  const trackingClickUrl = `${baseUrl}/api/email-click?lead=${encodeURIComponent(lead.id)}&message=${encodeURIComponent(message.id)}&url=${encodeURIComponent(email.targetUrl || "/")}`;

  if (dryRun) {
    await supabase.from("email_messages").update({ status: "sent", sent_at: new Date().toISOString(), tracking_open_url: trackingOpenUrl, tracking_click_url: trackingClickUrl, metadata: { ...metadata, dryRun: true } }).eq("id", message.id);
    return { emailMessageId: message.id, providerMessageId: null, dryRun: true };
  }

  if (!resend) throw new Error("RESEND_API_KEY is missing.");
  if (!fromEmail) throw new Error("PLAYBOARD_FROM_EMAIL is missing.");

  const payload = { from: fromEmail, to: lead.parent_email, subject: email.subject, text: email.text, html };
  if (replyToEmail) payload.replyTo = replyToEmail;

  const { data, error } = await resend.emails.send(payload);
  if (error) throw new Error(error.message || JSON.stringify(error));

  await supabase.from("email_messages").update({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: data?.id || null, tracking_open_url: trackingOpenUrl, tracking_click_url: trackingClickUrl }).eq("id", message.id);
  return { emailMessageId: message.id, providerMessageId: data?.id || null, dryRun: false };
}

module.exports = { buildSequenceEmail, buildAiSequenceEmail, createAndSendEmail, escapeHtml, buildBaseTemplate };
