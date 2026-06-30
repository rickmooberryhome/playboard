function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function scoreBand(score) {
  if (score >= 150) return "sales_ready";
  if (score >= 80) return "very_hot";
  if (score >= 40) return "warm";
  if (score >= 10) return "engaged";
  return "new";
}

function confidenceFromSignals(signalCount) {
  return clamp(Math.round((0.52 + Math.min(signalCount, 7) * 0.06) * 100) / 100, 0.52, 0.94);
}

function inferEngagement({ lead, events = [], sessions = [], emails = [], answers = [] }) {
  const eventTypes = new Set(events.map((event) => event.event_type));
  const leadScore = Number(lead?.lead_score || 0);
  let score = leadScore;
  const reasons = [];

  if (eventTypes.has("EMAIL_OPENED")) {
    score += 10;
    reasons.push("opened at least one email");
  }
  if (eventTypes.has("EMAIL_CLICKED")) {
    score += 20;
    reasons.push("clicked a PlayBoard link");
  }
  if (eventTypes.has("READINESS_FORM_STARTED")) {
    score += 25;
    reasons.push("started the readiness check");
  }
  if (eventTypes.has("READINESS_FORM_SUBMITTED") || lead?.readiness_completed_at) {
    score += 60;
    reasons.push("completed the readiness check");
  }
  if (sessions.some((session) => session.status !== "completed")) {
    score += 15;
    reasons.push("has an unfinished readiness session");
  }
  if (emails.some((email) => email.status === "failed" || email.status === "bounced")) {
    score -= 30;
    reasons.push("has email delivery issues");
  }
  if (answers.length >= 8) {
    score += 15;
    reasons.push("provided meaningful recruiting detail");
  }

  const normalized = clamp(score, 0, 220);
  let prediction = "low";
  if (normalized >= 160) prediction = "very_high";
  else if (normalized >= 100) prediction = "high";
  else if (normalized >= 55) prediction = "medium";

  const recommendedAction = prediction === "very_high" || prediction === "high"
    ? "Prioritize a personal follow-up and move toward the next recruiting action."
    : prediction === "medium"
      ? "Send a value-add reminder that makes the next step feel easy."
      : "Use a simple re-engagement message with one low-friction action.";

  return {
    score: normalized,
    band: scoreBand(normalized),
    prediction,
    confidence: confidenceFromSignals(reasons.length),
    reasons,
    recommendedAction
  };
}

function answerValue(answers, key) {
  return clean((answers || []).find((answer) => answer.field_key === key)?.answer_value);
}

function summarizeLeadDeterministic({ lead, events = [], sessions = [], emails = [], answers = [] }) {
  const athlete = clean(lead?.athlete_first_name) || "This athlete";
  const position = answerValue(answers, "position") || "unknown position";
  const grade = answerValue(answers, "athleteGrade") || "unknown grade";
  const school = answerValue(answers, "highSchool") || "unknown school";
  const concern = answerValue(answers, "biggestConcern") || clean(lead?.biggest_question) || "no specific concern captured yet";
  const engagement = inferEngagement({ lead, events, sessions, emails, answers });
  const eventTypes = new Set(events.map((event) => event.event_type));

  const summary = `${athlete} is a ${grade} ${position} at ${school}. The main recruiting concern is: ${concern}. Engagement is ${engagement.prediction.replace("_", " ")} based on ${engagement.reasons.length ? engagement.reasons.join(", ") : "limited activity so far"}.`;

  const nextBestAction = eventTypes.has("READINESS_FORM_SUBMITTED") || lead?.readiness_completed_at
    ? "Review the readiness check and send a concrete recruiting plan with the first action step."
    : eventTypes.has("READINESS_FORM_STARTED")
      ? "Send a personalized reminder to finish the readiness check."
      : eventTypes.has("EMAIL_CLICKED")
        ? "Send a direct nudge back to the readiness check with one reason it matters."
        : eventTypes.has("EMAIL_OPENED")
          ? "Send a value-add follow-up that explains the first step."
          : "Send a short re-engagement email with a clear call to action.";

  return {
    summary,
    nextBestAction,
    engagementPrediction: engagement,
    missingData: [
      !position ? "position" : null,
      !grade ? "grade" : null,
      !school ? "high school" : null,
      answers.length < 6 ? "recruiting details" : null
    ].filter(Boolean),
    model: "deterministic-v1",
    aiUsed: false
  };
}

function buildDynamicEmailDeterministic({ lead, summary, sequenceKey }) {
  const athlete = clean(lead?.athlete_first_name) || "your athlete";
  const readinessUrl = clean(lead?.readiness_check_url) || "/readiness-check.html";
  const prediction = summary?.engagementPrediction?.prediction || "medium";

  const subject = sequenceKey === "ai_personalized_followup"
    ? prediction === "high" || prediction === "very_high"
      ? `Next step for ${athlete}'s recruiting plan`
      : `A simple next step for ${athlete}`
    : `PlayBoard follow-up for ${athlete}`;

  const body = prediction === "high" || prediction === "very_high"
    ? `Hi,\n\nBased on what we have so far, ${athlete} looks ready for a more specific recruiting plan. The next step is turning the readiness information into a clear board, outreach plan, and weekly action list.\n\nRecommended next step: ${summary.nextBestAction}\n\nContinue here:\n${readinessUrl}\n\n- PlayBoard`
    : `Hi,\n\nRecruiting can feel messy when the next step is unclear. For ${athlete}, the goal right now is simple: finish the starting point so we can see what is missing and what should happen first.\n\nRecommended next step: ${summary.nextBestAction}\n\nContinue here:\n${readinessUrl}\n\n- PlayBoard`;

  return {
    subject,
    text: body,
    headline: prediction === "high" || prediction === "very_high" ? "Turn the starting point into a plan." : "One clear next step.",
    bodyHtml: body.split("\n\n").map((paragraph) => `<p style="margin:0 0 14px 0; color:#b5bec8; font-size:16px; line-height:25px;">${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`).join(""),
    actionLabel: "Continue in PlayBoard",
    targetUrl: readinessUrl,
    model: "deterministic-v1",
    aiUsed: false
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function callOpenAIJson({ system, user, fallback }) {
  const apiKey = clean(process.env.OPENAI_API_KEY);
  if (!apiKey || String(process.env.PLAYBOARD_AI_DRY_RUN || "").toLowerCase() === "true") {
    return fallback;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.PLAYBOARD_AI_MODEL || "gpt-4o-mini",
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  if (!response.ok) {
    return { ...fallback, aiError: `OpenAI request failed: ${response.status}` };
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return fallback;

  try {
    return { ...JSON.parse(content), model: process.env.PLAYBOARD_AI_MODEL || "gpt-4o-mini", aiUsed: true };
  } catch (error) {
    return { ...fallback, aiError: "OpenAI returned invalid JSON" };
  }
}

async function generateLeadSummary(context) {
  const fallback = summarizeLeadDeterministic(context);
  return callOpenAIJson({
    fallback,
    system: "You summarize recruiting leads for PlayBoard. Return JSON only with summary, nextBestAction, missingData array, engagementPrediction object, model, aiUsed.",
    user: JSON.stringify({
      lead: context.lead,
      events: context.events,
      sessions: context.sessions,
      emails: context.emails,
      answers: context.answers,
      deterministicSummary: fallback
    })
  });
}

async function generateDynamicEmail(context, sequenceKey = "ai_personalized_followup") {
  const summary = context.summary || summarizeLeadDeterministic(context);
  const fallback = buildDynamicEmailDeterministic({ lead: context.lead, summary, sequenceKey });
  return callOpenAIJson({
    fallback,
    system: "You write concise PlayBoard follow-up emails for football recruiting families. Return JSON only with subject, text, headline, bodyHtml, actionLabel, targetUrl, model, aiUsed.",
    user: JSON.stringify({ lead: context.lead, summary, sequenceKey, fallback })
  });
}

async function getLeadAiContext(supabase, leadId) {
  const [{ data: lead, error: leadError }, { data: events, error: eventsError }, { data: sessions, error: sessionsError }, { data: emails, error: emailsError }, { data: answers, error: answersError }] = await Promise.all([
    supabase.from("leads").select("*").eq("id", leadId).single(),
    supabase.from("lead_events").select("event_type, event_source, event_metadata, score_delta, occurred_at").eq("lead_id", leadId).order("occurred_at", { ascending: true }),
    supabase.from("form_sessions").select("form_key, status, fields_completed, started_at, completed_at, last_activity_at").eq("lead_id", leadId),
    supabase.from("email_messages").select("campaign_key, status, sent_at, opened_at, clicked_at, bounced_at, failed_at").eq("lead_id", leadId),
    supabase.from("form_answers").select("form_key, field_key, answer_value, answered_at").eq("lead_id", leadId)
  ]);

  for (const error of [leadError, eventsError, sessionsError, emailsError, answersError]) {
    if (error) throw new Error(error.message);
  }

  return { lead, events: events || [], sessions: sessions || [], emails: emails || [], answers: answers || [] };
}

module.exports = {
  inferEngagement,
  summarizeLeadDeterministic,
  buildDynamicEmailDeterministic,
  generateLeadSummary,
  generateDynamicEmail,
  getLeadAiContext,
  escapeHtml
};
