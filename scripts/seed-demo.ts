import "dotenv/config";
import { closePool, db, one, q } from "../src/lib/db";
import { addDays, todayIST } from "../src/lib/dates";
import type { Actor } from "../src/server/audit";
import { createAssignment, createDevice, createPoc, createRule } from "../src/server/masters";
import { submitEntry } from "../src/server/entries";
import { approveBill, createBill, submitBill } from "../src/server/bills";
import { recordPayment } from "../src/server/payments";

/**
 * Fictional demo data for development and UAT databases only. Entries, bills, payments and audit events
 * can never be deleted, so do not run this against the production database: start production from a
 * freshly migrated, empty database instead.
 */
async function main() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEMO_SEED !== "1")
    throw new Error("Refusing to seed demo data with NODE_ENV=production.");
  if ((await one(db, "select count(*)::int as n from devices")).n > 0) throw new Error("This database already has devices; demo seed skipped.");
  const admin = await one(db, "select * from users where role = 'ADMIN' and active order by created_at limit 1");
  if (!admin) throw new Error("Create the first admin with `npm run bootstrap-admin` before seeding demo data.");
  const actor: Actor = { id: admin.id, role: "ADMIN", name: admin.name, email: admin.email, canExport: true, requestId: "demo-seed" };
  const types = await q(db, "select id, name from device_types order by name");
  if (types.length < 3) throw new Error("Expected the three seeded device types.");

  const today = todayIST();
  const start = addDays(today, -120);
  const retro = { reason: "Demo seed", confirmRetroactive: true };
  const pocs = [];
  for (const [name, organization] of [["Demo POC Anika Rao", "Fictional Farms"], ["Demo POC Rohan Iyer", "Sample Logistics"], ["Demo POC Sara Thomas", "Example Clinics"]])
    pocs.push(await createPoc(actor, { name, organization, notes: "Fictional demo record" }));

  const devices = [];
  const terms: [string, string][] = [["120", "70"], ["95.5", "70"], ["150", "65"]];
  for (let t = 0; t < 3; t++) {
    for (let i = 1; i <= 3; i++) {
      const d = await createDevice(actor, { code: `DEMO-${t + 1}${String(i).padStart(2, "0")}`, name: `Demo unit ${t + 1}-${i}`, typeId: types[t].id, commissionedOn: start });
      await createAssignment(actor, d.id, { pocId: pocs[(t + i) % 3].id, validFrom: start, ...retro });
      await createRule(actor, d.id, { rate: terms[t][0], currency: "INR", percentage: terms[t][1], validFrom: start, ...retro });
      devices.push(d);
    }
  }
  // One reassignment and one rate change part-way through, to show effective dating.
  await createAssignment(actor, devices[0].id, { pocId: pocs[0].id, validFrom: addDays(today, -40), ...retro });
  await createRule(actor, devices[0].id, { rate: "130", currency: "INR", percentage: "72.5", validFrom: addDays(today, -40), ...retro });

  let n = 0;
  for (const d of devices) {
    for (const back of [75, 60, 45, 30, 20, 12, 6, 2]) {
      const hours = (4 + ((n * 37) % 190) / 10).toFixed(n % 3 === 0 ? 4 : 1);
      await submitEntry(actor, {
        deviceId: d.id, activityDate: addDays(today, -back), hours, reference: `DEMO-BATCH-${String(++n).padStart(4, "0")}`,
        notes: "Fictional demo entry", acknowledgedWarnings: ["HOURS_ABOVE_THRESHOLD", "POSSIBLE_DUPLICATE"],
      });
    }
  }

  // One approved and part-paid bill, one pending, one draft.
  const from = addDays(today, -90), mid = addDays(today, -31);
  let a = (await createBill(actor, { pocId: pocs[0].id, currency: "INR", dateFrom: from, dateTo: mid })).bill;
  a = (await submitBill(actor, a.id, { expectedVersion: a.version })).bill;
  a = (await approveBill(actor, a.id, { expectedVersion: a.version, comment: "Demo approval" })).bill;
  await recordPayment(actor, a.id, { paymentDate: today, amount: "1000.00", method: "NEFT", reference: "DEMO-UTR-0001", note: "Fictional part payment" });
  let b = (await createBill(actor, { pocId: pocs[1].id, currency: "INR", dateFrom: from, dateTo: mid })).bill;
  b = (await submitBill(actor, b.id, { expectedVersion: b.version })).bill;
  const c = (await createBill(actor, { pocId: pocs[2].id, currency: "INR", dateFrom: from, dateTo: mid })).bill;
  console.log(`Demo data created: ${pocs.length} POCs, ${devices.length} devices, ${n} entries, bills ${a.bill_number} (approved), ${b.bill_number} (pending), ${c.bill_number} (draft).`);
}

main().catch((e) => { console.error(e.message ?? e); process.exitCode = 1; }).finally(closePool);
