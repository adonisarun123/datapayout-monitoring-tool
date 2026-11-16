import Link from "next/link";
import type { ReactNode } from "react";
import { label, qs, tone } from "@/lib/format";

export function Badge({ status, text }: { status: string | null | undefined; text?: string }) {
  if (!status) return null;
  return <span className={`badge ${tone(status)}`}>{text ?? label(status)}</span>;
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="head">
      <div>
        <h1>{title}</h1>
        {sub ? <div className="muted">{sub}</div> : null}
      </div>
      {children ? <div className="actions no-print">{children}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function AccessDenied() {
  return (
    <div className="card" role="alert">
      <h2>Access denied</h2>
      <p>This area is for administrators. If you need access, ask an admin to change your role.</p>
      <Link href="/">Back to dashboard</Link>
    </div>
  );
}

export function Pager({ path, params, page, pageSize, total }: { path: string; params: Record<string, string | undefined>; page: number; pageSize: number; total: number }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager no-print">
      <span className="muted">{total.toLocaleString("en-IN")} record{total === 1 ? "" : "s"}, page {page} of {pages}</span>
      {page > 1 ? <Link className="btn" href={`${path}${qs({ ...params, page: page - 1 })}`}>Previous</Link> : null}
      {page < pages ? <Link className="btn" href={`${path}${qs({ ...params, page: page + 1 })}`}>Next</Link> : null}
    </div>
  );
}

export function Select({ name, labelText, value, options, any = "All" }: { name: string; labelText: string; value?: string; options: { value: string; label: string }[]; any?: string | null }) {
  return (
    <div className="field">
      <label htmlFor={`f-${name}`}>{labelText}</label>
      <select id={`f-${name}`} name={name} defaultValue={value ?? ""}>
        {any !== null ? <option value="">{any}</option> : null}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}

export function Input({ name, labelText, value, type = "text", placeholder }: { name: string; labelText: string; value?: string; type?: string; placeholder?: string }) {
  return (
    <div className="field">
      <label htmlFor={`f-${name}`}>{labelText}</label>
      <input id={`f-${name}`} name={name} type={type} defaultValue={value ?? ""} placeholder={placeholder} />
    </div>
  );
}

export function FilterBar({ children, clearHref }: { children: ReactNode; clearHref: string }) {
  return (
    <form method="get" className="card no-print" aria-label="Filters">
      <div className="filters">
        {children}
        <div className="actions">
          <button className="primary" type="submit">Apply</button>
          <Link className="btn" href={clearHref}>Clear</Link>
        </div>
      </div>
    </form>
  );
}
