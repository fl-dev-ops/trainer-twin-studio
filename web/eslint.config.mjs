// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";
import { plugin as shadcn } from "@shadcn/lint";

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([...nextVitals, ...nextTs, {
  files: [
    "components/agents-ui/**/*.ts",
    "components/agents-ui/**/*.tsx",
    "components/ai-elements/**/*.ts",
    "components/ai-elements/**/*.tsx",
    "hooks/agents-ui/**/*.ts",
    "hooks/agents-ui/**/*.tsx",
  ],
  rules: {
    "react-hooks/set-state-in-effect": "off",
    "react-hooks/static-components": "off",
  },
}, {
  // Design-system rules (@shadcn/lint): theme tokens instead of raw values, component variants instead of restyles.
  files: ["**/*.{ts,tsx}"],
  plugins: { shadcn },
  rules: {
    "shadcn/no-restyle": ["error", {
      allow: ["layout"],
      // What genuinely belongs to the call site (plans/design-system-alignment.md D8).
      contracts: [
        // A card owns its surface; its padding and gaps depend on the content (the design system: padding lives on
        // the sections, so a table or image can run edge to edge).
        { pattern: "^Card(Header|Content|Footer)?$", allow: ["layout", "spacing"] },
        // Dialogs, sheets and empty states are surfaces too: their padding follows the content.
        { pattern: "^(DialogContent|AlertDialogContent|SheetContent|PopoverContent|Empty)$", allow: ["layout", "spacing"] },
        // Table cells: emphasis and muted secondary columns follow the data.
        { pattern: "^Table(Cell|Head)$", allow: ["layout", "typography", "color"] },
        // Containers that arrange their children: the gap between them is the page's composition.
        { pattern: "^(Dialog|AlertDialog|Sheet)(Header|Footer)$|^Tabs(Content)?$|^(ItemGroup|SidebarMenu|Field|FieldGroup)$", allow: ["layout", "spacing"] },
        // Text parts: their size depends on where they sit (a dialog vs a card title); colour stays the component's.
        { pattern: "(Title|Description|Label)$", allow: ["layout", "typography", "spacing"] },
        // A field's typography follows its content: code in mono, numbers in tabular figures.
        { pattern: "^(Input|InputGroupInput|Textarea)$", allow: ["layout", "typography"] },
        // A skeleton takes the shape of what it stands in for.
        { pattern: "^Skeleton$", allow: ["layout", "shape"] },
        // A spinner is an icon: it takes the colour of where it sits.
        { pattern: "^Spinner$", allow: ["layout", "color"] },
      ],
    }],
    "shadcn/no-arbitrary-values": ["error", {
      // Mechanics, not design values: which properties animate, a staggered animation's delay (set per item through a
      // custom property), and the capture screens' viewport-relative top offset.
      allow: ["layout", "transition-*", "[animation-delay:*]", "pt-[4vh]", "pt-[8vh]"],
    }],
    "shadcn/no-raw-colors": "error",
    // originX / originY: framer-motion's animation origin for SVG paths, handed to the motion engine.
    "shadcn/no-inline-styles": ["error", { allow: ["originX", "originY"] }],
    // Hooks other libraries read: Sonner's toaster group, Plate's click-outside guard.
    "shadcn/no-unknown-classes": ["error", { allow: ["toaster", "ignore-click-outside/toolbar"] }],
    "shadcn/require-static-classes": "error",
  },
}, {
  // Component code styles its own internals: the primitives (components/ui), the vendored registries, and the
  // studio's shared presentational components built on them (plans/design-system-alignment.md D8). Pages and
  // feature components are not on this list; they use these components' props.
  files: [
    "components/{ui,ai-elements,agents-ui,extend}/**",
    "components/{page-header,page-container,page-skeletons,user-avatar}.tsx",
    "components/twin/twin-face.tsx",
    "components/persona/persona-parts.tsx",
    "components/search-input.tsx",
    "components/filter-dropdown.tsx",
  ],
  rules: {
    "shadcn/no-restyle": "off",
    "shadcn/no-arbitrary-values": "off",
    "shadcn/require-static-classes": "off",
  },
}, {
  // Vendored registries (ai-sdk elements, LiveKit agents-ui, extend.ai viewers) are third-party code refreshed from
  // their registries; editing them would drift from upstream on every update (plans/design-system-alignment.md D8).
  files: ["components/{ai-elements,agents-ui,extend}/**"],
  rules: {
    "shadcn/no-raw-colors": "off",
    "shadcn/no-inline-styles": "off",
    "shadcn/no-unknown-classes": "off",
  },
}, {
  // Identity tints for initials ("same person, same colour"): category colours deliberately outside the token palette
  // (design system decision D05).
  files: ["components/user-avatar.tsx"],
  rules: { "shadcn/no-raw-colors": "off" },
}, // Override default ignores of eslint-config-next.
globalIgnores([
  // Default ignores of eslint-config-next:
  ".next/**",
  "out/**",
  "build/**",
  "next-env.d.ts",
]), ...storybook.configs["flat/recommended"]]);

export default eslintConfig;
