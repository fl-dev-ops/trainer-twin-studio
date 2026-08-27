# 11th January - Hoisting & Closure

Source: https://app.notion.com/p/2de1199ccfe3801dab58d56ee106be53


## Topic 1: Hoisting

### What is Hoisting?

> Hoisting is JavaScript’s behavior of processing declarations before executing code.

In simple terms:

- JavaScript **knows about variables and functions before running the code**

- This happens during the **memory creation phase** of an execution context

Hoisting is **not** moving code upward — it is **preparing memory upfront**.

---

### Why Hoisting Exists

Hoisting is a **side effect** of how JavaScript creates execution contexts.

Before execution:

- Memory is allocated

- Identifiers are registered

- Scope is set up

This allows:

- Function calls before their definition

- Predictable scope resolution

---

### Hoisting by Declaration Type

---

#### `var` Hoisting

```javascript
console.log(a);
var a = 10;
```

What happens:

- `a` is hoisted

- Initialized with `undefined`

- Assigned `10` during execution

So:

```javascript
console.log(a); // undefined
```

📌 Key point:

> var is hoisted and initialized with undefined

---

#### Function Declaration Hoisting

```javascript
sayHi();

function sayHi() {
   console.log("Hi");
}
```

What happens:

- Entire function is hoisted

- Function can be called before declaration

📌 Key point:

> Function declarations are fully hoisted

---

#### `let` and `const` Hoisting

```javascript
console.log(b);
let b = 20
```

Result:

```
ReferenceError: Cannot access 'b' before initialization
```

What happens:

- `b` is hoisted

- But **not initialized**

- Exists in **Temporal Dead Zone (TDZ)**

📌 Key point:

> let and const are hoisted but not usable before initialization

---

#### Function Expressions

```javascript
sayHello();

var sayHello = function () {
   console.log("Hello");
};
```

What happens:

- `sayHello` is hoisted as `undefined`

- Function body is not hoisted

Result:

```
TypeError: sayHello is not a function
```

📌 Key point

> Function expressions follow variable hoisting rules

---

### Temporal Dead Zone (TDZ) — High Level

> TDZ is the time between entering a scope and initializing a let or const variable.

- Variable exists

- But cannot be accessed

- Prevents accidental usage before declaration

---

TDZ is **not a special zone in memory**.

It is:

- A **state** of a binding

- Between **hoisting** and **initialization**

```javascript
{
// TDZ starts
console.log(a); // ReferenceError
let a =10;
// TDZ ends
}
```

### Hoisting Summary Table

| Declaration Type | Hoisted | Initialized | Accessible Before Line |
| --- | --- | --- | --- |
| `var` | Yes | `undefined` | Yes |
| `let` | Yes | No (TDZ) | No |
| `const` | Yes | No (TDZ) | No |
| Function Declaration | Yes | Yes | Yes |
| Function Expression | Yes (var) | `undefined` | No |

---

### Common Misconceptions (Clear These)

❌ “Hoisting moves code to the top”

✅ Hoisting prepares memory before execution

❌ “`let` and `const` are not hoisted”

✅ They are hoisted but kept in TDZ

❌ “Hoisting happens line by line”

✅ Hoisting happens per execution context

---

### One-Line Wrap-Up

> “Hoisting is JavaScript registering declarations during the memory creation phase of execution.”




## Topic 2: Lexical Environment & Closures

---

### Lexical Environment

---

### Definition

A **Lexical Environment** is an internal data structure used by JavaScript to store variable bindings and resolve identifiers.

Every execution context is associated with a lexical environment.

---

### Structure of a Lexical Environment


A lexical environment consists of:

1. **Environment Record**
