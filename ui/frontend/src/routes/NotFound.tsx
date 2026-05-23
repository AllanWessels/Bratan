import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-3 text-slate-700">
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p className="text-slate-500">The page you requested doesn&apos;t exist.</p>
      <Link to="/" className="text-brand-600 hover:underline">
        Go home
      </Link>
    </div>
  );
}
