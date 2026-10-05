import { describe, expect, it } from "vitest";
import { speakableText } from "./voice";

describe("voice", () => {
  it("reads answers without markdown symbols", () => {
    expect(
      speakableText("## Result\n- **IndiGo**: ₹4,200 ([link](https://x.com))\n```js\ncode()\n```\nDone `now`")
    ).toBe("Result IndiGo: ₹4,200 (link) Done now");
  });
});
