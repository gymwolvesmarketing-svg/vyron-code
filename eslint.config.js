// Minimal ESLint 9 flat config, scoped to this project only (no new dependency — reuses
// the already-declared eslint-config-next, which ships its own flat-config array).
const nextConfig = require("eslint-config-next");

module.exports = [
  ...nextConfig,
  {
    ignores: ["node_modules/**", ".next/**", "data/**", "*.tsbuildinfo"],
  },
];
