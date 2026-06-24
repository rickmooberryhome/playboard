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

const intakeSection = document.querySelector("#intake");
const intakeForm = document.querySelector("[data-intake-form]");
const firstIntakeField = intakeForm?.querySelector("input, select, textarea");
const formResult = document.querySelector("[data-form-result]");

document.querySelectorAll("[data-scroll-to-intake]").forEach((cta) => {
  cta.addEventListener("click", (event) => {
    event.preventDefault();

    intakeSection?.scrollIntoView({ behavior: "smooth", block: "start" });

    window.setTimeout(() => {
      firstIntakeField?.focus({ preventScroll: true });
    }, 500);
  });
});

if (intakeForm && formResult) {
  intakeForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!intakeForm.reportValidity()) {
      return;
    }

    const data = new FormData(intakeForm);
    const parentName = data.get("parentName") || "";
    const parentEmail = data.get("parentEmail") || "";
    const athleteName = data.get("athleteName") || "Not added yet";
    const athleteGrade = data.get("athleteGrade") || "Not selected yet";
    const biggestQuestion = data.get("biggestQuestion") || "Not added yet";

    const summary = [
      "PlayBoard Readiness Check Lead",
      "",
      `Parent Name: ${parentName}`,
      `Parent Email: ${parentEmail}`,
      `Athlete Name: ${athleteName}`,
      `Athlete Grade: ${athleteGrade}`,
      "",
      "Biggest Recruiting Question:",
      biggestQuestion
    ].join("\n");

    formResult.hidden = false;
    formResult.textContent = [
      "Thanks — this starter form is ready to connect to Google Sheets.",
      "",
      "For now, here is the intake summary:",
      "",
      summary
    ].join("\n");

    try {
      await navigator.clipboard.writeText(summary);
    } catch (error) {
      // Clipboard access can fail in some browsers. The visible summary is still shown on the page.
    }
  });
}
