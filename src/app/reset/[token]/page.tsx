import { TokenPage } from "@/components/token-page";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  return <TokenPage token={(await params).token} kind="RESET" />;
}
