export function latestAnalysisWindow(windowEnd: Date) {
  const windowHours = 24;
  const windowStart = new Date(windowEnd.getTime() - windowHours * 3_600_000);
  return { windowStart, windowEnd, windowHours, queryCount: 1 };
}
