# 7th February

Source: https://app.notion.com/p/2f91199ccfe380238489f4f137eda47b


## **Web Storage in React / Web Applications**

Modern web apps need to **store data on the client** for:

- authentication

- preferences

- caching

- session continuity

The web platform provides **three primary storage mechanisms**:

1. Cookies

1. Session Storage

1. Local Storage

---

## 1️⃣ Cookies

#### What are Cookies?

> Cookies are small pieces of data stored by the browser and sent to the server with every HTTP request.

They are the **oldest storage mechanism** on the web.

”Cookies in React are **not a React feature** — they are a **browser + HTTP mechanism** that React apps interact with.”

**Size: 4096 KB**

---

#### Key Characteristics

- Stored in the browser

- Automatically sent to server with requests

- Small size (~4KB)

- Can have expiration rules

---

#### Common Use Cases

- Authentication (session tokens)

- Server-side sessions

- Tracking (analytics, personalization)

---

#### Cookie Types

#### Session Cookies

- Deleted when browser closes

- No explicit expiry

#### Persistent Cookies

- Have expiration date

- Stored across sessions

---

#### Cookie Example

```javascript
document.cookie = "theme=dark; max-age=3600";
```

---

#### Pros

✅ Server can read them

✅ Works with SSR

✅ Can be secured (`HttpOnly`, `Secure`)

---

#### Cons

❌ Sent on every request (performance overhead)

❌ Very limited size

❌ Vulnerable if misused (XSS, CSRF)

---

#### Security Flags (Important)

- `HttpOnly` → JS cannot access

- `Secure` → HTTPS only

- `SameSite` → CSRF protection

---

#### When Cookies Are Used in React Apps

#### Most common use cases

- Authentication sessions

- Remembering login state

- CSRF protection

- SSR-compatible auth


#### Authentication flow using the cookies

```javascript
User logs in
→ Server sets HttpOnly cookie
→ Browser stores it
→ React never touches the token
→ API requests automatically include cookie
```


### How server sets HttpOnly Cookie ?

> **Only the server can set ****`HttpOnly`**** cookies. JavaScript cannot.**

This is done using the **`Set-Cookie`**** HTTP response header**.

---

### High-Level Flow

```
Client (React) → sends login request
Server → validates credentials
Server → sends Set-Cookie header (HttpOnly)
Browser → stores cookie securely
Browser → auto-sends cookie on next requests
```

React **never sees the cookie value**.

---

### Example : Express / Node.js

#### Login API (Server)

```javascript
app.post("/login", (req, res) => {
  const { username, password } = req.body;

  // Validate user (simplified)
  if (username === "admin" && password === "secret") {
    res.cookie("sessionId", "abc123", {
      httpOnly: true,      // JS cannot access
      secure: true,        // HTTPS only
      sameSite: "lax",// CSRF protection strict, lax and none are possible values
      maxAge: 24 * 60 * 60 * 1000 // 1 day
    });

    res.json({ success: true });
  } else {
    res.status(401).json({ error: "Invalid credentials" });
  }
});
```

#### What the server actually sends

```
Set-Cookie: sessionId=abc123;
HttpOnly;
Secure;
SameSite=Lax;
Max-Age=86400;
Path=/
```

### Why This Is the Preferred Auth Pattern

- Tokens never touch JavaScript

- Protected from XSS

- Works well with SSR

- Industry best practice


### Variations of the cookies summarised:

| Attribute | Possible Values | What it Controls | Typical Use |
| --- | --- | --- | --- |
| **HttpOnly** | `true / false` | Blocks JavaScript access to cookie | Auth / session tokens |
| **Secure** | `true / false` | Sends cookie only over HTTPS | Production security |
| **SameSite** | `Strict` | Sent only for same-site requests | High-security apps |
|  | `Lax` *(default)* | Sent for same-site + top-level navigation | Standard auth cookies |
|  | `None` *(requires Secure)* | Sent with all requests (cross-site) | Embedded / third-party apps |
| **Max-Age** | Seconds (e.g. `3600`) | Relative lifetime of cookie | Persistent sessions |
| **Expires** | Date (UTC) | Absolute expiry time | Legacy support |
| **Path** | URL path (e.g. `/dashboard`) | Limits cookie to specific routes | Route-scoped cookies |
| **Domain** | Domain name | Shares cookie across subdomains | Multi-subdomain apps |

#### **SameSite variations explained:**

#### **→ Strict**

Ex:

```javascript
Set-Cookie: sessionId=abc; SameSite=Strict
```

```javascript
User logged in on example.com
↓
Clicks a link in Gmail to example.com/profile
↓
Cookie NOT sent
↓
User appears logged out
```

#### When to use Strict

- Admin dashboards

- Banking / internal tools

- Highly sensitive actions


#### → **lax**

```javascript
Set-Cookie: sessionId=abc; SameSite=Lax
```

Behaviour:
