import type { MemoryStatus } from "@memeval/contracts";

const statusLabels: Record<MemoryStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  evaluating: "Evaluating",
  evaluated: "Evaluated",
};

export function statusLabel(status: MemoryStatus): string {
  return statusLabels[status];
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function parseIdList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
