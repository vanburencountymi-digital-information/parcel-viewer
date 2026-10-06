from unittest import mock

from django.test import SimpleTestCase
from parameterized import parameterized

from common.enums import Environment
from common.observability import configure_sentry

DSN = "https://key@sentry.example/1"


class ConfigureSentryTests(SimpleTestCase):
    @parameterized.expand([(Environment.STAGING,), (Environment.PRODUCTION,)])
    def test_deployed_environments_with_a_dsn_start_sentry(self, environment: Environment) -> None:
        init = mock.Mock()

        started = configure_sentry(dsn=DSN, environment=environment, release="1.2.3", init=init)

        self.assertTrue(started)
        init.assert_called_once_with(
            dsn=DSN, environment=str(environment), release="1.2.3", send_default_pii=False
        )

    @parameterized.expand(
        [
            ("local", DSN, Environment.LOCAL),
            ("test", DSN, Environment.TEST),
            ("no_dsn", "", Environment.PRODUCTION),
        ]
    )
    def test_otherwise_it_is_a_no_op(self, _name: str, dsn: str, environment: Environment) -> None:
        init = mock.Mock()

        self.assertFalse(configure_sentry(dsn=dsn, environment=environment, release="1", init=init))
        init.assert_not_called()
