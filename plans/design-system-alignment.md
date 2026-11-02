# Studio ↔ design system alignment (shadcn/lint pass)

Why: `@shadcn/lint` reported ~1,700 errors in `web/`. They are not 1,700 problems. They are a dozen design patterns
hand-built and copy-pasted page to page, plus values that drifted from the TrainerTwin design system.

Sources of truth, in order:
1. **TrainerTwin design system** — `trainertwin-website/design-system/TRAINERTWIN-DESIGN-SYSTEM.md` (v9.4) and
   `trainertwin-website/src/styles/tokens.css`. Signed-off decisions; read the reason before changing one.
2. **The studio's own established patterns** — the V2 pages (twin, role play, personas), measured from their Figma.
   Where the studio is internally consistent and the system differs, the studio keeps its value for now and the
   difference is listed under "For the design owner" (the system's own rule: reconciled case by case).

## Method (the system's own, §14 "Reconciling the marketing page")

- **Derive, don't replace.** The studio keeps its vocabulary (`--brand`, `--tone-*`, `--card-border`); every value with
  a system equivalent points at the system value.
- **Three piles per value:** within a just-noticeable difference of a token → swap, no visible change; genuinely
  different → decided individually (below); third-party colours (Google/YouTube marks) → stay literal, marked.
- **One semantic thing implemented N times → one component or variant.** Add what the system lacks rather than
  hand-rolling it again.
- Every token swap is checked with the project's own Tailwind (compiled CSS before/after).

## Decisions

| # | Decision | Evidence | Visible change |
|---|---|---|---|
| D1 | Add the system's missing semantic tokens to `globals.css`: `brand-hover`, `success/info/caution/danger` (+ `-subtle`, `-border`), `live`, `elevation-1..3`, night surfaces. Values copied from `tokens.css`. | Studio hard-codes `#e04d00`/`#ff7e33` (= `--tt-primary-hover`) 20×, `#ce2c33` (= `--tt-live`) 5× | None for the copied values |
| D2 | Status colours use the system tokens: emerald → success, sky → info, red/rose → danger, **amber → caution (gold)**. `Badge` variants move to the system badge spec. | System rule 3: amber is banned (reads as a broken brand orange); status has defined text/subtle/border triples | Yes: status greens/blues shift slightly; amber becomes gold |
| D3 | One `Card`, two tiers, because the studio already steps radius with the element like the system says: default = the system card (12px, `card-border`, `elevation-1`) for grid cards, tiles and nested panels; `size="lg"` = the studio page panel (16px, the soft card shadow, 24px padding) for top-level detail/report cards. `interactive` lifts to `elevation-2`. The hand-built card surfaces and local `CARD` constants become `<Card>`. | 16px only on top-level page panels (25 uses), 12px on grid cards, stat tiles, wells and menus (38 uses); system card = 12px | Older screens get the system card (12px, card border, elevation-1 instead of a ring) |
| D4 | One page header and one section header (the V2 title bar and 18px section title); the 19 hand-written title bars and the old `PageHeader`/`SectionHeader` styles merge into them. | Two systems for one job | Older headers match the V2 pages |
| D5 | `Button`: a `brand` variant (= system `primary`: `#FF5A00`, hover `brand-hover`) replaces the 19 hand-rolled orange pills; otherwise the button is shadcn's (sizes, `text-sm` 14px labels, `size-4` icons) with only the shape tweaked: pill (`rounded-full`) and pill padding, the default matching a tab. The root font size is 100%; the studio's 110% size lives in the Tailwind theme instead (spacing, type, containers, radii at 1.1x in globals.css), so shadcn classes keep their own proportions at the size the UI was designed at. | System Button `sm` = 32px/13px; V2 pills = 32px/13px; Button was 32px/15.4px | Button labels app-wide 15.4 → 13px |
| D6 | Type: named sizes for the roles the system defines (`title-m` 20, `title-s` 17, `body` 15, `body-s` 13, `overline` 11) plus the studio's own `page-title` 16 and `section-title` 18; strays (9, 12, 14px) snap to the nearest role after looking at each. Sizes are px, not rem: the root is 110%. | 12 distinct px sizes in use; system scale has 5 product steps | Only where a stray snaps |
| D7 | Off-theme screens come onto the theme: pre-join (Google Meet greys), onboarding form (zinc greys), knowledge "add source" dialog (Tailwind orange), code/whiteboard/stage dark surfaces (→ night tokens). Mostly within a JND. | §14.2: near-identical literals are entropy, not design | Small; listed per screen in the change summary |
| D8 | Lint policy: `no-restyle` and `no-arbitrary-values` allow layout; contracts allow what genuinely belongs to the call site (Skeleton shape, container gaps, title typography). Component directories (`ui`, vendored registries) style themselves. | The rule docs' recommended setup | None |

## For the design owner (not changed in this pass)

- Card radius: studio 16px vs system 12px; card shadow: studio two-layer soft shadow vs system `elevation-1`.
- Button default variant: studio `default` is `--primary` = `#b83e00` (system `primary-ink`, a text colour) as a fill;
  the system says most buttons are `strong` (black) and orange is rationed to one per view.
- Weights: the studio uses 500 (`font-medium`) widely; the system has only 400 and 600.
- Icon sizes: the studio uses 18px title/nav icons; the system has 12/16/20/24.
- Page container: studio 1024px vs system `container-lg` 1200px.

## Components and variants added (so pages stop restyling)
- **Card** `raised` (elevation-2, floating panels); `interactive` (lifts on hover) replaces hand-made `hover:bg-accent` cards.
- **Dialog / AlertDialog**: the system modal — 16px radius, card border, elevation-3, `bg-scrim` overlay. Per-page `rounded-3xl`/`shadow-2xl` overrides removed.
- **Empty**: draws its own 12px dashed border; per-page borders removed.
- **Badge** `size="sm"` is now 11px (`text-overline`); new `glass` variant for chips over artwork. `text-overline` + colour overrides became `success`/`warning` variants.
- **Item** `size="row"` + `ItemGroup divided` for divided lists; `data-disabled` on an Item dims its content.
- **Editor / EditorContainer** `variant="field"` for the bordered form editor.
- **PersonaPhoto** `size` (md/lg/xl); **UserAvatar** call sites use `size`, not font overrides.
- **SearchInput** (`components/search-input.tsx`) for every search field; duration input uses InputGroup with a `min` suffix.
- Session filters use the shared `FilterDropdown`; role-play action triggers are `Button` icon variants.
- Root font size 100%; Tailwind's rem theme is 1.1x (`--spacing` 0.275rem, `--text-*`, `--container-*`, `--radius`), and hard-coded rems in the app are written at that scale. Verified against the old 110% build: identical except bare `rounded` (4px, was 4.4px) and third-party CSS (Excalidraw, glide grid, react-pptx), which is no longer scaled.
