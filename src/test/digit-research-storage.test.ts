import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteResearchValue,
  readResearchValue,
  writeResearchValue,
} from "@/lib/digit-research-storage";

describe("digit research persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("persists tick collections when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const key = "ticks:R_100";
    const records = [[100, "1234.27", 7, "history"]];

    expect(await writeResearchValue(key, records)).toBe(true);
    await expect(readResearchValue(key)).resolves.toEqual(records);
    await deleteResearchValue(key);
    await expect(readResearchValue(key)).resolves.toBeNull();
  });
});
