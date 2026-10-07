"""Staff sign-in (ADR 0013): trade a staff password for a Knox token, check it, revoke it.

Only staff can sign in: the token exists for the admin and private routes, and the public
routes need no account. A wrong password, an unknown user, an inactive user and a non-staff
user all get the same 401, so the answer never says which usernames exist.
"""

import logging

from django.conf import settings
from django.contrib.auth import authenticate, user_logged_in, user_logged_out
from django.utils import timezone
from knox.auth import TokenAuthentication
from knox.models import AuthToken
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from accounts.params import LoginBody
from common.validation import HttpError, ParamSource, json_body, validate

log = logging.getLogger(__name__)

LOGIN_FAILED = "Invalid username or password."


def _drop_old_tokens(user: object) -> None:
    """Takes a user. Deletes their expired tokens, then the oldest live ones past the limit."""
    tokens = AuthToken.objects.filter(user=user)
    tokens.filter(expiry__lt=timezone.now()).delete()
    keep = max(int(settings.TOKENS_PER_USER) - 1, 0)  # room for the token about to be made
    stale = tokens.order_by("-created").values_list("pk", flat=True)[keep:]
    AuthToken.objects.filter(pk__in=list(stale)).delete()


class LoginView(APIView):
    authentication_classes = []
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "login"

    def post(self, request: Request) -> Response:
        """
        Takes {"username", "password"}. Returns {"token", "expiry", "user": {"username"}} for
        an active staff user, else 401. The token is shown once; only its hash is stored.
        """
        body = validate(LoginBody, json_body(request), ParamSource.BODY)
        user = authenticate(request._request, username=body.username, password=body.password)
        if user is None or not user.is_staff:
            log.warning("staff sign-in refused")
            raise HttpError(status.HTTP_401_UNAUTHORIZED, LOGIN_FAILED)
        _drop_old_tokens(user)
        instance, token = AuthToken.objects.create(user)
        user_logged_in.send(sender=user.__class__, request=request._request, user=user)
        return Response(
            {
                "token": token,
                "expiry": instance.expiry.isoformat() if instance.expiry else None,
                "user": {"username": user.get_username()},
            }
        )


class SignedInView(APIView):
    """A route for a signed-in user: a Knox token, nothing else (no session, no shared key)."""

    authentication_classes = [TokenAuthentication]
    permission_classes = [IsAuthenticated]
    throttle_classes = [ScopedRateThrottle]
    throttle_scope = "admin"


class MeView(SignedInView):
    def get(self, request: Request) -> Response:
        """Returns who the token belongs to and when it expires, so a client can check it."""
        return Response(
            {
                "user": {
                    "username": request.user.get_username(),
                    "is_staff": request.user.is_staff,
                },
                "expiry": request.auth.expiry.isoformat() if request.auth.expiry else None,
            }
        )


class LogoutView(SignedInView):
    def post(self, request: Request) -> Response:
        """Revokes the token the request came with. Other browsers stay signed in."""
        request.auth.delete()
        user_logged_out.send(
            sender=request.user.__class__, request=request._request, user=request.user
        )
        return Response({"ok": True})
