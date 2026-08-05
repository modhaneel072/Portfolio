/**
 * Glossy cards.
 * Each [data-gloss] element gets --gx / --gy custom properties that follow
 * the pointer; the stylesheet uses them for a specular highlight, and a
 * shine bar sweeps across on hover (pure CSS).
 */

export function initGloss(): void {
  if (matchMedia("(pointer: coarse)").matches) return;

  const cards = document.querySelectorAll<HTMLElement>("[data-gloss]");
  cards.forEach((card) => {
    card.addEventListener(
      "pointermove",
      (e: PointerEvent) => {
        const rect = card.getBoundingClientRect();
        card.style.setProperty("--gx", `${e.clientX - rect.left}px`);
        card.style.setProperty("--gy", `${e.clientY - rect.top}px`);
      },
      { passive: true },
    );
  });
}
