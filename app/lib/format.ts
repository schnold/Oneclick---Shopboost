/**
 * Display helpers shared by loaders and components.
 *
 * Deliberately not a `.server` module: React Router strips server modules from
 * the client bundle, and these run in both places.
 */

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}
