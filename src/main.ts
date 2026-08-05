import "./style.css";
import { initFluid } from "./fluid";
import { initGloss } from "./gloss";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- liquid ink under the glass ---------- */
const bath = document.getElementById("ink");
if (bath instanceof HTMLCanvasElement) initFluid(bath);

/* ---------- glossy cards ---------- */
initGloss();

/* ---------- scroll reveal ---------- */
const revealables = document.querySelectorAll<HTMLElement>("[data-reveal]");
if (reducedMotion || !("IntersectionObserver" in window)) {
  revealables.forEach((el) => el.classList.add("is-in"));
} else {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.1, rootMargin: "0px 0px -32px 0px" },
  );
  revealables.forEach((el) => observer.observe(el));
}

/* ---------- copy email ---------- */
const copyBtn = document.querySelector<HTMLButtonElement>("[data-copy-email]");
if (copyBtn) {
  let timer: number | undefined;
  copyBtn.addEventListener("click", () => {
    navigator.clipboard
      .writeText("modhaneel072@gmail.com")
      .then(() => {
        copyBtn.textContent = "Copied";
        copyBtn.classList.add("copied");
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          copyBtn.textContent = "Copy";
          copyBtn.classList.remove("copied");
        }, 2000);
      })
      .catch(() => {
        copyBtn.textContent = "modhaneel072@gmail.com";
      });
  });
}

/* ---------- footer year ---------- */
const year = document.getElementById("year");
if (year) year.textContent = String(new Date().getFullYear());
