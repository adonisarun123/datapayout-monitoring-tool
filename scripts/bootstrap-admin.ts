import "dotenv/config";
import { closePool, db, one } from "../src/lib/db";
import { createUser } from "../src/server/auth";

/**
 * Creates the first administrator and prints a single-use invitation link.
 * No password is ever generated, stored or printed by this script, so there are no default credentials.
 */
async function main() {
  const email = process.env.ADMIN_EMAIL ?? process.argv[2];
  const name = process.env.ADMIN_NAME ?? process.argv[3] ?? "Administrator";
  if (!email) throw new Error("Set ADMIN_EMAIL (and optionally ADMIN_NAME), or pass: npm run bootstrap-admin -- you@example.com \"Your Name\"");
  const existing = await one(db, "select count(*)::int as n from users where role = 'ADMIN' and active");
  if (existing.n > 0 && !process.argv.includes("--force"))
    throw new Error("An active admin already exists. Invite further admins from Admin > Users, or pass --force to add another from the command line.");
  const { inviteUrl } = await createUser(null, { email, name, role: "ADMIN" });
  if (inviteUrl) console.log(`\nAdmin created for ${email}.\nOpen this single-use link within 72 hours to set the password:\n\n  ${inviteUrl}\n`);
  else console.log(`\nAdmin created for ${email}. Google sign-in is configured, so they sign in with Google; no link is needed.\n`);
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; }).finally(closePool);
