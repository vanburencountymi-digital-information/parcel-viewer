"""Checks that the contract harness catches the drift it exists to catch (DIC-2147).

Run: python -m unittest discover -s tools/api-contract
"""

from unittest import TestCase

import contract


def _resp(body: object, status: int = 200, **headers: str) -> dict:
    return {
        "status": status,
        "headers": {"content-type": "application/json", **headers},
        "body": {"json": body},
        "ms": 1,
    }


class CompareResponsesTests(TestCase):
    def test_identical_responses_match(self) -> None:
        a = _resp({"results": [{"id": 1, "pin": "80-01"}]})

        self.assertEqual(contract.compare_responses(a, a, "full"), ([], []))

    def test_status_header_and_value_changes_are_differences(self) -> None:
        a = _resp({"ok": True, "n": 1})
        cases = {
            "status": _resp({"ok": True, "n": 1}, status=201),
            "header": _resp({"ok": True, "n": 1}, **{"cache-control": "no-store"}),
            "value": _resp({"ok": True, "n": 2}),
            "null": _resp({"ok": True, "n": None}),
            "missing key": _resp({"ok": True}),
            "extra key": _resp({"ok": True, "n": 1, "x": 0}),
            "number as string": _resp({"ok": True, "n": "1"}),
        }
        for name, b in cases.items():
            with self.subTest(name):
                diffs, _ = contract.compare_responses(a, b, "full")

                self.assertTrue(diffs)

    def test_key_order_and_int_float_spelling_are_only_warnings(self) -> None:
        a = _resp({"a": 1, "b": 2.0})
        b = _resp({"b": 2, "a": 1})

        diffs, warns = contract.compare_responses(a, b, "full")

        self.assertEqual(diffs, [])
        self.assertEqual(len(warns), 2)

    def test_rows_with_ids_match_in_any_order(self) -> None:
        a = _resp({"features": [{"id": 1, "v": "x"}, {"id": 2, "v": "y"}]})
        b = _resp({"features": [{"id": 2, "v": "y"}, {"id": 1, "v": "x"}]})

        diffs, warns = contract.compare_responses(a, b, "full")

        self.assertEqual(diffs, [])
        self.assertIn("different order", warns[0])

    def test_shape_mode_ignores_which_rows_but_not_how_many_or_their_fields(self) -> None:
        a = _resp({"features": [{"id": 1, "pin": "a"}, {"id": 2, "pin": "b"}]})
        other_rows = _resp({"features": [{"id": 7, "pin": "q"}, {"id": 9, "pin": "r"}]})
        fewer_rows = _resp({"features": [{"id": 7, "pin": "q"}]})
        renamed = _resp({"features": [{"id": 7, "PIN": "q"}, {"id": 9, "PIN": "r"}]})

        self.assertEqual(contract.compare_responses(a, other_rows, "shape")[0], [])
        self.assertTrue(contract.compare_responses(a, fewer_rows, "shape")[0])
        self.assertTrue(contract.compare_responses(a, renamed, "shape")[0])

    def test_status_mode_compares_only_status_and_content_type(self) -> None:
        a = {"status": 200, "headers": {"content-type": "image/png"}, "body": {"bytes": 10}}
        b = {"status": 200, "headers": {"content-type": "image/png"}, "body": {"bytes": 99}}
        c = {"status": 200, "headers": {"content-type": "text/xml"}, "body": {"bytes": 10}}

        self.assertEqual(contract.compare_responses(a, b, "status")[0], [])
        self.assertTrue(contract.compare_responses(a, c, "status")[0])


class ShapeTests(TestCase):
    def test_shape_keeps_structure_and_drops_values(self) -> None:
        value = {"owner_name": "SMITH JOHN", "acres": 1.5, "tags": ["a"], "gone": None}

        self.assertEqual(
            contract.shape(value),
            {"owner_name": "string", "acres": "number", "tags": ["string"], "gone": "null"},
        )

    def test_list_rows_merge_into_one_shape_with_optional_and_nullable_fields(self) -> None:
        rows = [{"id": 1, "addr": "x"}, {"id": 2, "addr": None}, {"id": 3}]

        self.assertEqual(contract.shape(rows), [{"id": "number", "addr": "missing|null|string"}])

    def test_empty_list_does_not_change_a_recorded_row_shape(self) -> None:
        self.assertEqual(contract._merge(["empty"], [{"id": "number"}]), [{"id": "number"}])


class CatalogueTests(TestCase):
    def test_names_are_unique_and_every_request_is_well_formed(self) -> None:
        requests = contract.load_catalogue()

        for req in requests:
            with self.subTest(req["name"]):
                self.assertIn(req["method"], {"GET", "POST", "PUT", "OPTIONS"})
                self.assertTrue(req["path"].startswith("/"))
                self.assertIn(req.get("compare", "full"), {"full", "shape", "status"})

    def test_no_request_can_send_email_write_config_or_log_a_fake_client_error(self) -> None:
        for req in contract.load_catalogue():
            path = req["path"]
            with self.subTest(req["name"]):
                if path.startswith(("/report-error", "/client-errors")):
                    self.assertIn("invalid", req["name"])
                if req["method"] in {"PUT", "POST"} and path.startswith("/config/"):
                    self.assertNotIn("auth", req)
                    self.assertNotIn("X-Admin-Token", req.get("headers", {}))

    def test_repeat_placeholders_expand(self) -> None:
        self.assertEqual(contract._expand({"q": "<<repeat:a:3>>"}), {"q": "aaa"})
