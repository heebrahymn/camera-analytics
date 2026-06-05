import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatLastSeen(lastSeenAt: string | null) {
  if (!lastSeenAt) return "never seen";
  const diffMs = new Date().getTime() - new Date(lastSeenAt).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 0) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  return new Date(lastSeenAt).toLocaleDateString("en-US", { timeZone: "Africa/Lagos", month: "short", day: "numeric" });
}
