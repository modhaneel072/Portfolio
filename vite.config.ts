import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  // deployed at https://modhaneel072.github.io/Portfolio/
  base: "/Portfolio/",
  plugins: [tailwindcss()],
  build: { target: "es2020" },
});
