import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/infra/db/schema.ts",
  out: "./db/migrations",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://lattice:lattice_dev@localhost:54329/lattice" },
  strict: true,
  verbose: true,
});
