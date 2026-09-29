import { describe, expect, it } from "vitest";
import { sectionLabel } from "@/ui/section-label";

describe("sectionLabel", () => {
  it("drops the leading segment when it repeats the document title", () => {
    expect(sectionLabel("Acme Handbook", "Acme Handbook › Office security")).toBe("Office security");
    expect(sectionLabel("acme handbook", "Acme Handbook › Refunds › Digital")).toBe("Refunds › Digital");
  });
  it("keeps the whole path when it does not start with the title (e.g. PDF pages)", () => {
    expect(sectionLabel("Guide", "Page 3")).toBe("Page 3");
  });
  it("is empty when nothing distinct remains", () => {
    expect(sectionLabel("Guide", "Guide")).toBe("");
    expect(sectionLabel("Guide", "")).toBe("");
  });
});
