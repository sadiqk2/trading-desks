"""Small log-redaction helper for exception messages from SDKs and drivers."""
from __future__ import annotations

import re
from typing import Any


_PARAMETER = re.compile(r"(?i)(api[_-]?secret|access[_-]?token|request[_-]?token|password|passwd|api[_-]?key)(\s*[=:]\s*)([^&\s,;'\"]+)")
_URL_PASSWORD = re.compile(r"(?i)(://[^:/@\s]+:)[^@/\s]+@")


def safe_error(error: Any, *secrets: str) -> str:
    message = str(error)
    for secret in secrets:
        if secret:
            message = message.replace(secret, "[REDACTED]")
    message = _PARAMETER.sub(r"\1\2[REDACTED]", message)
    return _URL_PASSWORD.sub(r"\1[REDACTED]@", message)
