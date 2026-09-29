/** Architecture boundaries. `npm run arch` fails the build if violated. */
module.exports = {
  forbidden: [
    {
      name: "core-is-pure",
      comment: "src/core is framework/IO free: it may import only itself and zod.",
      severity: "error",
      from: { path: "^src/core" },
      to: { path: "^(?!src/core)src|^node_modules/(?!zod/)", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "core-no-node-builtins",
      comment: "Hashing, randomness, time and IO go through ports so core stays runtime-agnostic and unit-testable.",
      severity: "error",
      from: { path: "^src/core" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "infra-not-from-app-or-ui",
      severity: "error",
      from: { path: "^src/infra" },
      to: { path: "^src/(app|ui)" },
    },
    {
      name: "ui-no-server-code",
      comment: "UI components must never import infra (DB, secrets, providers).",
      severity: "error",
      from: { path: "^src/ui" },
      to: { path: "^src/infra" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^(\.next|tests)" },
  },
};
