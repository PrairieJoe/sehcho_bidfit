export function chooseAnalysisWindow(longWindowCount: number, windowEnd: Date, configuredLimit = 100) {
  const limit = Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : 100;
  const useShortWindow = longWindowCount > limit;
  const windowHours = useShortWindow ? 24 : 72;
  const windowStart = new Date(windowEnd.getTime() - windowHours * 3_600_000);
  return { windowStart, windowEnd, windowHours, useShortWindow, queryCount: useShortWindow ? 2 : 1 };
}
