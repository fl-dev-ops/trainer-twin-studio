from __future__ import annotations

import json
import pytest
from unittest.mock import patch, MagicMock
from recording.webhook import post_completion_webhook


@pytest.mark.asyncio
async def test_post_completion_webhook():
    with patch("urllib.request.urlopen") as mock_urlopen:
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.getcode.return_value = 200
        mock_urlopen.return_value.__enter__.return_value = mock_response

        payload = {"session_id": "test-123", "status": "COMPLETED"}
        await post_completion_webhook("http://localhost:3000/api/sessions/webhook", payload)

        mock_urlopen.assert_called_once()
        req = mock_urlopen.call_args[0][0]
        assert req.full_url == "http://localhost:3000/api/sessions/webhook"
        assert req.get_method() == "POST"
        assert json.loads(req.data.decode("utf-8")) == payload
