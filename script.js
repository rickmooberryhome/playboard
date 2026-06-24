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
    const athleteFirstName = data.get("athleteFirstName") || "";
    const athleteLastName = data.get("athleteLastName") || "";
    const athleteGrade = data.get("athleteGrade") || "Not selected yet";
    const emailAddress = data.get("emailAddress") || "";

    const summary = [
      "PlayBoard Information Request",
      "",
      `Athlete First Name: ${athleteFirstName}`,
      `Athlete Last Name: ${athleteLastName}`,
      `Athlete Grade: ${athleteGrade}`,
      `Email Address: ${emailAddress}`
    ].join("\n");

    formResult.hidden = false;
    formResult.textContent = [
      "Thanks — we have your information request.",
      "",
      "For now, this starter form is ready to connect to Google Sheets.",
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
