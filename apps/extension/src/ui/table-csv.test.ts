import { describe, expect, it } from "vitest";
import { markdownTables, toCsv } from "./table-csv";

describe("tables to CSV", () => {
  it("finds markdown tables in an answer and converts them", () => {
    const answer = [
      "Here are the flights:",
      "",
      "| Airline | Price | Notes |",
      "|---|---:|:---|",
      "| **IndiGo** | ₹4,200 | non-stop, 2h |",
      "| Air India | ₹5,100 | [book](https://x.com) |",
      "",
      "Cheapest is IndiGo."
    ].join("\n");
    const [table] = markdownTables(answer);
    expect(table.headers).toEqual(["Airline", "Price", "Notes"]);
    expect(table.rows).toEqual([
      ["IndiGo", "₹4,200", "non-stop, 2h"],
      ["Air India", "₹5,100", "book (https://x.com)"]
    ]);
    expect(toCsv(table)).toBe(
      'Airline,Price,Notes\r\nIndiGo,"₹4,200","non-stop, 2h"\r\nAir India,"₹5,100",book (https://x.com)'
    );
  });

  it("ignores text without a table and keeps escaped pipes", () => {
    expect(markdownTables("a | b but no separator")).toEqual([]);
    expect(markdownTables("| a | b |\n|--|--|\n| x \\| y | z |")[0].rows).toEqual([["x | y", "z"]]);
  });

  it("stops spreadsheet formulas from running", () => {
    expect(toCsv({ headers: ["a", "b"], rows: [["=HYPERLINK(1)", "-5"]] })).toBe("a,b\r\n'=HYPERLINK(1),'-5");
  });
});
