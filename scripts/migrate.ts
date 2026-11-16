import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

/** Applies migrations/*.sql in filename order, each in its own transaction, recording what ran. */
export async function migrate(connectionString: string, log: (m: string) => void = console.log): Promise<void> {
  const client = new Client({
    connectionString,
    ssl: process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: true } : undefined,
  });
  await client.connect();
  try {
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const dir = path.resolve(__dirname, "..", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const done = await client.query("select 1 from schema_migrations where name = $1", [file]);
      if (done.rowCount) continue;
      log(`applying ${file}`);
      await client.query("begin");
      try {
        await client.query(fs.readFileSync(path.join(dir, file), "utf8"));
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
      } catch (e) {
        await client.query("rollback");
        throw e;
      }
    }
    log("migrations up to date");
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  migrate(process.env.DATABASE_URL).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
