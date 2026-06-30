const form = document.querySelector("[data-analytics-form]");
const statusEl = document.querySelector("[data-analytics-status]");
const funnelList = document.querySelector("[data-funnel-list]");
const campaignTable = document.querySelector("[data-campaign-table]");
const fieldTable = document.querySelector("[data-field-table]");
const dropList = document.querySelector("[data-drop-list]");
const weakFieldList = document.querySelector("[data-weak-field-list]");

function text(value) {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function pct(value) {
  return `${Number(value || 0).toFixed(1)}%`;
}

function setText(selector, value) {
  const el = document.querySelector(selector);
  if (el) el.textContent = text(value);
}

function rowHtml(cells) {
  return `<tr>${cells.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderSummary(summary) {
  for (const [key, value] of Object.entries(summary || {})) {
    setText(`[data-summary="${key}"]`, value);
  }
}

function renderFunnel(funnel) {
  funnelList.innerHTML = (funnel || []).map((stage) => `
    <div class="funnel-item">
      <div>
        <strong>${escapeHtml(stage.label)}</strong>
        <span>${escapeHtml(stage.count)} leads</span>
      </div>
      <div class="funnel-bar" aria-hidden="true"><span style="width:${Math.min(Number(stage.conversionFromLead || 0), 100)}%"></span></div>
      <div class="funnel-rate">
        <strong>${pct(stage.conversionFromPrevious)}</strong>
        <span>from previous</span>
      </div>
    </div>
  `).join("") || `<p>No funnel data yet.</p>`;
}

function renderEmail(email) {
  for (const key of ["openRate", "clickRate", "sent"]) {
    const value = key.endsWith("Rate") ? pct(email?.[key]) : email?.[key];
    setText(`[data-email="${key}"]`, value);
  }

  campaignTable.innerHTML = (email?.campaigns || []).map((campaign) => rowHtml([
    campaign.campaignKey,
    campaign.sent,
    pct(campaign.openRate),
    pct(campaign.clickRate)
  ])).join("") || rowHtml(["No campaigns yet", "—", "—", "—"]);
}

function renderForm(formAnalytics) {
  for (const key of ["completionRate", "abandonmentRate", "avgFieldsCompleted"]) {
    const value = key.endsWith("Rate") ? pct(formAnalytics?.[key]) : formAnalytics?.[key];
    setText(`[data-form="${key}"]`, value);
  }

  fieldTable.innerHTML = (formAnalytics?.fields || []).map((field) => rowHtml([
    field.fieldKey,
    field.answered,
    pct(field.answerRate)
  ])).join("") || rowHtml(["No answers yet", "—", "—"]);
}

function renderDropOff(dropOff) {
  dropList.innerHTML = (dropOff?.biggestStageDrops || []).map((item) => `
    <div class="drop-item">
      <strong>${escapeHtml(item.from)} → ${escapeHtml(item.to)}</strong>
      <span>${escapeHtml(item.lost)} lost · ${pct(item.conversionRate)} conversion</span>
    </div>
  `).join("") || `<p>No stage drop-offs yet.</p>`;

  weakFieldList.innerHTML = (dropOff?.weakestFormFields || []).map((item) => `
    <div class="drop-item">
      <strong>${escapeHtml(item.fieldKey)}</strong>
      <span>${escapeHtml(item.answered)} answered · ${pct(item.answerRate)}</span>
    </div>
  `).join("") || `<p>No form fields yet.</p>`;
}

function renderAnalytics(analytics) {
  renderSummary(analytics.summary);
  renderFunnel(analytics.funnel);
  renderEmail(analytics.email);
  renderForm(analytics.form);
  renderDropOff(analytics.dropOff);
  statusEl.textContent = `Updated ${new Date(analytics.generatedAt).toLocaleString()} · Last ${analytics.range.days} days`;
}

async function loadAnalytics() {
  const data = new FormData(form);
  const days = data.get("days") || "30";
  const key = data.get("key") || "";
  const url = new URL("/api/analytics", window.location.origin);
  url.searchParams.set("days", days);
  if (key) url.searchParams.set("key", key);

  statusEl.textContent = "Loading analytics...";

  const response = await fetch(url);
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.message || result.code || "Analytics failed.");
  }

  renderAnalytics(result.analytics);
}

if (form) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await loadAnalytics();
    } catch (error) {
      statusEl.textContent = error.message || "Could not load analytics.";
    }
  });

  loadAnalytics().catch((error) => {
    statusEl.textContent = error.message || "Could not load analytics.";
  });
}
