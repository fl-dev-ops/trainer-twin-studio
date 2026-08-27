# 18th January

Source: https://app.notion.com/p/2e51199ccfe38047abe0e06b74dee8c0


## Topic 1: Inheritance in JavaScript

---

### Definition

JavaScript uses **prototype-based inheritance**.

Objects inherit properties and methods from other objects through a prototype chain.

Unlike classical languages, JavaScript does **not** use class-based inheritance internally — it uses prototypes.

---

Link to one of my first Medium article about the prototype inheritance: [https://careerwithvasanth.medium.com/prototype-and-protypal-inheritance-in-javascript-bb766097ac05](https://careerwithvasanth.medium.com/prototype-and-protypal-inheritance-in-javascript-bb766097ac05)


### Prototype

Every JavaScript object has an internal reference called `[[Prototype]]` (accessible via `__proto__` or `Object.getPrototypeOf`).

This reference points to another object from which properties are inherited.

---

### Prototype Chain

When accessing a property:

1. JavaScript looks on the object itself

1. If not found, it looks on its prototype

1. Continues up the chain

1. Stops at `null`

This lookup path is called the **prototype chain**.

---

### Basic Example

```javascript
const parent = {
	greet() {
		return "Hello";
  }
};

const child = {
		__proto__: parent
};

console.log(child.greet());// Hello
```

`child` inherits `greet` from `parent`.

---

### Using `Object.create`

```javascript
const parent = {
	greet() {
		return "Hello";
  }
};

const child = Object.create(parent);

console.log(child.greet()); // Hello
```

`Object.create` creates a new object with the specified prototype.

---

### Constructor Functions and Prototypes

The power of prototypes is that we can reuse a set of properties if they should be present on every instance — especially for methods. Suppose we are to create a series of boxes, where each box is an object that contains a value which can be accessed through a `getValue` function. A naive implementation would be:

```javascript
const boxes = [
  { value: 1, getValue() { return this.value; } },
  { value: 2, getValue() { return this.value; } },
  { value: 3, getValue() { return this.value; } },
];
```

This is subpar, because each instance has its own function property that does the same thing, which is redundant and unnecessary. Instead, we can move `getValue` to the `[[Prototype]]` of all boxes:

```javascript
const boxPrototype = {
  getValue() {
    return this.value;
  },
};

const boxes = [
  { value: 1, __proto__: boxPrototype },
  { value: 2, __proto__: boxPrototype },
  { value: 3, __proto__: boxPrototype },
];
```

---

This way, all boxes `getValue` method will refer to the same function, lowering memory usage. However, manually binding the `__proto__` for every object creation is still very inconvenient. This is when we would use a *constructor* function, which automatically sets the `[[Prototype]]` for every object manufactured. Constructors are functions called with [`new`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/new).

### Final code

```javascript
// A constructor function

function Box(value) {
  this.value = value;
}

// Properties all boxes created from the Box() constructor
// will have
Box.prototype.getValue = function () {
  return this.value;
};

const boxes = [new Box(1), new Box(2), new Box(3)];
```


Above code can be visualised as

```javascript
function Box(value) {
  this.value = value;
  this.getValue = function () {
    return this.value;
  };
}
```

### How `new` Works

Internally:

1. Creates a new empty object

1. Sets its prototype to `Box.prototype`

1. Binds `this` to that object

1. Returns the object

### Class equivalent of above code

```javascript
class Box {
  constructor(value) {
    this.value = value;
  }

  // Methods are created on Box.prototype
  getValue() {
    return this.value;
  }
}
```

Because `Box.prototype` references the same object as the `[[Prototype]]` of all instances, we can change the behavior of all instances by mutating `Box.prototype`.

```javascript
function Box(value) {
  this.value = value;
}
Box.prototype.getValue = function () {
  return this.value;
};
const box = new Box(1);

// Mutate Box.prototype after an instance has already been created
Box.prototype.getValue = function () {
  return this.value + 1;
};
box.getValue(); // 2
```

---

### Prototype vs Instance Properties

```javascript
function Car(model) {
	this.model = model;
}

Car.prototype.drive = function () {
	return "Driving " + this.model;
};

const c = new Car("BMW")
```

- `model` → instance property

- `drive` → prototype property

---

### Property Lookup Example

```javascript
console.log(c.drive());
```

Lookup order:

1. `c.drive` → not found

1. `Car.prototype.drive` → found

---

### Prototype Chain End

```javascript
Object.prototype.__proto__ === null;
```

This is the end of every prototype chain.

---

### Common Mistakes

- Modifying prototypes of built-in objects

- Forgetting to reset constructor after inheritance

- Confusing class syntax with class-based inheritance

---

### When to Use Prototype Inheritance

- Sharing methods between instances

- Memory-efficient method storage

- Extending behavior across related objects

---

### Memory Advantage

Prototype methods are stored **once**, not per instance.

---

### Summary

- JavaScript uses prototype-based inheritance

- Objects inherit through prototype chains

- Constructor functions link via prototypes

- Class syntax is syntactic sugar over prototypes

- Property lookup follows the prototype chain

- Prototypes enable memory-efficient inheritance

---

### One-Line Wrap-Up

> JavaScript inheritance works through prototype chains, not class hierarchies.



## Topic 2: Shallow vs deep copy

### Definition

A **copy** of an object or array can be created in two ways:

- **Shallow Copy** — copies only the first level of properties

- **Deep Copy** — copies all nested levels recursively

---

### Shallow Copy
