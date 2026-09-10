# Configuration

Agent profiles live in `config/agents.json`. Each profile's `tools` object
controls available interview capabilities.

## Screen tools

```json
{
  "tools": {
    "editor_events": true,
    "screen_inspection": false,
    "screen_feedback_timer": true
  }
}
```

### `editor_events`

Enables interview editor events and editor RPC tools, including
`read_code_range` and `highlight_code`.

### `screen_inspection`

Exposes `inspect_shared_screen` to the agent. It is used only for active
whiteboard requests. Coding feedback uses editor RPC tools instead.

### `screen_feedback_timer`

Checks the latest screen frame every ten seconds. A changed content revision
triggers strategic-deviation analysis. The observer intervenes only when the
visible approach is fundamentally non-viable or shows a clear conceptual
misconception. An unchanged revision also triggers stall analysis after sixty
seconds. Speech still requires an active visible surface, a current frame, an
idle conversation, high model confidence, and an elapsed feedback cooldown.

## How the screen flags combine

`editor_events` is the parent gate for the screen-feedback runtime.

| `editor_events` | `screen_feedback_timer` | `screen_inspection` | Interview behavior |
|---|---:|---:|---|
| `true` | `true` | `false` | Automatic deviation and stall feedback; normal code tools; no `inspect_shared_screen` |
| `true` | `false` | `true` | No automatic feedback; on-demand screen inspection available |
| `true` | `false` | `false` | No screen runtime; normal interview and code tools remain available |
| `false` | any | any | Screen runtime and interview editor tools are not created |

For automatic live coding feedback without exposing general screen inspection,
use:

```json
"screen_inspection": false,
"screen_feedback_timer": true
```

With the timer disabled, the main interviewer can still respond to candidate
speech and use `read_code_range` and `highlight_code` when `editor_events=true`,
but it will not proactively detect deviation, inactivity, or fifty-percent
completion.

Restart or redeploy the worker after changing `config/agents.json`.
