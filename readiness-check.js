const readinessForm = document.querySelector("[data-readiness-form]");
const readinessResult = document.querySelector("[data-readiness-result]");
const leadIdField = document.querySelector("[data-lead-id]");

const params = new URLSearchParams(window.location.search);
const leadId = params.get("lead") || "";
const formSessionId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
let readinessStarted = false;
const answeredFields = new Set();

if (leadIdField) leadIdField.value = leadId;

function trackReadinessEvent(eventType, metadata = {}, dedupeSuffix = "") {
  if (!leadId) return;

  const payload = {
    leadId,
    eventType,
    sessionId: formSessionId,
    idempotencyKey: dedupeSuffix ? `${leadId}:${eventType}:${dedupeSuffix}` : undefined,
    metadata: {
      formKey: "readiness_check",
      page: "readiness-check",
      ...metadata
    }
  };

  const body = JSON.stringify(payload);

  if (navigator.sendBeacon) {
    navigator.sendBeacon("/api/track", new Blob([body], { type: "application/json" }));
    return;
  }

  fetch("/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true
  }).catch(() => {});
}

function markReadinessStarted(fieldName = "") {
  if (readinessStarted || !leadId) return;
  readinessStarted = true;
  trackReadinessEvent("READINESS_FORM_STARTED", { fieldKey: fieldName || null, queueAbandonmentRecovery: true }, formSessionId);
}

if (readinessForm) {
  readinessForm.addEventListener("focusin", (event) => {
    markReadinessStarted(event.target?.name || "");
  });

  readinessForm.addEventListener("change", (event) => {
    const field = event.target?.name || "";
    if (!field || field === "leadId" || answeredFields.has(field)) return;

    answeredFields.add(field);
    markReadinessStarted(field);

    trackReadinessEvent("READINESS_QUESTION_ANSWERED", {
      fieldKey: field,
      answerValue: String(event.target?.value || "").trim().slice(0, 500)
    }, `${formSessionId}:${field}`);
  });
}

if (readinessForm && readinessResult && !leadId) {
  readinessResult.hidden = false;
  readinessResult.textContent = "This readiness check link is missing the lead ID. Please use the link from your PlayBoard email or submit the first form again.";
}

if (readinessForm && readinessResult) {
  readinessForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!leadId) {
      readinessResult.hidden = false;
      readinessResult.textContent = "This readiness check link is missing the lead ID. Please use the link from your PlayBoard email or submit the first form again.";
      return;
    }

    if (!readinessForm.reportValidity()) return;

    markReadinessStarted("submit");

    const submitButton = readinessForm.querySelector('button[type="submit"]');
    const data = new FormData(readinessForm);

    const payload = {
      leadId: String(data.get("leadId") || "").trim(),
      formSessionId,
      athleteGrade: String(data.get("athleteGrade") || "").trim(),
      highSchool: String(data.get("highSchool") || "").trim(),
      position: String(data.get("position") || "").trim(),
      height: String(data.get("height") || "").trim(),
      weight: String(data.get("weight") || "").trim(),
      hudlLink: String(data.get("hudlLink") || "").trim(),
      xAccount: String(data.get("xAccount") || "").trim(),
      gpa: String(data.get("gpa") || "").trim(),
      schoolsOfInterest: String(data.get("schoolsOfInterest") || "").trim(),
      coachOutreachStatus: String(data.get("coachOutreachStatus") || "").trim(),
      campsOrVisits: String(data.get("campsOrVisits") || "").trim(),
      biggestConcern: String(data.get("biggestConcern") || "").trim(),
      additionalContext: String(data.get("additionalContext") || "").trim()
    };

    readinessResult.hidden = false;
    readinessResult.textContent = "Sending your readiness check...";

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Sending...";
    }

    try {
      const response = await fetch("/api/readiness-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || "Something went wrong.");

      readinessResult.textContent = result.message || "Got it. We have the readiness check. We will review the information and follow up with the next step.";
      readinessForm.reset();
      if (leadIdField) leadIdField.value = leadId;
    } catch (error) {
      readinessResult.textContent = error.message || "Something went wrong saving the readiness check. Please try again.";
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Submit Readiness Check";
      }
    }
  });
}
