export function chooseAnalysisWindow(longWindowCount: number, windowEnd: Date, configuredLimit = 100) {
  // The daily unit is always anchored to the execution time. This prevents a
  // 72-hour overlap from silently expanding the collection when the candidate
  // count happens to be below Gemini's free-plan limit.
  void longWindowCount;
  void configuredLimit;
  const windowHours = 24;
  const windowStart = new Date(windowEnd.getTime() - windowHours * 3_600_000);
  return { windowStart, windowEnd, windowHours, useShortWindow: true, queryCount: 1 };
}
