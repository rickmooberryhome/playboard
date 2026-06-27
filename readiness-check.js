const readinessForm = document.querySelector("[data-readiness-form]");
const readinessResult = document.querySelector("[data-readiness-result]");
const leadIdField = document.querySelector("[data-lead-id]");

const params = new URLSearchParams(window.location.search);
const leadId = params.get("lead") || "";

if (leadIdField) {
  leadIdField.value = leadId;
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

    if (!readinessForm.reportValidity()) {
      return;
    }

    const submitButton = readinessForm.querySelector('button[type="submit"]');
    const data = new FormData(readinessForm);

    const payload = {
      leadId: String(data.get("leadId") || "").trim(),
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
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.message || "Something went wrong.");
      }

      readinessResult.textContent =
        result.message ||
        "Got it. We have the readiness check. We will review the information and follow up with the next step.";

      readinessForm.reset();
      if (leadIdField) {
        leadIdField.value = leadId;
      }
    } catch (error) {
      readinessResult.textContent =
        error.message ||
        "Something went wrong saving the readiness check. Please try again.";
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Submit Readiness Check";
      }
    }
  });
}
