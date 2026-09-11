# Issue 8: Page Route Loading States (`loading.tsx`)

## 1. Context & Problem Statement
Currently, there are **0 `loading.tsx` files** across the entire application (`web/app/`). 

Because Next.js App Router relies on React Suspense and streaming for asynchronous page loads (e.g. database lookups in Neon, spec compilation from S3, Chroma collection reads), navigating between pages currently freezes the UI until server components resolve, or results in sudden layout pops.

Adding proper `loading.tsx` files across all routes ensures:
- Instant feedback on link navigation via React Suspense boundaries.
- Consistent visual hierarchy (preventing cumulative layout shift / CLS).
- Preserved layout chrome (sidebar, headers) while data is loading.

---

## 2. Design System & Component Guidelines

1. **Primitives:**
   - Utilize existing `Skeleton` (`web/components/ui/skeleton.tsx`) for structural placeholders.
   - Utilize `Spinner` (`web/components/ui/spinner.tsx`) for standalone loader indicators.
2. **Theming:**
   - Use semantic Tailwind tokens (`bg-muted/60`, `animate-pulse`, `rounded-lg`) so skeletons look polished in both light and dark themes.
3. **Structure & Proportions:**
   - Skeletons must mirror the exact layout structure of the destination page (e.g., page header skeleton + metric cards + table row skeletons) rather than generic center spinners, minimizing content shifts.

---

## 3. Route Inventory & Loading State Hierarchy

```text
web/app/
├── (org)/                      # Learner Portal Routes
│   ├── loading.tsx             # Root learner layout skeleton
│   ├── session/[agent]/        # Learner live practice session
│   │   └── loading.tsx         # Centered practice stage skeleton
│   ├── sessions/               # Past sessions list
│   │   ├── loading.tsx         # Sessions table skeleton
│   │   └── [id]/
│   │       └── loading.tsx     # Session scorecard & transcript skeleton
│   └── s/[code]/
│       └── loading.tsx         # Invite code activation skeleton
│
├── auth/                       # Authentication Routes
│   ├── loading.tsx             # Centered card skeleton
│   ├── onboarding/
│   │   └── loading.tsx         # Stepper & form skeleton
│   └── sign-in/
│       └── loading.tsx         # Credentials & OAuth button skeleton
│
└── dash/                       # TrainerTwin Studio Routes
    ├── loading.tsx             # Default studio overview skeleton
    ├── talk/
    │   └── loading.tsx         # Session configuration card skeleton
    ├── agents/
    │   ├── loading.tsx         # Agent cards/table skeleton
    │   └── [slug]/
    │       └── loading.tsx     # Agent editor & rubric spec skeleton
    ├── personas/
    │   ├── loading.tsx         # Personas grid skeleton
    │   └── [slug]/
    │       └── loading.tsx     # Persona profile & source panel skeleton
    ├── knowledge/
    │   ├── loading.tsx         # Knowledge bases list skeleton
    │   └── [slug]/
    │       └── loading.tsx     # Document list & chunk viewer skeleton
    ├── sessions/
    │   ├── loading.tsx         # Studio session analytics table skeleton
    │   └── [id]/
    │       └── loading.tsx     # Detailed evaluation & transcript report skeleton
    ├── voice/
    │   ├── loading.tsx         # Voice catalog & player skeleton
    │   └── cloning/
    │       └── loading.tsx     # Voice recording & model train skeleton
    ├── domains/
    │   └── loading.tsx         # Domain principles skeleton
    └── developer/
        └── loading.tsx         # API keys & webhook table skeleton
```

---

## 4. Verification Checklist (Definition of Done)

### Studio Dashboard Routes (`web/app/dash/`)
- [ ] `web/app/dash/loading.tsx` — Base dashboard fallback with header and card skeletons.
- [ ] `web/app/dash/talk/loading.tsx` — Fullscreen session card skeleton matching `<SessionView>` setup.
- [ ] `web/app/dash/agents/loading.tsx` & `agents/[slug]/loading.tsx` — Agent table and agent editor skeletons.
- [ ] `web/app/dash/personas/loading.tsx` & `personas/[slug]/loading.tsx` — Persona list and source panel skeletons.
- [ ] `web/app/dash/knowledge/loading.tsx` & `knowledge/[slug]/loading.tsx` — Knowledge base and document viewer skeletons.
- [ ] `web/app/dash/sessions/loading.tsx` & `sessions/[id]/loading.tsx` — Sessions list and scorecard detail skeletons.
- [ ] `web/app/dash/voice/loading.tsx` — Voice library skeleton.
- [ ] `web/app/dash/domains/loading.tsx` & `developer/loading.tsx` — Settings and developer key skeletons.

### Learner Portal Routes (`web/app/(org)/`)
- [ ] `web/app/(org)/loading.tsx` — Base learner shell loading state.
- [ ] `web/app/(org)/session/[agent]/loading.tsx` — Learner stage loading skeleton.
- [ ] `web/app/(org)/sessions/loading.tsx` & `sessions/[id]/loading.tsx` — Learner history and review skeletons.
- [ ] `web/app/(org)/s/[code]/loading.tsx` — Invitation link activation skeleton.

### Auth Routes (`web/app/auth/`)
- [ ] `web/app/auth/sign-in/loading.tsx` — Sign-in card skeleton.
- [ ] `web/app/auth/onboarding/loading.tsx` — Founder onboarding stepper skeleton.

### Quality & Performance
- [ ] Skeletons render with zero hydration mismatches or console warnings.
- [ ] Both dark and light themes render with appropriate contrast and subtle pulse animations.
- [ ] Page navigation displays immediate visual feedback without freezing the active window.
