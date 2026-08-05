# Neel Modha — Personal site

> **Live:** [modhaneel072.github.io/Portfolio](https://modhaneel072.github.io/Portfolio/)

Personal site built with **TypeScript, Tailwind CSS 4, and Vite**. Under the page is
**real liquid ink** — a GPU Navier–Stokes fluid simulation (semi-Lagrangian advection,
Jacobi pressure projection, vorticity confinement) written from scratch in raw WebGL2.
The cursor stirs the liquid, clicks splash pigment, ambient droplets keep it moving,
and a glass layer with reflection streaks + specular shading makes the ink read as
liquid under glass. Pigment renders subtractively, so it behaves like ink on paper
rather than neon on black. Type pairs Fraunces with Schibsted Grotesk — self-hosted.

## Develop

```bash
npm install
npm run dev        # local dev server
npm run build      # type-check + production build to dist/
npm run preview    # serve the production build locally
```

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the site and
publishes `dist/` to GitHub Pages.

**One-time setup:** in the repo settings on GitHub, set
*Settings → Pages → Build and deployment → Source* to **GitHub Actions**.

## Structure

```
├── index.html                  # Page content (Vite entry)
├── src/
│   ├── main.ts                 # Wiring: fluid, gloss, reveals, copy-email
│   ├── fluid.ts                # WebGL2 Navier–Stokes fluid solver + ink display
│   ├── gloss.ts                # Pointer-tracked specular highlight on cards
│   └── style.css               # Tailwind theme tokens + custom layers
├── public/
│   ├── fonts/                  # Fraunces + Schibsted Grotesk (variable, self-hosted)
│   ├── NeelModha_Resume.pdf
│   └── 404.html
└── .github/workflows/deploy.yml
```

## Notes

- Fluid: taps splash on touch devices; removed entirely under `prefers-reduced-motion` or where WebGL2 float rendering is unavailable (the page works without it)
- The render loop sleeps ~14 s after the last splash and wakes on interaction
- Works without JavaScript (content is plain HTML; effects are enhancements)
- Print stylesheet — the page prints cleanly
- No third-party requests at runtime; fonts are self-hosted

## Contact

- **Email:** modhaneel072@gmail.com
- **GitHub:** [github.com/modhaneel072](https://github.com/modhaneel072)
- **LinkedIn:** [linkedin.com/in/NeelModha](https://linkedin.com/in/NeelModha)
