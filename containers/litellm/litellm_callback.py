"""Speedwave usage logger for the LiteLLM proxy container.

Appends one JSON line per LLM request to ``SPW_USAGE_PATH`` (default
``/usage/usage.jsonl`` — a per-project bind mount read by the host-side
aggregator in ``speedwave-runtime``).

Two capture paths, mutually exclusive per request (validated against
litellm 1.88.1, see ADR-073):

- ``success/failure events`` — non-streaming requests on every route, and
  streaming requests on the ``/anthropic`` passthrough route (passthrough
  logging assembles a complete ``ModelResponse`` and emits a success event
  with ``call_type`` containing ``pass_through``).
- ``async_post_call_streaming_iterator_hook`` — streaming requests on the
  unified ``/v1/messages`` route backed by bridged (non-Anthropic)
  providers. litellm's logging bridge does NOT emit success events for
  those (observed on 1.88.1 and 1.89.0rc2), so usage is read from the raw
  SSE frames: ``input_tokens``/``output_tokens`` arrive in the final
  ``message_delta`` event (bridged providers do not populate
  ``message_start`` usage).

Every line carries ``capture`` naming the path; the host-side aggregator
deduplicates by ``(capture, response_id)`` should a future litellm version
start emitting success events for streamed unified-route requests too.

This file must stay dependency-free beyond litellm itself — it is baked
into the image and runs inside the hardened container (read-only fs; the
only writable paths are /tmp and the /usage mount).
"""

import datetime
import json
import os
import time

import litellm

USAGE_PATH = os.environ.get("SPW_USAGE_PATH", "/usage/usage.jsonl")


def _append(line: dict) -> None:
    try:
        with open(USAGE_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(line, separators=(",", ":")) + "\n")
    except OSError:
        # Usage logging must never break inference; the aggregator treats
        # gaps as "no data", not as an error.
        pass


def _ts() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def _requested_model(kwargs):
    """Client-requested model name (provider-prefixed route, e.g. ``local/x``).

    ``kwargs["model"]`` is the deployment resolved by wildcard routing — the
    provider prefix is stripped, so it differs from what the iterator hook
    logs (``request_data["model"]``) and the same model would split into two
    aggregator rows. Prefer the original proxy request body, then the router
    model group, falling back to the resolved name.
    """
    params = kwargs.get("litellm_params") or {}
    metadata = params.get("metadata") or {}
    proxy_request = (
        params.get("proxy_server_request")
        or metadata.get("proxy_server_request")
        or {}
    )
    body = proxy_request.get("body") or {}
    return body.get("model") or metadata.get("model_group") or kwargs.get("model")


def _sse_frame_as_dict(chunk):
    """Parse a raw SSE frame (bytes/str) or dict-like chunk into a dict."""
    if isinstance(chunk, dict):
        return chunk
    if isinstance(chunk, (bytes, str)):
        text = chunk.decode("utf-8", "replace") if isinstance(chunk, bytes) else chunk
        for line in text.split("\n"):
            if line.startswith("data: "):
                try:
                    return json.loads(line[6:])
                except (json.JSONDecodeError, ValueError):
                    return None
        return None
    dump = getattr(chunk, "model_dump", None)
    if callable(dump):
        try:
            return dump()
        except Exception:
            return None
    return None


class SpeedwaveUsageLogger(litellm.integrations.custom_logger.CustomLogger):
    """Writes per-request usage lines; see module docstring for the paths."""

    def _write_event(self, kwargs, response_obj, start_time, end_time, status):
        call_type = str(kwargs.get("call_type") or "")
        # Streaming unified-route requests never reach success events; when
        # they are streamed AND not passthrough, the iterator hook owns them.
        if kwargs.get("stream") and "pass_through" not in call_type:
            return
        usage = {}
        response_id = None
        if response_obj is not None:
            response_id = getattr(response_obj, "id", None)
            raw_usage = getattr(response_obj, "usage", None)
            if raw_usage is not None:
                usage = {
                    "prompt_tokens": getattr(raw_usage, "prompt_tokens", 0) or 0,
                    "completion_tokens": getattr(raw_usage, "completion_tokens", 0)
                    or 0,
                }
                details = getattr(raw_usage, "prompt_tokens_details", None)
                cached = getattr(details, "cached_tokens", None) if details else None
                if cached:
                    usage["cache_read"] = cached
        _append(
            {
                "ts": _ts(),
                "capture": "success_event",
                "status": status,
                "model": _requested_model(kwargs),
                "response_id": response_id,
                "cost_usd": kwargs.get("response_cost"),
                "latency_ms": int((end_time - start_time).total_seconds() * 1000),
                **usage,
            }
        )

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._write_event(kwargs, response_obj, start_time, end_time, "success")

    def log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._write_event(kwargs, response_obj, start_time, end_time, "failure")

    async def async_log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._write_event(kwargs, response_obj, start_time, end_time, "success")

    async def async_log_failure_event(self, kwargs, response_obj, start_time, end_time):
        self._write_event(kwargs, response_obj, start_time, end_time, "failure")

    async def async_post_call_streaming_iterator_hook(
        self, user_api_key_dict, response, request_data
    ):
        start = datetime.datetime.now()
        response_id = None
        input_tokens = 0
        output_tokens = 0
        cache_read = 0
        cache_write = 0
        saw_usage = False
        async for chunk in response:
            d = _sse_frame_as_dict(chunk)
            if d:
                kind = d.get("type")
                if kind == "message_start":
                    message = d.get("message") or {}
                    response_id = message.get("id") or response_id
                    mu = message.get("usage") or {}
                    input_tokens = mu.get("input_tokens", 0) or 0
                    cache_read = mu.get("cache_read_input_tokens", 0) or 0
                    cache_write = mu.get("cache_creation_input_tokens", 0) or 0
                    saw_usage = saw_usage or bool(mu)
                elif kind == "message_delta":
                    du = d.get("usage") or {}
                    output_tokens = du.get("output_tokens", output_tokens) or 0
                    # Bridged providers report input_tokens here, not in
                    # message_start.
                    input_tokens = du.get("input_tokens", input_tokens) or input_tokens
                    saw_usage = saw_usage or bool(du)
            yield chunk
        # Only streamed unified-route responses flow through this hook with
        # anthropic-format SSE frames; if no usage was seen the stream was a
        # different shape (or errored upstream) — skip rather than log zeros.
        if not saw_usage:
            return
        _append(
            {
                "ts": _ts(),
                "capture": "stream_iterator",
                "status": "success",
                "model": request_data.get("model"),
                "response_id": response_id,
                "latency_ms": int(
                    (datetime.datetime.now() - start).total_seconds() * 1000
                ),
                "prompt_tokens": input_tokens,
                "completion_tokens": output_tokens,
                "cache_read": cache_read,
                "cache_write": cache_write,
            }
        )


speedwave_usage_logger = SpeedwaveUsageLogger()
