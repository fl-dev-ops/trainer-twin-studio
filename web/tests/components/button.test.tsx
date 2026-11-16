import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, buttonVariants } from "@/components/ui/button";

const variants = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;

test.each(variants)("%s is pill-shaped by default", (variant) => {
  const classes = buttonVariants({ variant }).split(" ");
  expect(classes).toContain("rounded-full");
  expect(classes).not.toContain("rounded-lg");
  expect(classes).toContain("px-2.5");
  expect(classes).toContain("text-base");
  expect(classes).not.toContain("text-sm");
  expect(renderToStaticMarkup(<Button variant={variant}>Action</Button>)).toContain(">Action</button>");
});

test.each([
  ["default", "h-8", "px-2.5"],
  ["xs", "h-6", "px-2"],
  ["sm", "h-7", "px-2.5"],
  ["lg", "h-9", "px-2.5"],
] as const)("%s has the documented height and padding", (size, height, padding) => {
  const classes = buttonVariants({ size }).split(" ");
  expect(classes).toContain(height);
  expect(classes).toContain(padding);
});

test.each([
  ["icon", "size-8"],
  ["icon-xs", "size-6"],
  ["icon-sm", "size-7"],
  ["icon-lg", "size-9"],
] as const)("%s keeps its documented square size", (size, dimension) => {
  expect(buttonVariants({ size }).split(" ")).toContain(dimension);
});

test("small and icon sizes keep the pill-shaped default", () => {
  expect(buttonVariants({ size: "sm" }).split(" ")).toContain("text-[0.8rem]");
  for (const size of ["xs", "sm", "icon-xs", "icon-sm"] as const) {
    const classes = buttonVariants({ size }).split(" ");
    expect(classes).toContain("rounded-full");
    expect(classes.some((value) => value.startsWith("rounded-["))).toBe(false);
  }
});

test.each(["default", "lg", "xl"] as const)("%s button text uses the shared 16px base", (size) => {
  const html = renderToStaticMarkup(<Button size={size}>Action</Button>);
  expect(html).toContain("text-base");
  expect(html).not.toContain("text-sm");
  expect(html).not.toContain("text-body");
});

test("existing app-specific variants and large actions remain supported", () => {
  for (const variant of ["brand", "strong", "subtle", "ghost-destructive"] as const) {
    expect(renderToStaticMarkup(<Button variant={variant}>Action</Button>)).toContain(">Action</button>");
  }
  expect(buttonVariants({ size: "xl" }).split(" ")).toContain("h-11");
});

test("loading still disables actions without losing labels or submit behavior", () => {
  const html = renderToStaticMarkup(<Button type="submit" loading>Save</Button>);
  expect(html).toContain("disabled");
  expect(html).toContain('type="submit"');
  expect(html).toContain("animate-spin");
  expect(html).toContain("Save</button>");
});
