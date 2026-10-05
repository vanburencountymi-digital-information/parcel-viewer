"""Map vision (DIC-2135): image checks, the model call, the /vision/describe route, and
the chat loop's cost rules for looks and offers. The model is stubbed throughout."""

import base64
import json
import struct
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import vision
from parameterized import parameterized
from tests.test_api_contract import _ApiTestCase

import agent
import main


def _png(width: int, height: int) -> bytes:
    """Just enough PNG for the header check: signature + IHDR."""
    ihdr = struct.pack(">II", width, height) + b"\x08\x02\x00\x00\x00"
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + ihdr + b"\x00\x00\x00\x00"


def _jpeg(width: int, height: int) -> bytes:
    """SOI, an APP0 segment, then a baseline SOF0 frame header carrying the size."""
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof0 = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, height, width, 1) + b"\x01\x11\x00"
    return b"\xff\xd8" + app0 + sof0 + b"\xff\xd9"


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def _response(*blocks, stop_reason="end_turn", model="claude-opus-5-5"):
    return SimpleNamespace(content=list(blocks), stop_reason=stop_reason, model=model)


def _text(t: str):
    return SimpleNamespace(type="text", text=t)


class CheckImageTests(TestCase):
    @parameterized.expand(
        [
            ("png", _png(1600, 900), "image/png", (1600, 900)),
            ("jpeg", _jpeg(2576, 1449), "image/jpeg", (2576, 1449)),
        ]
    )
    def test_accepts_supported_images_and_reads_their_size(self, _name, data, media, size) -> None:
        decoded, width, height = vision.check_image(_b64(data), media)

        self.assertEqual(decoded, data)
        self.assertEqual((width, height), size)

    @parameterized.expand(
        [
            ("not_base64", "%%%not-base64%%%", "image/png", "valid base64"),
            ("empty", "", "image/png", "empty"),
            ("png_declared_as_jpeg", _b64(_png(10, 10)), "image/jpeg", "JPEG or PNG"),
            ("gif", _b64(b"GIF89a" + b"\x00" * 20), "image/png", "JPEG or PNG"),
            ("too_wide", _b64(_png(3000, 100)), "image/png", "2576 px"),
            ("truncated_jpeg", _b64(b"\xff\xd8\xff\xe0\x00"), "image/jpeg", "couldn't be read"),
            ("zero_size", _b64(_png(0, 10)), "image/png", "couldn't be read"),
        ]
    )
    def test_rejects_with_a_reason(self, _name, image, media, reason) -> None:
        with self.assertRaises(vision.ImageRejected) as cm:
            vision.check_image(image, media)

        self.assertIn(reason, str(cm.exception))

    @patch("vision.VISION_MAX_IMAGE_BYTES", 100)
    def test_rejects_an_image_over_the_byte_limit(self) -> None:
        with self.assertRaises(vision.ImageRejected) as cm:
            vision.check_image(_b64(_png(10, 10) + b"\x00" * 200), "image/png")

        self.assertIn("too large", str(cm.exception))


class DescribeViewTests(TestCase):
    @patch("vision._create_message", autospec=True)
    def test_sends_the_image_and_context_to_the_vision_model(self, mock_create) -> None:
        mock_create.return_value = _response(
            SimpleNamespace(type="thinking", thinking=""), _text("A barn sits near the road.")
        )

        result = vision.run_describe_view(
            _png(800, 600),
            "image/png",
            question="Is there a barn?",
            parcel={"pin": "80-01-001-001-00", "acres": 12.5},
            layers=["Aerial imagery"],
        )

        self.assertEqual(
            result, {"description": "A barn sits near the road.", "model": "claude-opus-5-5"}
        )
        purpose = mock_create.call_args.args[0]
        kwargs = mock_create.call_args.kwargs
        self.assertEqual(purpose, "vision")
        self.assertEqual(kwargs["model"], "claude-opus-5-5")
        self.assertEqual(kwargs["fallbacks"], "default")
        self.assertEqual(kwargs["betas"], ["server-side-fallback-2026-07-01"])
        self.assertNotIn("output_config", kwargs)
        image_block, text_block = kwargs["messages"][0]["content"]
        self.assertEqual(image_block["source"]["media_type"], "image/png")
        self.assertEqual(base64.b64decode(image_block["source"]["data"]), _png(800, 600))
        for expected in ("Is there a barn?", "12.50 acres", "80-01-001-001-00", "Aerial imagery"):
            self.assertIn(expected, text_block["text"])
        self.assertIn("Van Buren County, Michigan", kwargs["system"])

    @patch("vision.VISION_EFFORT", "low")
    @patch("vision._create_message", autospec=True, return_value=_response(_text("ok")))
    def test_effort_is_sent_only_when_configured(self, mock_create) -> None:
        vision.run_describe_view(_png(10, 10), "image/png")

        self.assertEqual(mock_create.call_args.kwargs["output_config"], {"effort": "low"})

    @patch("vision._create_message", autospec=True, return_value=_response(_text("ok")))
    def test_no_question_asks_for_a_general_description(self, mock_create) -> None:
        vision.run_describe_view(_png(10, 10), "image/png")

        text = mock_create.call_args.kwargs["messages"][0]["content"][1]["text"]
        self.assertIn("general description", text)
        self.assertNotIn("ft across", text)

    @patch("vision._create_message", autospec=True, return_value=_response(_text("ok")))
    def test_the_view_width_gives_the_model_a_scale(self, mock_create) -> None:
        vision.run_describe_view(_png(10, 10), "image/png", view_width_ft=1834.6)

        text = mock_create.call_args.kwargs["messages"][0]["content"][1]["text"]
        self.assertIn("about 1,835 ft across", text)

    def test_the_prompt_asks_for_a_named_best_guess_not_a_shrug(self) -> None:
        # The first live look called ballfields "tan basins ... can't be confirmed".
        self.assertIn("best identification", vision.VISION_SYSTEM)
        self.assertIn("north at the top", vision.VISION_SYSTEM)
        self.assertIn("at most 6 plain sentences", vision.VISION_SYSTEM)

    @parameterized.expand(
        [
            ("refusal", _response(_text("partial"), stop_reason="refusal")),
            ("no_text", _response(SimpleNamespace(type="thinking", thinking=""))),
        ]
    )
    def test_a_refusal_or_empty_answer_raises(self, _name, response) -> None:
        with (
            patch("vision._create_message", autospec=True, return_value=response),
            self.assertRaises(vision.VisionRefused),
        ):
            vision.run_describe_view(_png(10, 10), "image/png")


class EvalSetTests(TestCase):
    """The opt-in live evaluation's checker and its saved views (no model call)."""

    def test_check_needs_one_word_from_each_group_and_none_forbidden(self) -> None:
        from evals.vision_eval import check

        case = {
            "expect_any": [["wooded", "trees"], ["ballfield", "baseball"]],
            "forbid": ["lagoon"],
        }
        self.assertEqual(check("Wooded lot; likely baseball fields east.", case), [])
        self.assertEqual(
            check("Trees, and tan basins that may be a lagoon.", case),
            ["missing any of: ballfield, baseball", "contains: lagoon"],
        )

    def test_every_case_has_a_valid_saved_image(self) -> None:
        from evals.vision_eval import HERE

        cases = json.loads((HERE / "cases.json").read_text(encoding="utf-8"))["cases"]
        self.assertGreaterEqual(len(cases), 2)
        for case in cases:
            data = (HERE / case["image"]).read_bytes()
            _, width, height = vision.check_image(_b64(data), "image/jpeg")
            self.assertLessEqual(max(width, height), vision.MAX_LONG_EDGE, case["id"])
            self.assertTrue(case.get("expect_any"), case["id"])


class CreateMessageBetaTests(TestCase):
    @patch("agent._get_client", autospec=True)
    def test_beta_calls_use_the_beta_client(self, mock_get_client) -> None:
        client = mock_get_client.return_value
        client.beta.messages.create.return_value = _response(_text("ok"))

        agent._create_message("vision", model="m", max_tokens=1, messages=[], betas=["x"])

        client.beta.messages.create.assert_called_once()
        client.messages.create.assert_not_called()


VALID_BODY = {
    "image": _b64(_jpeg(1600, 900)),
    "media_type": "image/jpeg",
    "question": "Is there a barn?",
    "parcel": {"pin": "80-01-001-001-00", "acres": 12.5},
    "layers": ["Aerial imagery", "Flood zones"],
    "view_width_ft": 1800,
}


class VisionRouteTests(_ApiTestCase):
    @patch("main.vision.run_describe_view", autospec=True)
    def test_returns_a_labelled_description_and_reserves_several_units(self, mock_run) -> None:
        mock_run.return_value = {"description": "A barn.", "model": "claude-opus-5-5"}
        with patch("main.ai_usage.reserve", autospec=True, return_value=(True, 10)) as mock_reserve:
            response = self.client.post("/vision/describe", json=VALID_BODY)

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["description"], "A barn.")
        self.assertEqual(body["layers"], ["Aerial imagery", "Flood zones"])
        self.assertIn("T", body["at"])
        mock_reserve.assert_called_once_with(main.SERVER_TENANT, units=main.VISION_QUOTA_UNITS)
        self.assertGreater(main.VISION_QUOTA_UNITS, 1)
        self.assertEqual(mock_run.call_args.kwargs["question"], "Is there a barn?")
        self.assertEqual(mock_run.call_args.kwargs["parcel"]["acres"], 12.5)
        self.assertEqual(mock_run.call_args.kwargs["view_width_ft"], 1800)

    @patch("main.vision.run_describe_view", autospec=True)
    @patch("main.ai_usage.reserve", autospec=True)
    def test_a_bad_image_is_a_400_before_the_quota_or_the_model(
        self, mock_reserve, mock_run
    ) -> None:
        response = self.client.post(
            "/vision/describe", json={**VALID_BODY, "image": _b64(_png(10, 10))}
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json(), {"ok": False, "error": "Only JPEG or PNG images are accepted."}
        )
        mock_reserve.assert_not_called()
        mock_run.assert_not_called()

    @parameterized.expand(
        [
            ("gif_type", {"media_type": "image/gif"}),
            ("question_too_long", {"question": "x" * 501}),
            ("too_many_layers", {"layers": ["a"] * 41}),
            ("no_image", {"image": ""}),
            ("negative_width", {"view_width_ft": -5}),
        ]
    )
    @patch("main.vision.run_describe_view", autospec=True)
    def test_invalid_requests_are_a_422(self, _name, change, mock_run) -> None:
        response = self.client.post("/vision/describe", json={**VALID_BODY, **change})

        self.assertEqual(response.status_code, 422)
        mock_run.assert_not_called()

    @patch("main.vision.run_describe_view", autospec=True)
    @patch("main.ai_usage.reserve", autospec=True, return_value=(False, 0))
    def test_spent_quota_degrades_without_calling_the_model(self, _mock_reserve, mock_run) -> None:
        with self.assertLogs("map_buddy", level="WARNING"):
            response = self.client.post("/vision/describe", json=VALID_BODY)

        self.assertEqual(response.json()["degraded"], True)
        mock_run.assert_not_called()

    @patch("main._quota_block", autospec=True, return_value=None)
    def test_a_model_failure_is_a_fixed_message_and_reported(self, _mock_quota) -> None:
        boom = RuntimeError("request_id=req_123 key=sk-ant-secret")
        with (
            patch("main.vision.run_describe_view", autospec=True, side_effect=boom),
            self.assertLogs("map_buddy", level="ERROR"),
        ):
            response = self.client.post("/vision/describe", json=VALID_BODY)

        self.assertEqual(response.json(), {"ok": False, "error": main.VISION_ERROR})
        self.assertNotIn("req_123", response.text)
        self.errors.report_exception.assert_called_once()

    @patch("main._quota_block", autospec=True, return_value=None)
    def test_a_refusal_is_the_same_fixed_message(self, _mock_quota) -> None:
        with (
            patch(
                "main.vision.run_describe_view",
                autospec=True,
                side_effect=vision.VisionRefused("no"),
            ),
            self.assertLogs("map_buddy", level="WARNING"),
        ):
            response = self.client.post("/vision/describe", json=VALID_BODY)

        self.assertEqual(response.json(), {"ok": False, "error": main.VISION_ERROR})
        self.errors.report_exception.assert_not_called()

    @patch("main.vision.run_describe_view", autospec=True)
    def test_without_a_key_it_says_so(self, mock_run) -> None:
        with patch.dict("os.environ", {"ANTHROPIC_API_KEY": ""}):
            response = self.client.post("/vision/describe", json=VALID_BODY)

        self.assertEqual(response.json()["ok"], False)
        mock_run.assert_not_called()

    @patch("main._quota_block", autospec=True, return_value=None)
    @patch(
        "main.vision.run_describe_view",
        autospec=True,
        return_value={"description": "d", "model": "m"},
    )
    def test_one_client_is_limited_to_ten_looks_an_hour(self, _mock_run, _mock_quota) -> None:
        codes = [
            self.client.post("/vision/describe", json=VALID_BODY).status_code for _ in range(11)
        ]

        self.assertEqual(codes, [200] * 10 + [429])


class VisionBodySizeTests(_ApiTestCase):
    """Only the vision route takes a large body; every other route keeps the 64 KB cap."""

    def _post(self, path: str, size: int):
        body = json.dumps({"message": "x" * size})
        return self.client.post(path, content=body, headers={"Content-Type": "application/json"})

    def test_an_image_sized_body_reaches_the_vision_route(self) -> None:
        response = self._post("/vision/describe", main.MAX_BODY_BYTES * 4)

        self.assertEqual(response.status_code, 422)  # parsed (no image field), not refused

    def test_the_same_body_is_still_refused_by_chat(self) -> None:
        self.assertEqual(self._post("/chat", main.MAX_BODY_BYTES * 4).status_code, 413)

    def test_a_body_over_the_vision_cap_is_a_413(self) -> None:
        self.assertEqual(
            self._post("/vision/describe", main.VISION_MAX_BODY_BYTES + 1).status_code, 413
        )

    def test_the_cap_fits_the_largest_allowed_image(self) -> None:
        self.assertGreater(main.VISION_MAX_BODY_BYTES, vision.VISION_MAX_IMAGE_BYTES * 4 // 3)


class ChatPassesVisionFieldsTests(_ApiTestCase):
    @patch("main._quota_block", autospec=True, return_value=None)
    @patch("main.run_chat_stream", autospec=True, return_value=iter([{"type": "done"}]))
    def test_the_read_and_the_offer_flag_reach_the_agent(self, mock_run, _mock_quota) -> None:
        response = self.client.post(
            "/chat",
            json={
                "message": "Is there a barn?",
                "vision_read": {"description": "A barn.", "layers": ["Aerial imagery"]},
                "vision_offered": True,
            },
        )

        self.assertEqual(response.status_code, 200)
        kwargs = mock_run.call_args.kwargs
        self.assertEqual(kwargs["vision_read"].description, "A barn.")
        self.assertTrue(kwargs["vision_offered"])

    @patch("main.run_chat_stream", autospec=True)
    def test_an_oversized_read_is_rejected(self, mock_run) -> None:
        response = self.client.post(
            "/chat", json={"message": "hi", "vision_read": {"description": "x" * 4001}}
        )

        self.assertEqual(response.status_code, 422)
        mock_run.assert_not_called()


def _tool(name: str, inp: dict, tid: str):
    return SimpleNamespace(type="tool_use", name=name, input=inp, id=tid)


class ChatVisionRuleTests(TestCase):
    """The loop enforces the cost rules the prompt describes."""

    def _run(self, first_turn, **kw):
        replies = [_response(*first_turn, stop_reason="tool_use"), _response(_text("Done."))]
        with patch("agent._create_message", autospec=True, side_effect=replies) as mock_create:
            events = list(agent.run_chat_stream("Is there a barn?", [], None, **kw))
        done = events[-1]
        # The loop appends to one list, so the tool results are second to last by now.
        results = mock_create.call_args_list[1].kwargs["messages"][-2]["content"]
        return done, {r["tool_use_id"]: r["content"] for r in results}, mock_create

    def test_one_offer_per_request(self) -> None:
        done, results, _ = self._run(
            [
                _tool("offer_map_look", {"question": "barn?"}, "a"),
                _tool("offer_map_look", {"question": "again"}, "b"),
            ]
        )

        self.assertEqual([c["type"] for c in done["commands"]], ["offer_map_look"])
        self.assertIn("Not shown", results["b"])

    def test_no_offer_once_one_was_made_in_the_conversation(self) -> None:
        done, results, _ = self._run(
            [_tool("offer_map_look", {"question": "barn?"}, "a")], vision_offered=True
        )

        self.assertEqual(done["commands"], [])
        self.assertIn("already offered", results["a"])

    def test_one_look_per_request(self) -> None:
        done, results, _ = self._run(
            [_tool("look_at_map", {"question": "barn?"}, "a"), _tool("look_at_map", {}, "b")]
        )

        self.assertEqual(
            done["commands"], [{"type": "look_at_map", "payload": {"question": "barn?"}}]
        )
        self.assertIn("Look started", results["a"])
        self.assertIn("Not run", results["b"])

    def test_no_new_look_while_answering_from_a_read(self) -> None:
        read = main.VisionRead(
            description="A red barn east of the house.", layers=["Aerial imagery"]
        )
        done, results, mock_create = self._run([_tool("look_at_map", {}, "a")], vision_read=read)

        self.assertEqual(done["commands"], [])
        self.assertIn("Not run", results["a"])
        first_user_turn = mock_create.call_args_list[0].kwargs["messages"][0]["content"]
        self.assertIn("Visual read of the current map view", first_user_turn)
        self.assertIn("A red barn east of the house.", first_user_turn)
        self.assertIn("Layers shown: Aerial imagery", first_user_turn)

    def test_the_tools_are_declared_and_the_prompt_sets_the_cost_rules(self) -> None:
        names = {t["name"] for t in agent.TOOLS}
        self.assertTrue({"look_at_map", "offer_map_look"} <= names)
        self.assertIn("every look costs money", agent.SYSTEM_PROMPT)
        self.assertIn("At most one offer per conversation", agent.SYSTEM_PROMPT)
