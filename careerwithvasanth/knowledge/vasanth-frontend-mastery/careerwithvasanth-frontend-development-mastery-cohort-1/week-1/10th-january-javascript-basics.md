# 10th January - JavaScript Basics

Source: https://app.notion.com/p/2dc1199ccfe380498e30fcdba9f39612



Scope of Session 1: JavaScript Execution, Scope & Hoisting


## Topic 1: What is JavaScript Runtime?

JavaScript Runtime is the environment in which JavaScript code runs.


In a browser, the JavaScript runtime is made up of:

- **JavaScript Engine**

- **Browser Capabilities**
  - **Browser Web APIs**
  - **Queues**
  - **Event Loop**


JavaScript by itself is:

- Single-threaded

- Synchronous by default


Asynchronous behavior comes from the **browser runtime**, not from JavaScript itself.

---

### JavaScript Engine

The JavaScript Engine is responsible for executing JavaScript code.

Ex: **V8 **(**Chrome** browser), JavaScriptCore (JSC) ( **Safari** ), **Chakra** (Legacy browsers like internet explorer)


**It contains  two main components:**

#### Memory Heap

- Stores variables, objects, and functions

#### Call Stack

- Executes JavaScript code

- Follows **Last In, First Out (LIFO)** order

- Only one piece of code executes at a time

---

### Call Stack Execution

The call stack manages function execution order.

Example:

```javascript
function a() {
  b();
}

function b() {
  console.log("Hello");
}

a();
```

Execution flow:

- `a()` is pushed onto the stack

- `b()` is pushed onto the stack

- `console.log()` executes

- Functions complete and are popped off the stack

If the call stack is blocked, no other JavaScript code can execute.

---

### Browser Web APIs


Browsers provide additional capabilities to JavaScript through Web APIs.

Common Web APIs include:

- `setTimeout`

- `setInterval`

- `fetch`

- DOM events

- Geolocation

- Web Storage

JavaScript delegates asynchronous work to these Web APIs and continues execution.

Example:

```javascript
setTimeout(() => {
	console.log("Hello");
},2000);
```

Execution flow:

- JavaScript registers the timer

- Browser Web API handles the timer

- JavaScript continues running without waiting

---

### Task Queues


When Web APIs complete their work, callbacks are placed into queues.

#### Microtask Queue

- Contains:
  - `Promise.then`
  - `async/await`
  - `queueMicrotask` (schedules a specified function to be executed as a microtask)
  - `MutationObserver` (is a built-in JavaScript Web API that provides the ability to watch for changes being made to the DOM tree and execute a specified callback function when those changes occur)

#### Macrotask Queue

- Lower priority queue

- Contains:
  - `setTimeout`
  - `setInterval`
  - DOM events

Microtasks are always executed before macrotasks.

---

### Event Loop



The event loop continuously checks the call stack and queues.

**Execution order:**

1. **Call stack must be empty**

1. **Execute all microtasks**

1. **Execute one macrotask**

1. **Repeat the cycle**


The event loop coordinates execution between the call stack and queues.

---

### Complete Execution Example

```javascript
console.log("A");

setTimeout(() => {
   console.log("B");
},0);

Promise.resolve().then(() => {
   console.log("C");
});

console.log("D");
```

Execution order:

- `A` is logged

- `setTimeout` callback is registered with Web API

- Promise callback is added to microtask queue

- `D` is logged

- Call stack becomes empty

- Microtask queue executes → `C`

- Macrotask queue executes → `B`

Final Output:

```
A
D
C
B
```

---

### Key Takeaways

- JavaScript executes code using a single call stack

- Asynchronous operations are handled by browser Web APIs

- Microtasks have higher priority than macrotasks

- Event loop decides execution order

- `setTimeout(0)` does not mean immediate execution

---
