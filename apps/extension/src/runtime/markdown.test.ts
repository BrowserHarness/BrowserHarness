import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

describe("markdown subset", () => {
  it("parses blocks", () => {
    const blocks = parseMarkdown(
      "# Title\n\nSome **bold** and `code`.\n\n- a\n- b\n\n1. x\n2. y\n\n```\nlet a = 1;\n```\n> quoted"
    );
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "code", "quote"]);
    expect(blocks[2]).toMatchObject({ ordered: false });
    expect(blocks[3]).toMatchObject({ ordered: true });
    expect(blocks[4]).toMatchObject({ text: "let a = 1;" });
  });

  it("links only http(s) and never emits raw html or script urls", () => {
    const nodes = parseInline("[ok](https://a.com/x) [bad](javascript:alert(1)) <img src=x onerror=1> https://b.com/y");
    const links = nodes.filter((n) => n.type === "link");
    expect(links.map((l) => (l as { href: string }).href)).toEqual(["https://a.com/x", "https://b.com/y"]);
    expect(JSON.stringify(nodes)).not.toContain('"href":"javascript');
    expect(nodes.some((n) => n.type === "text" && n.text.includes("<img"))).toBe(true);
  });
});
