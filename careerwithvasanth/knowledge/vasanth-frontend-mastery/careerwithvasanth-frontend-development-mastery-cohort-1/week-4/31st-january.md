# 31st January

Source: https://app.notion.com/p/2f21199ccfe3801dab25d4b490752709



## React Routing — Navigating Without Reloading the Page

---

Code sandbox link: [https://codesandbox.io/p/sandbox/careerwithvasanthcohort1reactcoderepo-qs3j72?file=%2Fsrc%2Findex.tsx%3A9%2C21](https://codesandbox.io/p/sandbox/careerwithvasanthcohort1reactcoderepo-qs3j72?file=%2Fsrc%2Findex.tsx%3A9%2C21)

### Why Routing Is Needed in React

In traditional websites:

- Each URL change → full page reload

- Browser requests a new HTML page from the server

In modern React apps:

- We want **multiple views**

- Without **reloading the page**

- While keeping URLs meaningful

Routing answers this:

> How do we change views based on the URL without reloading the page?

---

### What Is Routing in React?

> Routing maps URLs to React components.

Example:

- `/` → Home component

- `/login` → Login component

- `/profile` → Profile component

All handled **on the client side**.

---

### Client-Side Routing vs Server-Side Routing

#### Server-Side Routing (Traditional)

```
/about →serverreturns about.html
```

- Full page reload

- Slower navigation

---

#### Client-Side Routing (React)

```
/about → React swaps components
```

- No page reload

- Faster navigation

- SPA (Single Page Application)

---

### How React Routing Works (Conceptually)

```
URLchanges
	→ Routerdetectschange
	→ Matchingcomponentrendered
	→ DOMupdated
```

The browser **URL changes**, but the page does not reload.

---

### Popular Routing Library

> React Router (most widely used)

Key concepts apply to routing in general

---

### Core Routing Components

---

#### 1️⃣ Router

> Listens to URL changes and provides routing context.
Common types:

- `BrowserRouter` (most common, it is **a core component in the React Router library used to enable client-side navigation and routing in web applications**)

- `HashRouter` (older / limited cases)

```javascript
<BrowserRouter>
	<App />
</BrowserRouter>
```

---

#### 2️⃣ Routes & Route

> Define which component renders for which path.

```javascript
<Routes>
   <Route path="/" element={<Home />} />
   <Route path="/login" element={<Login />} />
</Routes>
```

---

#### 3️⃣ Link (Navigation)

> Changes URL without page reload.

```javascript
<Link to="/login">Login</Link
```

❌ Don’t use `<a href>` for internal navigation.

---

### Route Matching (Important Concept)

- React Router matches **path → component**

- Matching is **top to bottom**

- More specific routes should come first

---

### Dynamic Routes

> Used when URL contains variable data.

```javascript
<Route path="/users/:id" element={<User />} />
```

```javascript
// /users/42
id = 42
```

---

### Accessing Route Params

```javascript
const { id } = useParams();
```

---

### Nested Routes (Layouts)

> Useful for dashboards, layouts, tabs.

```javascript
<Route path="/dashboard" element={<Dashboard />}>
	<Route path="settings" element={<Settings />} />
</Route>
```

```
/dashboard/settings
```

---

### Programmatic Navigation

> Navigate via code (not clicks).

```javascript
const navigate = useNavigate();
navigate("/login");
```

Common use cases:

- After login

- After form submission

---

### Routing and Component Lifecycle

Important behavior:

- Route change ≠ page reload

- Component mounts/unmounts based on route

- State resets unless preserved


### Simple router example:


```javascript
import React from "react";
import { BrowserRouter, Routes, Route, Link } from "react-router-dom";

function Home() {
  return <h2>Home Page</h2>;
}

function About() {
  return <h2>About Page</h2>;
}

function Contact() {
  return <h2>Contact Page</h2>;
}

export default function App() {
  return (
    <BrowserRouter>
      <nav style={{ marginBottom: "20px" }}>
        <Link to="/" style={{ marginRight: "10px" }}>
          Home
        </Link>
        <Link to="/about" style={{ marginRight: "10px" }}>
          About
        </Link>
        <Link to="/contact">Contact</Link>
      </nav>

      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
        <Route path="/contact" element={<Contact />} />
      </Routes>
    </BrowserRouter>
  );
}
```


### Routing Structure in a Large-Scale React Application

---

#### The Core Principle

> Structure routes by features (domains), not by URL paths or components.
