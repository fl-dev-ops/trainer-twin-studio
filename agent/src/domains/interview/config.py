"""Interview configuration constants."""

SUPPORTED_LANGUAGES = ("html", "java", "javascript", "python", "react")
DEFAULT_DOMAINS = ["react", "javascript"]

DEFAULT_STARTER_CODE = {
    "html": (
        "<!doctype html>\n"
        '<html lang="en">\n'
        "  <head>\n"
        '    <meta charset="UTF-8" />\n'
        '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n'
        "    <title>Frontend coding question</title>\n"
        "  </head>\n"
        "  <body>\n"
        '    <main id="app">\n'
        "      <!-- Build your interface here. -->\n"
        "    </main>\n"
        "    <script>\n"
        "      // Add your JavaScript here.\n"
        "    </script>\n"
        "  </body>\n"
        "</html>\n"
    ),
    "javascript": "// Write your solution here.\n",
    "react": (
        'import React from "react";\n\n'
        "export default function App() {\n"
        "  return (\n"
        "    <main>\n"
        "      {/* Implement your solution here. */}\n"
        "    </main>\n"
        "  );\n"
        "}\n"
    ),
}

COUNTS = {
    "0-3": {
        "verbal": 0,
        "mcq": 1,
        "coding": 1,
        "code-output": 1,
        "machine": 1,
        "system-design": 1,
    },
    "4-8": {
        "verbal": 0,
        "mcq": 1,
        "coding": 1,
        "code-output": 2,
        "machine": 1,
        "system-design": 1,
    },
}

DIFFICULTIES = {
    "0-3": ["easy", "medium"],
    "4-8": ["medium", "hard"],
}

BUCKETS = {
    "verbal": {"question_types": ["verbal"]},
    "mcq": {"question_types": ["mcq"]},
    "coding": {"question_types": ["coding"]},
    "code-output": {"question_types": ["code-output"]},
    "machine": {
        "question_types": ["machine-coding"],
        "source_context": "mock-interview",
    },
    "system-design": {
        "question_types": ["verbal"],
        "domains": ["system-design"],
        "surface": "whiteboard",
        "allow_domain_fallback": False,
    },
}

BUCKET_ORDER = [
    "verbal",
    "mcq",
    "code-output",
    "coding",
    "machine",
    "system-design",
]

QUESTION_TYPE_BUCKET = {
    "verbal": "verbal",
    "mcq": "mcq",
    "coding": "coding",
    "code-output": "code-output",
    "machine-coding": "machine",
}
