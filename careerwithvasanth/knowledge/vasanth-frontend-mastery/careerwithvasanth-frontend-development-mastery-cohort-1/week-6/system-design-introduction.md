# System design Introduction

Source: https://app.notion.com/p/3061199ccfe3807a9874d96be1d4336d



## General interview Formats

### 1️⃣ Deep Dive Into One System (End-to-End Design)

Candidate designs a full system:

- Functional requirements

- Non-functional requirements

- Architecture decisions

- Trade-offs

- Scaling strategy

Examples:

- Design Google Docs frontend

- Design Instagram feed UI

- Design Netflix homepage

Focus:

👉 breadth + depth + reasoning

---

### 2️⃣ Scenario-Driven Problem Solving

Also very common.

Interviewer gives targeted scenarios:

- Performance bottleneck

- State explosion

- Data consistency issue

- Rendering problem

Examples:

- How to render 1M rows?

- How to handle offline edits?

- How to prevent duplicate API calls?

Focus:

👉 applied problem solving

---

### 3️⃣ Debug / Improve an Existing Architecture

Candidate is given a system that already exists but has issues.

Task:

- Identify bottlenecks

- Refactor architecture

- Improve performance

- Suggest migration strategy

Examples:

- App re-renders too often

- Bundle size too large

- API layer messy

- State management broken

Focus:

👉 real-world engineering maturity

This is extremely popular in staff/principal interviews.



## Topic 1: Different architectural patterns

### 🎯 Why Frontend Architecture Matters

As applications grow:

- More features

- More teams

- Faster releases

- Independent deployments

- Technology diversity

Without a proper architecture, projects become:

❌ tightly coupled

❌ hard to scale

❌ slow to deploy

❌ difficult to maintain

Frontend architecture defines:

> How code is structured, built, owned, and deployed at scale.

---

## 1️⃣ Monolithic Frontend Architecture

### What is it?

A **single frontend application** containing all features, pages, and UI modules in one codebase and one build.

Everything ships together.

---

### Structure (Typical React SPA)

```
src/
  components/
  pages/
  hooks/
  utils/
  services/
  store/
```

Single build output:

```
bundle.jsindex.html
```

---

### How it works

```
One repository
↓
One build pipeline
↓
One deployment
↓
Whole app updated together
```

---

### Advantages

✅ Simple to start

✅ Easy dependency management

✅ Shared state straightforward

✅ Fast local development

✅ No cross-app communication

---

### Limitations (at scale)

❌ Large bundle size

❌ Slow builds

❌ Teams block each other

❌ Risky deployments

❌ Hard to adopt different tech stacks

❌ Code ownership unclear

---

### Best suited for

- Small to medium apps

- Single team

- Early stage product

- Tight feature coupling

---

### Example (Monolithic React App)

```javascript
// App.jsx
import Dashboard from "./pages/Dashboard";
import Orders from "./pages/Orders";
import Profile from "./pages/Profile";

export default function App() {
  return (
    <>
      <Dashboard />
      <Orders />
      <Profile />
    </>
  );
}
```
