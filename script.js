const navToggle = document.querySelector("[data-nav-toggle]");
const nav = document.querySelector("[data-nav]");

if (navToggle && nav) {
  navToggle.addEventListener("click", () => {
    const isOpen = nav.classList.toggle("is-open");
    navToggle.setAttribute("aria-expanded", String(isOpen));
  });

  nav.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      nav.classList.remove("is-open");
      navToggle.setAttribute("aria-expanded", "false");
    });
  });
}

const intakeForm = document.querySelector("[data-intake-form]");
const formResult = document.querySelector("[data-form-result]");

if (intakeForm && formResult) {
  intakeForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!intakeForm.reportValidity()) {
      return;
    }

    const data = new FormData(intakeForm);
    const summary = [
      "PlayBoard Intake Summary",
      "",
      `Athlete: ${data.get("athleteName") || ""}`,
      `Parent Email: ${data.get("parentEmail") || ""}`,
      `Graduation Year: ${data.get("gradYear") || ""}`,
      `Primary Position: ${data.get("position") || ""}`,
      `Film Link: ${data.get("filmLink") || "Not added yet"}`,
      "",
      "First need:",
      data.get("needs") || "Not sure yet."
    ].join("\n");

    formResult.hidden = false;
    formResult.textContent = `${summary}\n\nCopied to clipboard. Next: connect this form to your CRM, email tool, or backend.`;

    try {
      await navigator.clipboard.writeText(summary);
    } catch (error) {
      formResult.textContent = `${summary}\n\nCopy this summary and send it to your PlayBoard intake process.`;
    }
  });
}
