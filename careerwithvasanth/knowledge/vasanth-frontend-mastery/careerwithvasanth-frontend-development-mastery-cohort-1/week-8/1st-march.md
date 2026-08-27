# 1st March

Source: https://app.notion.com/p/3151199ccfe3809a8793c8730a620a33

## Operational Transformation

## 📝 Initial Document (Version V0)

```
Hello World
```

Character positions:

```
0 1 2 3 4 5 6 7 8 9 10
H e l l o _ W o r l d
```

---

## 👥 Two Users Edit at the Same Time

Both start from **Version V0**

---

### 👤 User A Operation

**Insert "Beautiful " at position 6**

Operation A:

```
Insert("Beautiful ", pos 6)
```

Local view (User A sees immediately):

```
Hello Beautiful World
```

---

### 👤 User B Operation

**Delete "World" starting at position 6**

Operation B:

```
Delete(5 chars from pos 6)
```

Local view (User B sees immediately):

```
Hello
```

---

## ⚠️ Now Both Operations Reach Server

Assume:

Server receives **A first**, then **B**

---

## 🔵 Step 1 — Server Applies A

Server document becomes:

```
Hello Beautiful World
```

New positions:

```
H e l l o _ B e a u t i f u l _ W o r l d
0 1 2 3 4 5 6 7 8 9 ...
```

"World" is no longer at position 6.

It moved right by 10 characters.

---

## 🔴 Step 2 — Server Receives B (Created on Old Version)

B says:

```
Delete 5 chars at pos 6
```

But position 6 now points to:

```
B (start of "Beautiful")
```

That’s wrong.

---

## 🧠 Operational Transformation Happens

Server transforms B relative to A.

A inserted 10 characters before B’s delete position.

So shift B’s position right by 10:

```
Old pos: 6
New pos: 6 + 10 = 16
```

Transformed operation:

```
Delete(5 chars from pos 16)
```

---

## 🔵 Step 3 — Server Applies Transformed B

Result:

```
Hello Beautiful
```

---

## 📊 Vertical Flow Diagram

```
INITIAL (V0)
-------------------
Hello World
-------------------

User A:
Insert "Beautiful " @6
Local A view:
Hello Beautiful World

User B:
Delete 5 chars @6
Local B view:
Hello

-------------------
SERVER PROCESSING
-------------------

Step 1: Apply A
Hello Beautiful World

Step 2: Transform B
Original B: Delete @6
Transformed B: Delete @16

Step 3: Apply Transformed B
Hello Beautiful

-------------------
FINAL STATE (All users)
-------------------
Hello Beautiful
```

---

## 🧩 Before & After Summary

#### Before (V0)

```
Hello World
```

#### After User A (intermediate)

```
Hello Beautiful World
```

#### After OT + User B

```
Hello Beautiful
```

Both users converge to same final state.

---

## 🧠 What OT Actually Did

It didn’t change the meaning of B’s action.

B intended to delete "World".

OT simply adjusted the position so that:

👉 B still deletes "World"

👉 Even though A inserted text before it

That’s the key idea.

---

## 🎯 One-Sentence Intuition

Operational Transformation shifts or adjusts operations so that each user’s intent is preserved even when edits arrive in different orders.


## How OT works with media items ?

OT was originally designed for **linear text**, but systems like Google Docs, Figma, etc. handle:

- Flow diagrams

- Tables

- Images

- Shapes

- Layouts

So how does OT work there?

Let’s break it clearly.

---

## 🧠 First Principle

OT does NOT operate on “text only”.

It operates on **operations applied to a structured document model**.

So the key idea is:

👉 Represent everything (text, image, shape, table) as operations on a data model.

Once you do that → OT can transform those operations.

---

## 🧱 Step 1 — Represent Visual Items as Structured Data

Example: Flow Diagram

Instead of thinking visually, think data:

```
{
  "nodes": {
    "n1": { "x":100, "y":200, "text":"Start" },
    "n2": { "x":300, "y":200, "text":"End" }
  },
  "edges": [
    { "from":"n1", "to":"n2" }
  ]
}
```

Everything becomes structured state.

---
