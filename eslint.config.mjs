import { defineConfig, globalIgnores } from "eslint/config";
import next from "eslint-config-next";

export default defineConfig([
  ...next,
  globalIgnores([".next/**", "node_modules/**", ".claude/**", "coverage/**", "next-env.d.ts"]),
  {
    rules: {
      "no-console": ["error", { allow: ["warn", "error"] }], // use the pino logger; console can leak secrets
      eqeqeq: ["error", "always"],
      "no-eval": "error",
      "no-implied-eval": "error",
    },
  },
]);
