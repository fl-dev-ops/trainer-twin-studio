import { beforeEach, expect, mock, test } from "bun:test";
import * as React from "react";
import type { ReactElement, ReactNode } from "react";
import type { AppRouter } from "@/lib/app-router";
import type { inferRouterOutputs } from "@trpc/server";

// Inspect the page's real tab selection and redirect without mounting its child forms.
const realReact = { ...React };
let effects: (() => void)[] = [];
mock.module("react", () => ({ ...realReact, useEffect: (effect: () => void) => { effects.push(effect); } }));
let requested: string | null = null;
const replace = mock();
mock.module("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(requested ? { tab: requested } : {}), useRouter: () => ({ replace }) }));
type Settings = inferRouterOutputs<AppRouter>["page"]["settings"];
let settings: Settings;
mock.module("@/lib/api", () => ({ api: {}, useApi: () => settings }));
mock.module("@/components/profile-form", () => ({ ProfileForm: () => null, OrganizationForm: () => null }));
mock.module("@/components/users/team-section", () => ({ TeamSection: () => null }));
const { default: SettingsPage } = await import("@/app/dash/settings/page");
const { Tabs, TabsTrigger } = await import("@/components/ui/tabs");

type Element = ReactElement<{ children?: ReactNode; value?: string }>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children)];
}
function render() {
  const tree = elements(SettingsPage());
  effects.forEach((effect) => effect());
  return { tab: tree.find((node) => node.type === Tabs)?.props.value,
    tabs: tree.filter((node) => node.type === TabsTrigger).map((node) => node.props.value) };
}
function studio() {
  settings.organization = { id: "org", name: "Org", slug: "org", logo: null, websiteUrl: null, accentColor: null };
  settings.team = { members: [] };
}
beforeEach(() => {
  effects = [];
  requested = null;
  replace.mockClear();
  settings = { user: { id: "learner", name: "Learner", email: "learner@example.com" }, organization: null, team: null };
});

test.each(["team", "branding", "billing", "unknown", null])("learner settings stays Account-only for %s", (tab) => {
  requested = tab;
  expect(render()).toEqual({ tab: "account", tabs: ["account"] });
  expect(replace).not.toHaveBeenCalled();
});
test.each(["account", "team", "branding"])("studio settings keeps the new %s tab", (tab) => {
  studio();
  requested = tab;
  expect(render()).toEqual({ tab, tabs: ["account", "team", "branding"] });
  expect(replace).not.toHaveBeenCalled();
});
test("old studio Billing links redirect to the new page, not a removed tab", () => {
  studio();
  requested = "billing";
  expect(render()).toEqual({ tab: "account", tabs: ["account", "team", "branding"] });
  expect(replace).toHaveBeenCalledWith("/billing");
});
