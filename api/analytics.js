const { getSupabaseClient } = require("./_funnel");

const DAY_MS = 24 * 60 * 60 * 1000;

function clean(value) {
  return typeof value === "string" ? value.trim() : "";
}

function number(value) {
  return Number(value || 0);
}

function percent(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function parseDays(req) {
  const raw = Number(req?.query?.days || req?.body?.days || 30);
  if (!Number.isFinite(raw)) return 30;
  return Math.min(Math.max(Math.trunc(raw), 1), 365);
}

function getRange(days) {
  const now = new Date();
  const since = new Date(now.getTime() - days * DAY_MS);
  return { since: since.toISOString(), until: now.toISOString(), days };
}

function requireAnalyticsAccess(req) {
  const key = clean(process.env.PLAYBOARD_ANALYTICS_KEY);
  if (!key) return true;
  const provided = clean(req?.headers?.["x-playboard-analytics-key"] || req?.query?.key || req?.body?.key);
  return provided === key;
}

function uniqueLeadCount(rows, eventType = null) {
  const ids = new Set();
  for (const row of rows || []) {
    if (eventType && row.event_type !== eventType) continue;
    if (row.lead_id) ids.add(row.lead_id);
  }
  return ids.size;
}

function countEvents(rows, eventType) {
  return (rows || []).filter((row) => row.event_type === eventType).length;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows || []) {
    const value = row[key] || "unknown";
    map.set(value, (map.get(value) || 0) + 1);
  }
  return [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

function buildFunnel(eventRows, leadRows) {
  const leadCreated = uniqueLeadCount(eventRows, "LEAD_CREATED") || (leadRows || []).length;
  const emailSent = uniqueLeadCount(eventRows, "EMAIL_SENT") || number((leadRows || []).filter((lead) => lead.first_email_sent || lead.first_email_sent_at).length);
  const emailOpened = uniqueLeadCount(eventRows, "EMAIL_OPENED");
  const emailClicked = uniqueLeadCount(eventRows, "EMAIL_CLICKED");
  const formStarted = uniqueLeadCount(eventRows, "READINESS_FORM_STARTED");
  const formSubmitted = uniqueLeadCount(eventRows, "READINESS_FORM_SUBMITTED") || number((leadRows || []).filter((lead) => lead.readiness_completed_at).length);
  const reviewQueued = uniqueLeadCount(eventRows, "READINESS_REVIEW_QUEUED");

  const stages = [
    { key: "lead_created", label: "Lead Created", count: leadCreated },
    { key: "email_sent", label: "Email Sent", count: emailSent },
    { key: "email_opened", label: "Email Opened", count: emailOpened },
    { key: "email_clicked", label: "Email Clicked", count: emailClicked },
    { key: "form_started", label: "Form Started", count: formStarted },
    { key: "form_submitted", label: "Form Submitted", count: formSubmitted },
    { key: "review_queued", label: "Review Queued", count: reviewQueued }
  ];

  return stages.map((stage, index) => {
    const previous = index === 0 ? stage.count : stages[index - 1].count;
    return {
      ...stage,
      conversionFromPrevious: index === 0 ? 100 : percent(stage.count, previous),
      conversionFromLead: percent(stage.count, leadCreated),
      dropOffFromPrevious: index === 0 ? 0 : Math.max(previous - stage.count, 0)
    };
  });
}

function buildEmailAnalytics(emailRows, eventRows) {
  const total = (emailRows || []).length;
  const sent = emailRows.filter((row) => ["sent", "opened", "clicked"].includes(row.status)).length;
  const opened = emailRows.filter((row) => row.opened_at || row.status === "opened" || row.status === "clicked").length || uniqueLeadCount(eventRows, "EMAIL_OPENED");
  const clicked = emailRows.filter((row) => row.clicked_at || row.status === "clicked").length || uniqueLeadCount(eventRows, "EMAIL_CLICKED");
  const bounced = emailRows.filter((row) => row.bounced_at || row.status === "bounced").length;
  const failed = emailRows.filter((row) => row.failed_at || row.status === "failed").length;

  const byCampaign = new Map();
  for (const row of emailRows || []) {
    const key = row.campaign_key || "unknown";
    const item = byCampaign.get(key) || { campaignKey: key, total: 0, sent: 0, opened: 0, clicked: 0, failed: 0 };
    item.total += 1;
    if (["sent", "opened", "clicked"].includes(row.status)) item.sent += 1;
    if (row.opened_at || row.status === "opened" || row.status === "clicked") item.opened += 1;
    if (row.clicked_at || row.status === "clicked") item.clicked += 1;
    if (row.failed_at || row.status === "failed") item.failed += 1;
    byCampaign.set(key, item);
  }

  const campaigns = [...byCampaign.values()].map((item) => ({
    ...item,
    openRate: percent(item.opened, item.sent || item.total),
    clickRate: percent(item.clicked, item.sent || item.total)
  })).sort((a, b) => b.total - a.total);

  return {
    total,
    sent,
    opened,
    clicked,
    bounced,
    failed,
    openRate: percent(opened, sent || total),
    clickRate: percent(clicked, sent || total),
    campaigns
  };
}

function buildFormAnalytics(sessionRows, answerRows) {
  const started = sessionRows.filter((row) => row.status === "started" || row.started_at).length;
  const completed = sessionRows.filter((row) => row.status === "completed" || row.completed_at).length;
  const active = sessionRows.filter((row) => row.status !== "completed").length;
  const fieldMap = new Map();

  for (const answer of answerRows || []) {
    const key = answer.field_key || "unknown";
    fieldMap.set(key, (fieldMap.get(key) || 0) + 1);
  }

  const fields = [...fieldMap.entries()]
    .map(([fieldKey, answered]) => ({ fieldKey, answered, answerRate: percent(answered, started || completed) }))
    .sort((a, b) => b.answered - a.answered);

  const avgFieldsCompleted = sessionRows.length
    ? Math.round((sessionRows.reduce((sum, row) => sum + number(row.fields_completed), 0) / sessionRows.length) * 10) / 10
    : 0;

  return {
    started,
    completed,
    active,
    completionRate: percent(completed, started || completed),
    abandonmentRate: percent(Math.max(started - completed, 0), started || completed),
    avgFieldsCompleted,
    fields
  };
}

function buildDropOffReport(funnel, sessionRows, answerRows) {
  const stageDrops = [];
  for (let index = 1; index < funnel.length; index += 1) {
    stageDrops.push({
      from: funnel[index - 1].label,
      to: funnel[index].label,
      lost: funnel[index].dropOffFromPrevious,
      conversionRate: funnel[index].conversionFromPrevious
    });
  }

  const sortedFields = buildFormAnalytics(sessionRows, answerRows).fields.sort((a, b) => a.answerRate - b.answerRate);

  return {
    biggestStageDrops: stageDrops.sort((a, b) => b.lost - a.lost).slice(0, 5),
    weakestFormFields: sortedFields.slice(0, 8),
    abandonedSessions: sessionRows.filter((row) => row.status !== "completed").length
  };
}

async function fetchAnalyticsData(supabase, range) {
  const [leads, events, emails, sessions, answers, automation] = await Promise.all([
    supabase.from("leads").select("id, source, current_state, funnel_stage, lead_score, first_email_sent, first_email_sent_at, readiness_started_at, readiness_completed_at, created_at").gte("created_at", range.since),
    supabase.from("lead_events").select("lead_id, event_type, event_source, score_delta, occurred_at").gte("occurred_at", range.since),
    supabase.from("email_messages").select("lead_id, campaign_key, status, sent_at, opened_at, clicked_at, bounced_at, failed_at, created_at").gte("created_at", range.since),
    supabase.from("form_sessions").select("lead_id, form_key, status, fields_completed, started_at, last_activity_at, completed_at, created_at").gte("created_at", range.since),
    supabase.from("form_answers").select("lead_id, form_key, field_key, answered_at").gte("created_at", range.since),
    supabase.from("automation_history").select("lead_id, rule_key, action_type, status, created_at").gte("created_at", range.since)
  ]);

  for (const result of [leads, events, emails, sessions, answers, automation]) {
    if (result.error) throw new Error(result.error.message);
  }

  return {
    leads: leads.data || [],
    events: events.data || [],
    emails: emails.data || [],
    sessions: sessions.data || [],
    answers: answers.data || [],
    automation: automation.data || []
  };
}

function buildAnalytics(range, data) {
  const funnel = buildFunnel(data.events, data.leads);
  const email = buildEmailAnalytics(data.emails, data.events);
  const form = buildFormAnalytics(data.sessions, data.answers);
  const dropOff = buildDropOffReport(funnel, data.sessions, data.answers);

  return {
    generatedAt: new Date().toISOString(),
    range,
    summary: {
      leads: data.leads.length,
      events: data.events.length,
      emails: data.emails.length,
      formSessions: data.sessions.length,
      automations: data.automation.length,
      averageLeadScore: data.leads.length ? Math.round(data.leads.reduce((sum, lead) => sum + number(lead.lead_score), 0) / data.leads.length) : 0
    },
    funnel,
    email,
    form,
    dropOff,
    segmentation: {
      leadStates: groupBy(data.leads, "current_state"),
      leadSources: groupBy(data.leads, "source"),
      automationStatuses: groupBy(data.automation, "status")
    }
  };
}

async function getAnalytics(req) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error("Supabase is not configured.");
  const range = getRange(parseDays(req));
  const data = await fetchAnalyticsData(supabase, range);
  return buildAnalytics(range, data);
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ success: false, code: "METHOD_NOT_ALLOWED" });
  }

  if (!requireAnalyticsAccess(req)) {
    return res.status(401).json({ success: false, code: "UNAUTHORIZED" });
  }

  try {
    const analytics = await getAnalytics(req);
    return res.status(200).json({ success: true, analytics });
  } catch (error) {
    console.error("Analytics API error:", error);
    return res.status(500).json({ success: false, code: "ANALYTICS_FAILED", message: error.message });
  }
};

module.exports.getAnalytics = getAnalytics;
module.exports.buildAnalytics = buildAnalytics;
