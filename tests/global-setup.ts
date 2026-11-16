import { Client } from "pg";
import { migrate } from "../scripts/migrate";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://dm:dm@localhost:5432/dm_test";

/** Rebuilds the test database from the real migrations, so tests exercise the real constraints and triggers. */
export default async function setup() {
  const c = new Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query("drop schema public cascade; create schema public;");
  await c.end();
  await migrate(TEST_DB, () => {});
}
