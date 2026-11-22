import { describe, expect, it } from "vitest";
import { matchesText } from "../../web/src/ticket-text.js";

describe("matchesText", () => {
  const ticket = { key: "PROJ-17", title: "Cards Drag between columns" };

  it("matches a word anywhere in the title, ignoring case", () => {
    expect(matchesText(ticket, "drag")).toBe(true);
    expect(matchesText(ticket, "between col")).toBe(true);
  });

  it("matches the whole key, or its number", () => {
    expect(matchesText(ticket, "proj-17")).toBe(true);
    expect(matchesText(ticket, "17")).toBe(true);
  });

  it("leaves out a Ticket neither contains", () => {
    expect(matchesText(ticket, "label")).toBe(false);
    expect(matchesText(ticket, "proj-18")).toBe(false);
  });
});
