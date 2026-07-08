function ensureSiteLink(container, href, label, beforeSelector = "") {
  if (!container || container.querySelector(`a[href="${href}"]`)) {
    return;
  }

  const link = document.createElement("a");
  link.href = href;
  link.textContent = label;

  const beforeElement = beforeSelector ? container.querySelector(beforeSelector) : null;
  if (beforeElement) {
    container.insertBefore(link, beforeElement);
  } else {
    container.appendChild(link);
  }
}

const navToggle = document.querySelector("[data-nav-toggle]");
const nav = document.querySelector("[data-nav]");
const footerNav = document.querySelector(".site-footer nav");
const isHomePage = window.location.pathname.endsWith("/") || window.location.pathname.endsWith("/index.html");
const aboutHref = isHomePage ? "./about.html" : "./about.html";

ensureSiteLink(nav, aboutHref, "About", 'a[href="#why-us"], a[href="./index.html#intake"]');
ensureSiteLink(footerNav, aboutHref, "About", 'a[href="#intake"], a[href="./index.html#intake"]');

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

    const submitButton = intakeForm.querySelector('button[type="submit"]');
    const data = new FormData(intakeForm);

    const payload = {
      firstName: String(data.get("firstName") || "").trim(),
      lastName: String(data.get("lastName") || "").trim(),
      email: String(data.get("email") || data.get("Email") || "").trim(),
      biggestQuestion: String(data.get("biggestQuestion") || "").trim()
    };

    formResult.hidden = false;
    formResult.textContent = "Sending your request...";

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.textContent = "Sending...";
    }

    try {
      const response = await fetch("/api/leads", {
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

      formResult.textContent =
        result.message ||
        "Got it. We have your information. We will be in touch shortly with more about PlayBoard and the next step.";

      intakeForm.reset();
    } catch (error) {
      formResult.textContent =
        error.message ||
        "Something went wrong saving your request. Please try again.";
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Send Me More Information";
      }
    }
  });
}
