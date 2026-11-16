import { pageParams, route, sp } from "@/lib/http";
import { createDevice, listDevices } from "@/server/masters";

export const GET = route({}, async ({ url }) =>
  listDevices({ typeId: sp(url, "typeId"), status: sp(url, "status"), search: sp(url, "search"), pocId: sp(url, "pocId"), ...pageParams(url) }));
export const POST = route({ admin: true, status: 201 }, async ({ actor, body }) => createDevice(actor, body));
