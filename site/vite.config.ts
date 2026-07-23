import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `base: "./"` (relative asset paths) rather than an absolute "/repo-name/"
// path: this makes the build portable regardless of what the GitHub repo
// ends up being named or whether it's served from a project page or a
// custom domain, with no config change needed either way.
export default defineConfig({
  plugins: [react()],
  base: "./",
});
