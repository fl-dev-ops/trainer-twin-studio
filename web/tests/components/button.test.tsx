import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@/components/ui/button";

const classes = (html: string) => html.match(/class="([^"]*)"/)?.[1]?.split(" ");

test("the three appearances share one height and accept layout but not visual overrides", () => {
  for (const [variant, fill] of [
    ["default", "bg-brand"],
    ["secondary", "bg-button-secondary"],
    ["ghost", "bg-transparent"],
  ] as const) {
    const result = classes(renderToStaticMarkup(
      <Button variant={variant} className="mt-2 w-full h-12 p-0 rounded-none hover:bg-black text-sm">
        Continue
      </Button>,
    ));
    expect(result).toContain(fill);
    expect(result).toContain("h-9");
    expect(result).toContain("px-[18px]");
    expect(result).toContain("mt-2");
    expect(result).toContain("w-full");
    for (const override of ["h-12", "p-0", "rounded-none", "hover:bg-black", "text-sm"]) {
      expect(result).not.toContain(override);
    }
  }
});

test("default buttons use white foreground in either theme", () => {
  const result = classes(renderToStaticMarkup(<Button>Continue</Button>));
  expect(result).toContain("text-white");
  expect(result?.filter((token) => token.startsWith("dark:text-"))).toEqual([]);
});

test("h-11 is kept for the sign-in actions; any other height is not", () => {
  const kept = classes(renderToStaticMarkup(<Button className="h-11 w-full">Continue</Button>));
  expect(kept).toContain("h-11");
  expect(kept).not.toContain("h-9");
  const dropped = classes(renderToStaticMarkup(<Button className="h-10">Continue</Button>));
  expect(dropped).toContain("h-9");
  expect(dropped).not.toContain("h-10");
});

test("icon-only buttons stay square, and loading disables activation", () => {
  const html = renderToStaticMarkup(<Button iconOnly loading aria-label="Save" className="w-full" />);
  expect(classes(html)).toContain("w-9");
  expect(classes(html)).not.toContain("w-full");
  expect(html).toContain('aria-label="Save"');
  expect(html).toContain('disabled=""');
});
