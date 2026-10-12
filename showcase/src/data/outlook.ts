// The risk outlook row: the nearest readings to 6 h ago, 3 h ago and now, plus a scenario's future.
import type { HistoryPoint, Level } from "../../shared/contract";

export type OutlookStep = { label: string; at: string; level: Level; score: number; simulated: boolean };
const HOUR = 3600_000;

export function outlookSteps(
  history: HistoryPoint[],
  now: Date,
  future: Array<{ at_h: number; level: Level; score: number }> = [],
): OutlookStep[] {
  if (history.length === 0) return [];
  const targets: Array<[string, number]> = [["6 h ago", 6], ["3 h ago", 3], ["Now", 0]];
  const past = targets.map(([label, h]) => {
    const target = now.getTime() - h * HOUR;
    const p = history.reduce((best, x) =>
      Math.abs(new Date(x.t).getTime() - target) < Math.abs(new Date(best.t).getTime() - target) ? x : best,
    );
    return { label, at: p.t, level: p.level, score: p.score, simulated: false };
  });
  const ahead = future.map((f) => ({
    label: `+${f.at_h} h`,
    at: new Date(now.getTime() + f.at_h * HOUR).toISOString(),
    level: f.level,
    score: f.score,
    simulated: true,
  }));
  return [...past, ...ahead];
}
