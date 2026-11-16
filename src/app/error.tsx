"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="login"><div className="card" role="alert">
      <h1>Something went wrong</h1>
      <p className="muted">The page could not be loaded. Nothing was changed.{error.digest ? ` Reference: ${error.digest}` : ""}</p>
      <button className="primary" onClick={reset}>Try again</button>
    </div></div>
  );
}
