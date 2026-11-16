import Link from "next/link";

export default function NotFound() {
  return (
    <div className="login"><div className="card"><h1>Not found</h1><p className="muted">That record does not exist or you cannot see it.</p><Link href="/">Back to dashboard</Link></div></div>
  );
}
