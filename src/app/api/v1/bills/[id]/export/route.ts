import { csvResponse, route, sp } from "@/lib/http";
import { getBill } from "@/server/bills";
import { billCsv, billPdf } from "@/server/exports";
import { audit } from "@/server/audit";
import { db } from "@/lib/db";

export const GET = route({ exportPermission: true }, async ({ params, url, actor }) => {
  const detail = await getBill(params.id);
  const format = sp(url, "format") === "pdf" ? "pdf" : "csv";
  await audit(db, actor, "BILL_EXPORTED", "bill", params.id, { after: { format, status: detail.bill.status } });
  if (format === "csv") return csvResponse(`${detail.bill.bill_number}.csv`, await billCsv(detail, actor));
  const bytes = await billPdf(detail, actor);
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${detail.bill.bill_number}.pdf"`,
      "cache-control": "no-store",
    },
  });
});
