# 25th January

Source: https://app.notion.com/p/2ed1199ccfe380d3ad64eba8b00d3bd8



What is super keyword: [https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/super](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/super)

## Class v/s Functional components

Before Hooks, React had **two kinds of components**:

- Class components → state, lifecycle, refs

- Function components → UI only

This caused **real problems**.


#### Problems with Class Components

#### 1. Logic reuse was hard

Sharing logic meant:

- Higher Order Components

- Render props (The "render props" pattern in a React class component is **a technique for sharing code and logic between components using a prop whose value is a function**.)

These led to:

- Wrapper hell

- Hard-to-follow trees

- Indirection

---

#### 2. Lifecycle methods mixed concerns

```javascript
componentDidMount() {
	fetchData();
	setupListener();
}

componentWillUnmount() {
	cleanupListener();
}
```

Unrelated logic lived together.

Related logic was split across methods.

---

#### 3. Classes were harder to reason about

- `this` binding issues

- Complex mental model

- **Harder for new developers**


## What are hooks ?

Hooks allow:

> State and lifecycle logic in function components, using plain functions.

Hooks make logic:

- Reusable

- Composable

- Testable

- Explicit

### Mental Model of Hooks

> Hooks let you “hook into” React’s rendering and state system from functions.


## Different hooks

### 1. `useMemo` — Memoizing Computation

#### Why `useMemo` exists

Every render re-runs the component function.

So expensive calculations re-run too.


#### Scenario

We have an expensive function that depends on `items`.

```javascript
function expensiveCalculation(items) {
  console.log("Expensive calculation running...");
  let total = 0;
  for (let i = 0; i < 100000000; i++) {
    total += items.length;
  }
  return total;
}

function App() {
  const [count, setCount] = React.useState(0);
  const items = [1, 2, 3, 4, 5];

  const total = expensiveCalculation(items);

  return (
    <>
      <p>Total: {total}</p>
      <button onClick={() => setCount(c => c + 1)}>
        Count: {count}
      </button>
    </>
  );
}
```

---

#### What happens here

- Clicking the button updates `count`

- Component **re-renders**

- `expensiveCalculation` runs again

- Even though `items` did NOT change

Console output on every click:

```
Expensive calculation running...
```

---

#### Problem

> Unrelated state updates cause expensive work to re-run.

This wastes CPU and hurts performance.

---

### Same Example WITH `useMemo`

```javascript
function App() {
  const [count, setCount] = React.useState(0);
  const items = [1, 2, 3, 4, 5];

  const total = React.useMemo(() => {
    console.log("Expensive calculation running...");
    let sum = 0;
    for (let i = 0; i < 100000000; i++) {
      sum += items.length;
    }
    return sum;
  }, [items]);

  return (
    <>
      <p>Total: {total}</p>
      <button onClick={() => setCount(c => c + 1)}>
        Count: {count}
      </button>
    </>
  );
}
```

#### What happens now

- First render → calculation runs

- Clicking button updates `count`

- Component **still re-renders**

- BUT `useMemo` returns cached value

- Calculation **does NOT run again**

Console output:

```
Expensive calculation running...// only once
```

**What ****`useMemo`**** actually does **

```javascript
If dependencies unchanged:
  return previous value
Else:
  run function and store result
```

So for the above example:

```javascript
items unchanged → reuse memoized value
```

**Visual mental mode**

```javascript
Render
 → expensiveCalculation
 → Render
 → expensiveCalculation
 → Render
 → expensiveCalculation
```

**With ****`useMemo`**

```javascript
Render
 → expensiveCalculation
 → Render
 → cached value
 → Render
 → cached value
```

### When `useMemo` is useful

✅ Expensive calculations

✅ Derived data

✅ Large arrays / filters / reductions

✅ Preventing unnecessary CPU work


### When `useMemo` is NOT useful

❌ Cheap calculations

❌ Simple expressions

❌ Blindly wrapping everything

Overusing `useMemo` can make code harder to read.


### 2.**`useCallback`**** — Saving Function References**

`useCallback` memoizes a **function reference** so it doesn’t change across renders unless dependencies change.

### Important clarification

- `useCallback` **does NOT stop re-render**

- `useCallback` **stops function re-creation**

- It mainly helps when passing callbacks to **memoized children**


#### **Example WITHOUT ****`useCallback`**
