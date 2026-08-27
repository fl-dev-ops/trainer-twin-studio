# 8th February

Source: https://app.notion.com/p/2f91199ccfe38072b413d8d68214b2fc



## Topic 1:  Error Boundaries in React

---

### Why Error Boundaries Exist

In a React app, if a **JavaScript error occurs during rendering**, the **entire component tree can crash**, resulting in a blank screen.

> Error Boundaries prevent a full app crash by catching errors and rendering a fallback UI instead.

Think of them as **try/catch for React UI rendering**.

---

### What is an Error Boundary?

> An Error Boundary is a React component that catches JavaScript errors in its child component tree and displays a fallback UI.

Important:

- They catch **render-time errors**

- They **do not catch all errors** (details below)

---

### What Errors Do Error Boundaries Catch?

✅ Errors during:

- Rendering

- Lifecycle methods

- Constructors of child components

❌ Errors in:

- Event handlers

- Async code (`setTimeout`, `Promise`)

- Server-side rendering

- Errors inside the error boundary itself

---

### Why Error Boundaries Use Class Components

> Currently, Error Boundaries can only be implemented using class components.

Reason:

- They rely on lifecycle methods:
  - `componentDidCatch` : A lifecycle method used to **log error details or report them to monitoring tools** after an error is caught.
  - `getDerivedStateFromError` : A static method used to **update state and render fallback UI** when an error occurs during rendering.


There is **no functional equivalent yet** (as of today).

---

### Basic Error Boundary Example

```javascript
import React from "react";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error("Error caught:", error, info);
  }

  render() {
    if (this.state.hasError) {
      return <h2>Something went wrong.</h2>;
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
```

---

### How to Use an Error Boundary

```javascript
<ErrorBoundary>
	<Profile />
</ErrorBoundary>
```

Profile component:

```javascript
function Profile() {
  const user = null;

  // ❌ This will throw a runtime error
  return <h3>User name: {user.name}</h3>;
}

export default Profile;
```

If `Profile` crashes:

- App does NOT crash

- Fallback UI is shown

---

### Granularity Matters (Very Important)

#### ❌ Bad Pattern (One global boundary)

```javascript
<ErrorBoundary>
	<App />
</ErrorBoundary>
```

- One error → whole app replaced

- Poor UX

---

#### ✅ Better Pattern (Feature-level boundaries)

```javascript
<ErrorBoundary>
	<Dashboard />
</ErrorBoundary>

<ErrorBoundary>
	<Profile />
</ErrorBoundary>
```

- One section fails

- Rest of the app keeps working

---

### Error Boundary vs try/catch

| try/catch | Error Boundary |
| --- | --- |
| Catches JS logic errors | Catches render errors |
| Imperative | Declarative |
| Local scope | Component tree scope |

---

### Error Boundaries and Event Handlers

This will **NOT** be caught:

```javascript
<button onClick={() => {
  throw new Error("Click error");
}}>
  Click
</button>
```

Why?

- Event handlers already run inside JS `try/catch`

- React expects you to handle them manually

---

### Handling Async Errors

```javascript
fetchData().catch(error => {
	setError(error);
});
```

Async errors must be handled **explicitly**.

---

### Error Boundaries in Real Applications

Common usage:

- Wrap routes

- Wrap lazy-loaded components

- Wrap third-party widgets

```javascript
<Suspense fallback={<Loading />}>
  <ErrorBoundary>
    <LazyComponent />
  </ErrorBoundary>
</Suspense>
```

---

### Error Boundary + Lazy Loading (Best Practice)

- `Suspense` handles loading

- `ErrorBoundary` handles crashes

They solve **different problems**.

---

### Common Interview Pitfalls

❌ Error Boundaries catch all errors

❌ Error Boundaries replace try/catch

❌ Functional components can define error boundaries

✅ Only render-time errors

✅ Class-based only

✅ Used for UI resilience




## Topic 2: Scalable project folder structure


```javascript
src/
├── app/
│   ├── App.tsx                 # Root component
│   ├── store.ts                # Redux store (RTK)
│   ├── rootReducer.ts
│   └── providers.tsx           # Global providers
│
├── routes/
│   └── index.tsx               # App routing (React Router)
│
├── features/
│   ├── auth/
│   │   ├── AuthPage.tsx        # Page (route-level)
│   │   ├── LoginForm.tsx
│   │   ├── authSlice.ts
│   │   ├── authAPI.ts
│   │   ├── useAuth.ts
│   │   ├── auth.utils.ts
│   │   └── index.ts            # Public exports
│   │
│   ├── feed/
│   │   ├── FeedPage.tsx
│   │   ├── FeedList.tsx
│   │   ├── FeedItem.tsx
│   │   ├── feedSlice.ts
│   │   ├── useFeed.ts
│   │   ├── feed.utils.ts
│   │   └── index.ts
│   │
│   └── profile/
│       ├── ProfilePage.tsx
│       ├── ProfileCard.tsx
│       ├── profileSlice.ts
│       ├── useProfile.ts
│       ├── profile.utils.ts
│       └── index.ts
│
├── shared/
│   ├── components/
│   │   ├── EmptyState.tsx
│   │   ├── ErrorMessage.tsx
│   │   └── Pagination.tsx
│   │
│   ├── hooks/
│   │   ├── useDebounce.ts
│   │   └── useIntersection.ts
│   │
│   └── utils/
│       ├── date.ts
│       └── number.ts
│
├── components/                 # Truly global, generic UI, global components/ should be mostly dumb, but “dumb” doesn’t mean “stupid.”
│   ├── Button.tsx
│   ├── Modal.tsx
│   ├── Input.tsx
│   ├── Loader.tsx
│   └── Toast.tsx
│
├── hooks/                      # Truly global hooks
│   ├── useWindowSize.ts
│   └── useOnlineStatus.ts
│
├── services/
│   ├── httpClient.ts           # Axios / fetch wrapper
│   ├── authService.ts
│   └── apiConfig.ts
│
├── styles/
│   ├── global.css
│   └── variables.css
│
├── utils/                      # App-wide utilities
│   ├── constants.ts
│   └── env.ts
│
├── assets/
│   └── images/
│
└── index.tsx                   # Entry point
```



## Session problem:


- Create square views in the shape of ?C? as shown in the below image. They have the colour white.

- Upon clicking one square, it should turn green.
