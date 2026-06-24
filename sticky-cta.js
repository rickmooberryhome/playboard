const floatingCta = document.querySelector("[data-floating-cta]");

if (floatingCta && intakeSection) {
  const toggleFloatingCta = (isFormVisible) => {
    floatingCta.classList.toggle("is-hidden", isFormVisible);
  };

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        toggleFloatingCta(entry.isIntersecting);
      },
      {
        root: null,
        threshold: 0.08,
        rootMargin: "0px 0px -18% 0px"
      }
    );

    observer.observe(intakeSection);
  } else {
    const checkFormPosition = () => {
      const intakeTop = intakeSection.getBoundingClientRect().top;
      toggleFloatingCta(intakeTop < window.innerHeight * 0.82);
    };

    checkFormPosition();
    window.addEventListener("scroll", checkFormPosition, { passive: true });
    window.addEventListener("resize", checkFormPosition);
  }
}
