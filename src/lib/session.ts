import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getActorFromToken, SESSION_COOKIE } from "@/server/auth";
import type { Actor } from "@/server/audit";

/** For server-rendered pages: the signed-in user, or a redirect to the login screen. */
export async function requireUser(): Promise<Actor> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const actor = await getActorFromToken(token);
  if (!actor) redirect(token ? "/login?expired=1" : "/login");
  return actor;
}

export async function currentUser(): Promise<Actor | null> {
  return getActorFromToken((await cookies()).get(SESSION_COOKIE)?.value);
}
