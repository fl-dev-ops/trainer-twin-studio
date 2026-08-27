# 1st February

Source: https://app.notion.com/p/2f21199ccfe38087a743d7ea4d3a593f



## **Code Splitting in React — Shipping Less JavaScript**

### Why Code Splitting Exists

Modern React applications grow fast:

- Large component trees

- Third-party libraries

- Feature-heavy pages

Result:

- Big JS bundle

- Slow initial load

- Poor **LCP**

- Sluggish interactions

Code splitting answers one question:

> Why download code the user may never need?

---

### What Code Splitting Means

> Code splitting means breaking a large JavaScript bundle into smaller chunks and loading them when required.

It is a **build-time optimization** with **runtime impact**.

---

### What Code Splitting Is NOT

- ❌ Not data fetching

- ❌ Not memoization

- ❌ Not Virtualization

- ❌ Not lazy rendering alone

---

### Who Does Code Splitting?

- **Bundler** (Webpack / Vite / Rollup)

- Triggered by:
  - dynamic imports
  - route boundaries
  - `React.lazy`

React **enables** it — bundler **implements** it.

---

### Without Code Splitting (Baseline)

```javascript
import Dashboard from "./Dashboard";
import Admin from "./Admin";
import Reports from "./Reports";

function App() {
  return <Dashboard />;
}
```

#### What happens

- All components bundled together

- User downloads **everything**

- Even unused routes

---

### With Code Splitting (Dynamic Import)

```javascript
const Dashboard = React.lazy(() => import("./Dashboard"));
```

This tells the bundler:

> “Create a separate chunk for this module.”

---

### Relationship Between Code Splitting & Lazy Loading

| Concept | Responsibility |
| --- | --- |
| Code splitting | Breaking bundles |
| Lazy loading | Loading chunks on demand |

> Lazy loading uses code splitting
Code splitting can exist **without UI logic (**You can split JavaScript **even if there is no conditional rendering, routing, or UI logic involved**.**)**

---

### Most Common Code Splitting Strategies

---

### 1️⃣ Route-based Code Splitting (Best ROI)

```javascript
const Dashboard = React.lazy(() => import("./Dashboard"));

<Route
  path="/dashboard"
  element={
    <Suspense fallback={<Spinner />}>
      <Dashboard />
    </Suspense>
  }
/>
```

#### Why this is powerful

- Users visit few routes

- Huge JS saved upfront

- Massive LCP improvement

---

### 2️⃣ Component-based Code Splitting

```javascript
const Chart = React.lazy(() => import("./HeavyChart"));

{showChart && (
  <Suspense fallback={<p>Loading chart...</p>}>
    <Chart />
  </Suspense>
)}
```

Used for:

- Modals

- Chart

- Admin panels

---

---

### How Code Splitting Works Internally

```javascript
Build time:
→ App.js → main.bundle.js
→ Dashboard.js → dashboard.chunk.js

Runtime:
→ Load main.bundle.js
→ User navigates
→ Load dashboard.chunk.js
```

---

### Code Splitting and Web Vitals

| Metric | Impact |
| --- | --- |
| LCP | ✅ Improves |
| INP | ⚠️ Can worsen if chunks load during interaction |
| CLS | ⚠️ Bad fallback causes layout shift |

---

### Common Mistakes (Very Important)

---

#### 1️⃣ Over-splitting

Too many chunks:

- Network overhead

- Waterfall requests (Series of multiple requests)

---

#### 2️⃣ Splitting above-the-fold content

- Blank UI

- Poor LCP

---

#### 3️⃣ No preloading strategy

```javascript
// Chunk loads only after user clicks
```

Leads to visible delays.

---

### Code Splitting ≠ Performance Guarantee

Splitting helps only when:

- Unused code is avoided

- Critical path is smaller

- Network conditions are reasonable

---

### Code Splitting vs Memoization


---

### When to Use Code Splitting

✅ Large apps

✅ Multiple routes

✅ Feature-based UI

✅ Admin / dashboard apps

---
