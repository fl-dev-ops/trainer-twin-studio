# 17th January

Source: https://app.notion.com/p/2de1199ccfe380a48910cfcc861a1de1


## Topic 1

New participant introduction

Results of quiz

Updates on thought provoking question

Number of DSA problems solved

## Topic 2 - Revision

### 1️⃣ JavaScript Runtime (Browser)

- JavaScript is **single-threaded** and **synchronous by default**

- Browser provides:
  - Web APIs
  - Task Queues (Microtask & Macrotask)
  - Event Loop

- JavaScript Engine:
  - Call Stack
  - Memory Heap

- Only the **JS Engine executes code**

- Event Loop **schedules**, does not execute

- Microtasks have **higher priority** than macrotasks

- Each browser tab has its **own runtime and event loop**

---

### 2️⃣ Execution Context

- Execution Context = environment where code runs

- Types:
  - Global Execution Context (one per environment)
  - Function Execution Context (one per function call)

- Each execution context has:
  - Memory Creation Phase
  - Code Execution Phase

- Global Execution Context:
  - Created first
  - Stays at bottom of call stack

- Function Execution Context:
  - Created on function invocation
  - Destroyed after execution

- Call Stack manages execution contexts

---

### 3️⃣ Hoisting

- Hoisting happens during **memory creation phase**

- Hoisting ≠ moving code

- `var`:
  - Hoisted
  - Initialized as `undefined`

- `let` / `const`:
  - Hoisted
  - Not initialized (TDZ)

- Function declarations:
  - Fully hoisted

- Function expressions:
  - Hoisted as variables

- Hoisting is **scope-specific**

---

### 4️⃣ Lexical Environment & Closures

- Lexical Environment:
  - Environment Record
  - Outer Lexical Environment Reference

- Scope resolution follows **lexical scope**

- Closures:
  - Function + retained lexical environment

- Closures keep **lexical environments**, not execution contexts

- Closures allow:
  - Data encapsulation
  - Function factories
  - Callbacks

- Closures can extend variable lifetime

- Improper closures can cause memory retention

---

### One-Line Week 1 Summary

> JavaScript execution is driven by runtime scheduling, context creation, scope resolution, and memory retention through closures.



## Topic 3: call, apply and bind

### The real problem they solve (WHY they exist)

In JavaScript, **`this`**** is not fixed**.

Its value depends on **how a function is called**, not where it is written.

This leads to problems like:

- Losing `this` when passing functions around

- Wanting to explicitly control `this`

- Borrowing methods from other objects

👉 **`call`****, ****`apply`****, and ****`bind`**** exist to explicitly control ****`this`****.**

That’s the core reason.

Everything else is secondary.


```javascript
const user = {
		name: "Vasanth",
		greet() {
			console.log("Hello, " + [this.name](http://this.name/));
		}
};

const greetFn = user.greet;
greetFn();
```

The output for this is.

```javascript
Hello undefined
```

---

### What actually changes?

| user.greet() | greetFn() |
| --- | --- |
| method call | normal function call |
| implicit binding | default binding |
| this = user | this = undefined / window |

## Is closure involved?

❌ **No. This problem has NOTHING to do with closure.**

Closure is about **variable access via lexical scope**.

`this` is **not lexical**.

`this` is **runtime bound**.

So even though `greet` is defined inside `user`, it does **not** close over `user`.


### What are `call`, `apply`, and `bind` (WHAT)

All three are **methods available on functions**.

They allow you to:

> Invoke a function with an explicitly defined this value.
