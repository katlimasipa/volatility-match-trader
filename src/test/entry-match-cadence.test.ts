import { describe, expect, it } from "vitest";
import {
  advanceEntryMatchWaitCount,
  normalizeEntryMatchWaitTicks,
} from "@/lib/entry-match-strategy";

describe("Entry Match tick interval", () => {
  it("limits the configured wait to one through ten ticks", () => {
    expect(normalizeEntryMatchWaitTicks(1)).toBe(1);
    expect(normalizeEntryMatchWaitTicks(8)).toBe(8);
    expect(normalizeEntryMatchWaitTicks(10)).toBe(10);
    expect(normalizeEntryMatchWaitTicks(0)).toBe(1);
    expect(normalizeEntryMatchWaitTicks(12)).toBe(10);
  });

  it("advances one tick at a time and becomes ready on the selected tick", () => {
    let waited = 0;
    for (let tick = 1; tick <= 7; tick++) {
      waited = advanceEntryMatchWaitCount(waited, 8);
      expect(waited).toBe(tick);
    }

    waited = advanceEntryMatchWaitCount(waited, 8);
    expect(waited).toBe(8);
    expect(advanceEntryMatchWaitCount(waited, 8)).toBe(8);
  });

  it("uses a new countdown after the trade settles", () => {
    let waited = advanceEntryMatchWaitCount(0, 3);
    waited = advanceEntryMatchWaitCount(waited, 3);
    waited = advanceEntryMatchWaitCount(waited, 3);
    expect(waited).toBe(3);

    waited = 0;
    expect(advanceEntryMatchWaitCount(waited, 3)).toBe(1);
  });
});
