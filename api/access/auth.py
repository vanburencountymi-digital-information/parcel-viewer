"""Optional staff sign-in on the public parcel routes (ADR 0015).

The parcel routes stay anonymous. A staff Knox token, when one is sent, identifies staff so
they aren't metered; a missing or bad token is simply anonymous, never a 401, so the
public routes answer exactly as before.
"""

from typing import Any

from knox.auth import TokenAuthentication
from rest_framework.exceptions import AuthenticationFailed
from rest_framework.request import Request


class OptionalTokenAuthentication(TokenAuthentication):
    def authenticate(self, request: Request) -> Any:
        try:
            return super().authenticate(request)
        except AuthenticationFailed:
            return None
