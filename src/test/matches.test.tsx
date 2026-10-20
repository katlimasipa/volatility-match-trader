import { describe, expect, it } from "vitest";
import { analyze, lastDigit, shouldEnter } from "@/lib/matches";

const build = (counts: number[]) => counts.flatMap((c, d) => new Array(c).fill(d));

describe("matches strategy", () => {
  it("reads the last digit with 2 decimals", () => {
    expect(lastDigit(1234.5)).toBe(0);
    expect(lastDigit(1234.57)).toBe(7);
  });

  it("allows a trade when the difference is 0.3 or less", () => {
    // 1000 ticks: digit 3 = 12.0%, digit 7 = 11.8% -> diff 0.2
    const a = analyze(build([98, 98, 98, 120, 98, 98, 98, 118, 87, 87]));
    expect(a.most).toBe(3);
    expect(a.second).toBe(7);
    expect(a.ok).toBe(true);
  });

  it("blocks a trade when the difference exceeds 0.3", () => {
    // digit 3 = 12.0%, digit 7 = 11.6% -> diff 0.4
    const a = analyze(build([98, 98, 98, 120, 98, 98, 98, 116, 88, 88]));
    expect(a.ok).toBe(false);
  });

  it("enters only when current digit is the most appearing digit", () => {
    const a = analyze(build([98, 98, 98, 120, 98, 98, 98, 118, 87, 87]));
    expect(shouldEnter(a, 3)).toBe(true);
    expect(shouldEnter(a, 7)).toBe(false);
  });
});
