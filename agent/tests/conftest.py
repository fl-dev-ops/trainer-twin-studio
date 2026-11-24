import os

# The worker loads .env at import time. Keep personal provider settings out of pytest.
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
for key in ("LANGFUSE_BASE_URL", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"):
    os.environ.pop(key, None)
