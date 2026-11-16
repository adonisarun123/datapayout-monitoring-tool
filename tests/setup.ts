import { afterAll } from "vitest";
import { closePool } from "@/lib/db";

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://dm:dm@localhost:5432/dm_test";
process.env.APP_URL = "http://localhost:3000";

afterAll(async () => {
  await closePool();
});
