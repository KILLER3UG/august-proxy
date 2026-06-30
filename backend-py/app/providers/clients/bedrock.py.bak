"""AWS Bedrock Converse API client.

Uses the AWS SDK (boto3) to sign and send requests to Bedrock's Converse API.

Requires the ``boto3`` package (optional dependency). Falls back gracefully
when boto3 is not installed.
"""

from __future__ import annotations

from typing import Any, AsyncIterator

from app.providers.clients.base import BaseProviderClient, ProviderResponse


class BedrockClient(BaseProviderClient):
    """Client for AWS Bedrock Converse API (``api_mode: bedrock_converse``).

    Uses AWS SigV4 signing via boto3 for authentication rather than
    Bearer tokens.
    """

    api_format = "bedrock_converse"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._bedrock_runtime = None  # lazy init

    @property
    def _br(self) -> Any | None:
        """Lazy-initialized boto3 bedrock-runtime client."""
        if self._bedrock_runtime is not None:
            return self._bedrock_runtime
        try:
            import boto3  # type: ignore[import-untyped]

            region = self.config.get("region", self._resolve_env("AWS_REGION", "us-east-1"))
            self._bedrock_runtime = boto3.client("bedrock-runtime", region_name=region)
            return self._bedrock_runtime
        except ImportError:
            return None

    def resolve_api_key(self) -> str | None:
        """Bedrock uses AWS SDK credentials, not API keys.

        Returns a synthetic value to indicate AWS SDK auth is available.
        """
        # Check if AWS credentials are configured
        import os

        if os.environ.get("AWS_ACCESS_KEY_ID") or os.environ.get("AWS_PROFILE"):
            return "__aws_sdk__"
        return os.environ.get("AWS_ACCESS_KEY_ID")

    def build_auth_headers(self, api_key: str | None) -> dict[str, str]:
        """Bedrock uses SigV4 signing, not Bearer auth.

        Returns minimal headers; signing happens at the boto3 level.
        """
        return {"Content-Type": "application/json", "Accept": "application/json"}

    async def converse(
        self,
        body: dict[str, Any],
        api_key: str | None = None,
    ) -> ProviderResponse:
        """Non-streaming call to Bedrock Converse API."""
        br = self._br
        if br is None:
            return ProviderResponse(
                status=0,
                body={"error": "boto3 is not installed. Install with: pip install boto3"},
            )

        model_id = body.get("model", self.config.get("default_model", ""))
        messages = body.get("messages", [])
        system = body.get("system", [])
        tool_config = self._build_tool_config(body.get("tools", []))

        try:
            import asyncio

            response = await asyncio.to_thread(
                br.converse,
                modelId=model_id,
                messages=messages,
                system=system,
                toolConfig=tool_config,
                **self._extract_inference_config(body),
            )
            return ProviderResponse(
                status=200,
                body=response,  # type: ignore[arg-type]
            )
        except Exception as exc:
            return ProviderResponse(status=0, body={"error": str(exc)})

    async def converse_stream(
        self,
        body: dict[str, Any],
        api_key: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """Streaming call to Bedrock Converse Stream API."""
        br = self._br
        if br is None:
            yield {"type": "error", "error": "boto3 is not installed"}
            return

        model_id = body.get("model", self.config.get("default_model", ""))
        messages = body.get("messages", [])
        system = body.get("system", [])
        tool_config = self._build_tool_config(body.get("tools", []))

        try:
            import asyncio

            response = await asyncio.to_thread(
                br.converse_stream,
                modelId=model_id,
                messages=messages,
                system=system,
                toolConfig=tool_config,
                **self._extract_inference_config(body),
            )
            stream = response.get("stream", [])
            for event in stream:
                yield {"type": "bedrock_event", "event": event}

        except Exception as exc:
            yield {"type": "error", "error": str(exc)}

    def _resolve_env(self, name: str, default: str = "") -> str:
        import os

        return os.environ.get(name, default)

    def _extract_inference_config(self, body: dict[str, Any]) -> dict[str, Any]:
        config: dict[str, Any] = {}
        if "maxTokens" in body or "max_tokens" in body:
            config["maxTokens"] = body.get("maxTokens", body.get("max_tokens"))
        if "temperature" in body:
            config["temperature"] = body["temperature"]
        if "topP" in body or "top_p" in body:
            config["topP"] = body.get("topP", body.get("top_p"))
        if "stopSequences" in body:
            config["stopSequences"] = body["stopSequences"]
        return config

    def _build_tool_config(self, tools: list[dict[str, Any]]) -> dict[str, Any]:
        if not tools:
            return {}
        bedrock_tools = []
        for tool in tools:
            func = tool.get("function", tool)
            bedrock_tools.append({
                "toolSpec": {
                    "name": func.get("name", ""),
                    "description": func.get("description", ""),
                    "inputSchema": {"json": func.get("parameters", func.get("input_schema", {}))},
                }
            })
        return {"tools": bedrock_tools}
