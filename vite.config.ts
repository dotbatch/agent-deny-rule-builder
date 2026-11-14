import { defineConfig } from "vite";

// Relative base so the build works both at dotbatch.github.io/agent-deny-rule-builder/
// and at a custom subdomain root, with no change needed later.
export default defineConfig({
  base: "./",
});
