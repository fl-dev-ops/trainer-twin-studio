import { afterEach, expect, mock, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

let pathname = "/twin";
let isMobile = false;
mock.module("next/navigation", () => ({ usePathname: () => pathname }));
mock.module("@/hooks/use-mobile", () => ({ useIsMobile: () => isMobile }));
mock.module("@/components/theme-toggle", () => ({ ThemeToggle: () => <button>Theme</button> }));
mock.module("@/components/support-dialog", () => ({ SupportDialog: () => null }));
mock.module("@/components/credits/sidebar-credits", () => ({ SidebarCredits: () => <li>Credits</li> }));
mock.module("@/components/sidebar-account-menu", () => ({ SidebarAccountMenu: () => <button>Account</button> }));
mock.module("@/components/org-switcher", () => ({ OrgSwitcher: () => <button>Organization</button> }));

const { AppSidebar } = await import("@/components/app-sidebar");
const { AppShell } = await import("@/components/app-shell");
const { SidebarProvider, SidebarTrigger, SidebarMenuButton } = await import("@/components/ui/sidebar");

afterEach(() => {
  pathname = "/twin";
  isMobile = false;
});

function renderSidebar(props: ComponentProps<typeof AppSidebar> = {}, open = true) {
  return renderToStaticMarkup(
    <SidebarProvider defaultOpen={open}>
      <AppSidebar {...props} />
    </SidebarProvider>,
  );
}

test("uses the documented sections and standard widths, retaining footer actions", () => {
  const html = renderSidebar();
  for (const slot of ["header", "content", "group", "group-label", "group-content", "footer"]) {
    expect(html).toContain(`data-slot="sidebar-${slot}"`);
  }
  expect(html).toContain("--sidebar-width-left:16rem");
  expect(html).toContain("--sidebar-width-icon:3rem");
  for (const label of ["Credits", "Billing", "Support", "Settings", "Account"]) {
    expect(html).toContain(label);
  }
});

test("the app rail is wider without changing Copilot or collapsed widths", () => {
  const html = renderToStaticMarkup(<AppShell>Content</AppShell>);
  expect(html).toContain("--sidebar-width-left:18rem");
  expect(html).toContain("--sidebar-width-right:16rem");
  expect(html).toContain("--sidebar-width-icon:3rem");
});

test("navigation has roomier rows, separated items and lighter, smaller icons", () => {
  const html = renderSidebar();
  const link = html.match(/<a\b[^>]*>/)?.[0] ?? "";
  for (const metric of ["min-h-9", "max-h-9", "rounded-[6px]", "px-2", "gap-3", "size-4.5", "stroke-[1.5]"]) {
    expect(link).toContain(metric);
  }
  const menus = html.match(/<ul\b[^>]*data-slot="sidebar-menu"[^>]*>/g) ?? [];
  expect(menus).toHaveLength(3);
  for (const menu of menus) expect(menu).toContain("gap-1");
});

test("active navigation reuses hover colors without a separate shadow or heavier label", () => {
  const html = renderSidebar();
  const current = html.match(/<a\b[^>]*aria-current="page"[^>]*>/)?.[0] ?? "";
  expect(current).toContain("hover:bg-(--tone-control)");
  expect(current).toContain("data-active:bg-(--tone-control)");
  expect(current).toContain("hover:text-foreground");
  expect(current).toContain("data-active:text-foreground");
  expect(current).toContain("data-active:font-normal");
  expect(current).not.toContain("data-active:shadow-");
  expect(current).not.toContain("data-active:text-primary");
});

test.each([
  ["/twin", "/twin"],
  ["/twin/sessions/session-1", "/twin/sessions"],
  ["/twin/users/user-1", "/twin/users"],
  ["/twin/knowledge/document-1", "/twin/brain"],
  ["/roleplay/sessions/session-1", "/roleplay/sessions"],
  ["/billing", "/billing"],
  ["/settings", "/settings"],
])("%s marks only %s as the current page", (path, href) => {
  pathname = path;
  const html = renderSidebar();
  const currentLinks = html.match(/<a\b[^>]*aria-current="page"[^>]*>/g) ?? [];
  expect(currentLinks).toHaveLength(1);
  expect(currentLinks[0]).toContain(`href="${href}"`);
});

test("hides role play only for twin-only orgs and shows the org switcher only for multiple orgs", () => {
  const hidden = renderSidebar({ hideRoleplay: true });
  expect(hidden).not.toContain('href="/roleplay"');
  expect(hidden).not.toContain('href="/personas"');
  expect(hidden).toContain('href="/twin"');
  expect(hidden).not.toContain(">Organization<");
  const orgs = [
    { id: "one", name: "One", slug: "one" },
    { id: "two", name: "Two", slug: "two" },
  ];
  expect(renderSidebar({ orgs: orgs.slice(0, 1) })).not.toContain(">Organization<");
  expect(renderSidebar({ orgs, orgId: "one" })).toContain(">Organization<");
});

test("collapsed navigation keeps accessible labels and uses the shared toggle", () => {
  const html = renderSidebar({}, false);
  expect(html).toContain('data-collapsible="icon"');
  expect(html).toMatch(/<button\b[^>]*data-slot="sidebar-trigger"[^>]*aria-expanded="false"/);
  expect(html).toContain('aria-label="Twin agents"');
  expect(html).toContain('aria-label="Support"');
});

test.each(["default", "nav", "account"] as const)("%s sidebar labels use the shared 16px base", (variant) => {
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <SidebarMenuButton variant={variant} size={variant === "account" ? "lg" : "default"}>Label</SidebarMenuButton>
    </SidebarProvider>,
  );
  const button = html.match(/<button\b[^>]*>/)?.[0] ?? "";
  expect(button).toContain("text-base");
  expect(button).not.toContain("text-sm");
});

test("the shared toggle reports mobile drawer state, not expanded desktop state", () => {
  isMobile = true;
  const html = renderToStaticMarkup(
    <SidebarProvider defaultOpen>
      <SidebarTrigger />
    </SidebarProvider>,
  );
  expect(html).toContain('aria-expanded="false"');
});
