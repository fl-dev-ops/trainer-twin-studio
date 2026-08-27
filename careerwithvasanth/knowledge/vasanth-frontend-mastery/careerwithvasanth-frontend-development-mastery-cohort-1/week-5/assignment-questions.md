# Assignment questions

Source: https://app.notion.com/p/3031199ccfe380fc9e4fc94fbd103a62

Approximate interview time to solve all the below problems is 45 minutes to 1 hour.

## Problem 1:  Implement a Config-Driven Form Renderer with Validation Rules

#### Problem Statement

Build a form renderer that **does not hardcode inputs in JSX**, but instead **renders the form entirely from a configuration object**.

---

#### Expectations:

#### Form Rendering

- Form fields must be generated dynamically from a config like:
  - input type (text, email, number, select, checkbox, etc.)
  - label
  - name / key
  - default value

- Adding a new field should require **only config changes**, not JSX changes.

#### State Management

- Form values must be stored in state.

- Validation errors must be tracked cleanly.

- No uncontrolled inputs.


Example config:

```javascript
{
  "title": "User Registration",
  "submitLabel": "Register",
  "fields": [
    {
      "type": "text",
      "label": "Full Name",
      "name": "fullName",
      "placeholder": "Enter your name",
      "defaultValue": "",
      "validation": {
        "required": true,
        "minLength": 3
      }
    },
    {
      "type": "email",
      "label": "Email Address",
      "name": "email",
      "placeholder": "Enter your email",
      "defaultValue": "",
      "validation": {
        "required": true,
        "pattern": "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
      }
    },
    {
      "type": "password",
      "label": "Password",
      "name": "password",
      "defaultValue": "",
      "validation": {
        "required": true,
        "minLength": 6
      }
    },
    {
      "type": "select",
      "label": "Country",
      "name": "country",
      "options": [
        { "label": "India", "value": "IN" },
        { "label": "USA", "value": "US" },
        { "label": "Germany", "value": "DE" }
      ],
      "validation": {
        "required": true
      }
    },
    {
      "type": "checkbox",
      "label": "Accept Terms & Conditions",
      "name": "termsAccepted",
      "defaultValue": false,
      "validation": {
        "required": true
      }
    }
  ]
}
```


## Problem 2:   Implement a Table Component with Sorting, Filtering, Pagination & Column Configuration

#### Problem Statement

Build a **reusable table component** that supports multiple data operations **without hardcoding column logic**.

---

#### Column Configuration

- Columns must be driven by config:
  - key
  - label
  - sortable (true/false)
  - filterable (true/false)
  - custom cell renderer (optional)


#### Sorting

- Click on column header to sort

- Support:
  - ascending
  - descending

- Sorting must work per column.

#### Filtering

- Column-level filtering (e.g., text input per column)

- Filters should combine logically (AND behavior).


#### Performance (basic)

- Avoid unnecessary re-renders

- Derived data (filtered/sorted rows) should be memoize


Sample configuration:

```javascript
{
  "columns": [
    {
      "key": "id",
      "label": "ID",
      "sortable": true,
      "filterable": false
    },
    {
      "key": "name",
      "label": "Name",
      "sortable": true,
      "filterable": true
    },
    {
      "key": "email",
      "label": "Email",
      "sortable": true,
      "filterable": true
    },
    {
      "key": "role",
      "label": "Role",
      "sortable": false,
      "filterable": true
    },
    {
      "key": "status",
      "label": "Status",
      "sortable": true,
      "filterable": true,
      "render": "statusBadge"
    }
  ],
  "pageSizeOptions": [5, 10, 20],
  "defaultPageSize": 5
}
```



## Problem 3:  Implement a Tree View Component with Lazy Loading, Expand/Collapse & Search

#### Problem Statement

Build a tree UI that can display **nested hierarchical data**, with support for expanding nodes and loading children on demand.

---

#### Expectations from the student

#### ✅ Tree Rendering

- Render nodes recursively

- Support unlimited nesting depth

- Each node should show expand/collapse UI

---

#### ✅ Expand / Collapse

- Clicking a node toggles children visibility

- Expanded state must be preserved in state

#### ✅ Lazy Loading

- Child nodes should be loaded **only when parent is expanded**

- Simulate lazy loading using:
  - timeout
  - mocked async function

- Loading indicator should be shown while fetching children




## Problem 4:  Service-Worker-Driven Notification Center

#### Problem Statement

Build a notification center that **receives events via Service Worker**, stores them, and displays them in the UI. (You can mock sending notification via Application in the inspect menu)

---

#### ✅ Notification Handling

- Service Worker should:
  - Receive simulated push events
  - Store notifications (IndexedDB / localStorage)

- Notifications should persist across reloads.

---

#### ✅ UI Requirements

- Notification list screen in React

- Show:
  - unread / read state
  - timestamp

- Clicking notification marks it as read


#### ✅ Event-Driven Flow

- UI should react to:
  - new notifications
  - page reloads
  - offline/online state (basic handling)
