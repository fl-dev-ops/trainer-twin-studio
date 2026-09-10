# Codebase Restructuring Summary

## Overview

The codebase has been restructured from a flat module organization to a **use-case based hierarchical structure** following SOLID/KISS principles.

**Key principle: Self-documenting code** - Method and class names are meaningful enough to explain their purpose without verbose docstrings.

---

## New Structure

```
src/
├── domains/                          # 🎯 Business Domain Modules
│   ├── interview/                    # Questions, evidence, evaluation
│   ├── recording/                    # Egress, storage, transcripts
│   ├── screen/                       # Feedback, resume, vision
│   │   ├── config.py                 # Prompts + tuning constants
│   │   ├── models.py                 # Data models
│   │   ├── feedback/                 # Real-time feedback
│   │   ├── resume/                   # Resume inspection
│   │   ├── surface/                  # Surface detection
│   │   └── vision/                   # Vision model client
│   └── session/                      # Config, builder, TTS
│
├── infrastructure/                   # 🔧 Cross-cutting
│   ├── config/                       # Profiles, env vars
│   ├── logging/                      # Langfuse, metrics
│   ├── monitoring/                   # Watchdog
│   └── prompt/                       # Loader, renderer, cache
│
├── services/                         # 🔄 App Services
│   ├── agent/                        # UnifiedAgent
│   ├── chroma/                       # Vector DB
│   ├── identity/                     # User resolution
│   └── simulation/                   # Shims
│
├── interfaces/                       # 📡 External Integrations
│   ├── llm/                          # OpenRouter
│   ├── tts/                          # Qwen, Sarvam
│   └── stt/                          # Deepgram
│
└── tools/                            # 🛠️ LLM Tool Adapters (unchanged)
```

---

## Config Files Naming Convention

### `domains/screen/config.py`
Contains both prompts AND configuration constants for tuning agent behavior:

```python
# Prompts
ON_DEMAND_ANALYSIS_PROMPT = "..."
DEVIATION_ANALYSIS_PROMPT = "..."
STALL_ANALYSIS_PROMPT = "..."

# Configuration constants for tuning
SCREEN_FEEDBACK_INTERVAL_SECONDS = 10
SCREEN_FEEDBACK_COOLDOWN_SECONDS = 30
SCREEN_FEEDBACK_STALL_SECONDS = 60
SCREEN_FEEDBACK_CONFIDENCE_THRESHOLD = 0.8
RESUME_MAX_VIEWPORTS = 6
```

**Why `config.py`?** Because it's not just prompts - it's all the knobs you can turn to tune the agent's behavior.

---

## Code Style: Self-Documenting Names

### Principle
**If the method name + parameter names + return type explain the purpose, no docstring is needed.**

### Examples

```python
# ✅ Good: Self-documenting
def load_prompt(url: str, *, timeout: float) -> str:
    # Name says it all: loads a prompt from URL, returns string
    ...

def resolve_user_id_from_room_metadata(metadata: Mapping) -> str | None:
    # Name says it all: resolves user ID from room metadata
    ...

def build_agent_session(*, tts_speaker: str, ...) -> AgentSession:
    # Name says it all: builds an agent session
    ...
```

### When to Add Docstrings

```python
# ✅ Add docstring when:
# 1. Algorithm is complex and not obvious
# 2. Multiple valid interpretations exist
# 3. Non-obvious side effects
# 4. API contract needs clarification

# ❌ Skip docstring when:
# 1. Method name is self-explanatory
# 2. Parameter names are clear
# 3. Return type is obvious
# 4. Implementation is straightforward
```

---

## File Size Summary

| Category | Files | Total Lines |
|----------|-------|-------------|
| `domains/` | 33 files | ~4,500 lines |
| `infrastructure/` | 11 files | ~1,200 lines |
| `services/` | 9 files | ~800 lines |
| `interfaces/` | 5 files | ~200 lines |
| **Total** | **58 files** | **~6,700 lines** |

All files < 500 lines ✅

---

## Import Migration Guide

### New Preferred Imports
```python
# Infrastructure
from infrastructure.config.profiles import AgentProfile, pick_profile
from infrastructure.logging.langfuse import setup_langfuse
from infrastructure.prompt.loader import load_prompt
from infrastructure.prompt.renderer import render_prompt

# Domains
from domains.session.config import SessionConfig, InteractionMode
from domains.session.builder import build_agent_session
from domains.screen.config import SCREEN_FEEDBACK_INTERVAL_SECONDS
from domains.screen.feedback.runtime import ScreenFeedbackRuntime
from domains.interview.evaluation.models import InterviewEvaluation
from domains.recording.egress.manager import start_recording

# Services
from services.agent.unified import UnifiedAgent
from services.identity.resolver import resolve_user_id_from_room_metadata
```

### Backward Compatible Imports (Still Work)
```python
from session import SessionConfig, build_agent_session
from screen_feedback import ScreenFeedbackRuntime
from prompt import load_prompt, render_prompt
from tracing import setup_langfuse
```

---

## Benefits

### 1. **Improved Maintainability**
- Each file < 500 lines
- Clear module boundaries
- Easy to locate related code

### 2. **Better Testability**
- Domain modules can be tested in isolation
- Mock infrastructure dependencies easily
- Focused unit tests per module

### 3. **Enhanced Scalability**
- New interview types → `domains/interview/`
- New TTS providers → `interfaces/tts/`
- New screen features → `domains/screen/`

### 4. **Reduced Cognitive Load**
- Developers understand one domain at a time
- Clear responsibility boundaries
- Self-documenting code

### 5. **Less Code Noise**
- No redundant docstrings
- Focus on implementation
- Names tell the story

---

*Restructuring completed on: 2026-08-18*
*Style: Self-documenting code with minimal docstrings*
