# Weekly Assignment

Source: https://app.notion.com/p/2fa1199ccfe380db868bd9898b8f5663

## Theory Questions

| Topic | Question | Basic Hints (How the Answer Should Go) |
| --- | --- | --- |
| React Tree Shaking | What is tree shaking and why is it important in React applications? | Dead code elimination, unused exports removed, smaller bundle size, faster load |
| React Tree Shaking | How does tree shaking work internally? | ES modules, static analysis, import/export, bundler builds dependency graph |
| React Tree Shaking | Why does tree shaking not work well with CommonJS (`require`)? | Dynamic imports, runtime evaluation, no static analysis |
| React Tree Shaking | What coding patterns can break tree shaking? | Barrel files, side effects, importing entire libraries, default exports |
| React Bundler | What is a bundler and why does React need one? | Combine modules, resolve dependencies, optimize assets, dev vs prod |
| React Bundler | How is Vite different from Webpack in development mode? | ES modules, faster cold start, no full bundle on dev, HMR |
| React Bundler | What happens differently in development and production builds? | Minification, tree shaking, source maps, hashing, optimizations |
| React Bundler | What is code splitting and how do bundlers enable it? | Multiple chunks, dynamic imports, load on demand |
| React Routing | How does client-side routing work in React without page reloads? | History API, SPA, route matching, virtual navigation |
| React Routing | Difference between `BrowserRouter` and `HashRouter`? | URL format, server config, SEO, fallback handling |
| React Routing | How does React Router decide which component to render? | Route matching, path patterns, order, nested routes |
| React Lazy Loading | What is lazy loading in React and when should it be used? | Reduce initial bundle, load on demand, routes/components |
| React Lazy Loading | How does `React.lazy()` work with bundlers? | Dynamic `import()`, chunk creation, async loading |
| React Lazy Loading | What is `Suspense` and why is it required? | Fallback UI, loading state, async rendering |
| Accessibility | What does accessibility mean in web applications? | Inclusive design, screen readers, keyboard navigation |
| Accessibility | Common accessibility mistakes in React apps? | Missing labels, non-semantic HTML, div buttons |
| Accessibility | What are ARIA attributes and when should they be used? | Assistive tech support, only when native elements insufficient |
| Web Vitals | What are Core Web Vitals and why are they important? | UX metrics, SEO impact, real user performance |
| Web Vitals | Explain LCP, CLS, and FID/INP with examples | Load speed, layout shift, interactivity |
| Web Vitals | How can React apps improve Web Vitals? | Lazy loading, memoization, image optimization, stable layouts |

## Machine coding problems

| Company | Detailed Problem Description | Tentative Duration |
| --- | --- | --- |
| **Amazon** | Build an infinite-scrolling product results page where products load as the user scrolls. The page must support search by product name and category-based filtering. When search text or filters change, results should reset correctly. Avoid duplicate API calls for the same query and page by caching responses. Handle loading, empty, and error states gracefully while ensuring smooth scrolling without UI jank. *Example: Searching “Shoes” with category “Men” should load page 1, then page 2 on scroll, and reuse cached results if the same query is repeated.* | 40-50 minutes |
| **Meta** | Given a nested JSON object that represents a UI tree, recursively render React elements based on the node type, props, and children. The solution should handle deeply nested structures and unknown node types gracefully. *Example input: **`{ type: "div", props: { className: "box" }, children: [{ type: "button", props: { onClick: handleClick, text: "Click me" } }] }`** should render a div containing a clickable button.* | 35-40 minutes |
| **Google** | Build a search autocomplete input that fetches suggestions as the user types. Suggestions should be cached to prevent repeated network calls for the same query. Support keyboard navigation using Arrow keys, Enter, and Escape, highlight the active option, and close the dropdown on blur or selection.   *Example: Typing “rea” shows suggestions, Arrow Down selects one, Enter confirms it without another API call.* | 45 minutes |
| **Airbnb** | Create a reusable custom React hook for fetching data that caches API responses and prevents duplicate requests across components. The hook should expose loading and error states and provide a way to refresh or invalidate cached data. *Example: Two components requesting **`/users`** should share cached data instead of triggering two API calls.* | 45 minutes |
| **Uber** | Implement a role-based route guarding system using React Router. Some routes should be public while others require authentication and specific roles (e.g., admin or user).   Unauthorized users should be redirected appropriately, and loading states should be handled during auth checks. *Example: A non-admin user attempting to access **`/admin`** is redirected to **`/login`** or **`/unauthorized`**.* | 20-25 minutes |
