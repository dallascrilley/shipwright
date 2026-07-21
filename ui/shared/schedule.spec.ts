import { describe, expect, test } from "vitest";

import { nextScheduleOccurrence, validateSchedule } from "./schedule";

describe("schedule validation", () => {
  test("requires a valid IANA timezone and at least five minutes between runs", () => {
    expect(() => validateSchedule("*/4 * * * *", "UTC")).toThrow(
      "five minutes",
    );
    expect(() => validateSchedule("0,4 * * * *", "UTC")).toThrow(
      "five minutes",
    );
    expect(() => validateSchedule("0,58 * * * *", "UTC")).toThrow(
      "five minutes",
    );
    expect(() => validateSchedule("0,58 0 * * *", "UTC")).not.toThrow();
    expect(() =>
      validateSchedule("0,59 1,3 * * *", "America/New_York"),
    ).toThrow("five minutes");
    expect(() =>
      validateSchedule("30,59 1,2 * * *", "Australia/Lord_Howe"),
    ).toThrow("five minutes");
    expect(() => validateSchedule("*/5 * * * *", "Mars/Olympus")).toThrow(
      "timezone",
    );
  });

  test("calculates an IANA-zone occurrence across daylight saving time", () => {
    expect(
      nextScheduleOccurrence(
        "0 9 * * *",
        "America/New_York",
        "2026-03-07T16:00:00.000Z",
      ),
    ).toBe("2026-03-08T13:00:00.000Z");
  });

  test("revalidates future occurrences across timezone shifts", () => {
    expect(() =>
      nextScheduleOccurrence(
        "30,59 1,2 6 10 *",
        "Australia/Lord_Howe",
        "2029-12-01T00:00:00.000Z",
      ),
    ).toThrow("five minutes");
  });
});
