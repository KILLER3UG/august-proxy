"""AWS Bedrock Converse API client.

Uses the AWS SDK (boto3) to sign and send requests to Bedrock's Converse API.

Requires the ``boto3`` package (optional dependency). Falls back gracefully
when boto3 is not installed.
"""

from __future__ import annotations
from typing import Any, AsyncIterator, cast
from app.json_narrowing import as_str, as_dict, as_list
from app.providers.clients.base import BaseProviderClient, ProviderResponse


class BedrockClient(BaseProviderClient):
    """Client for AWS Bedrock Converse API (``api_mode: bedrock_converse``).

    Uses AWS SigV4 signing via boto3 for authentication rather than
    Bearer tokens.
    """

    apiFormat = 'bedrockConverse'

    def __init__(self, providerConfig: dict[str, object], *, timeout: float = 300.0, maxRetries: int = 3) -> None:
        super().__init__(providerConfig, timeout=timeout, maxRetries=maxRetries)
        self._bedrockRuntime = None

    @property
    def _br(self) -> object | None:
        """Lazy-initialized boto3 bedrock-runtime client."""
        if self._bedrockRuntime is not None:
            return self._bedrockRuntime
        try:
            import boto3

            region = as_str(self.config.get('region'), self._resolveEnv('AWS_REGION', 'us-east-1'))
            self._bedrockRuntime = boto3.client('bedrock-runtime', region_name=region)
            return self._bedrockRuntime
        except ImportError:
            return None

    def resolveApiKey(self) -> str | None:
        """Bedrock uses AWS SDK credentials, not API keys.

        Returns a synthetic value to indicate AWS SDK auth is available.
        """
        import os

        if os.environ.get('AWS_ACCESS_KEY_ID') or os.environ.get('AWS_PROFILE'):
            return '__aws_sdk__'
        return os.environ.get('AWS_ACCESS_KEY_ID')

    def buildAuthHeaders(self, apiKey: str | None) -> dict[str, str]:
        """Bedrock uses SigV4 signing, not Bearer auth.

        Returns minimal headers; signing happens at the boto3 level.
        """
        return {'Content-Type': 'application/json', 'Accept': 'application/json'}

    async def converse(self, body: dict[str, object], apiKey: str | None = None) -> ProviderResponse:
        """Non-streaming call to Bedrock Converse API."""
        br = self._br
        if br is None:
            return ProviderResponse(status=0, body={'error': 'boto3 is not installed. Install with: pip install boto3'})
        modelId = as_str(body.get('model'), as_str(self.config.get('defaultModel'), ''))
        messages = as_list(body.get('messages'), [])
        system = as_list(body.get('system'), [])
        toolConfig = self._buildToolConfig(as_list(body.get('tools'), []))
        try:
            import asyncio

            response = await asyncio.to_thread(
                cast(Any, br).converse,
                modelId=modelId,
                messages=messages,
                system=system,
                toolConfig=toolConfig,
                **self._extractInferenceConfig(body),
            )
            return ProviderResponse(status=200, body=response)
        except Exception as exc:
            return ProviderResponse(status=0, body={'error': str(exc)})

    async def converseStream(
        self, body: dict[str, object], apiKey: str | None = None
    ) -> AsyncIterator[dict[str, object]]:
        """Streaming call to Bedrock Converse Stream API."""
        br = self._br
        if br is None:
            yield {'type': 'error', 'error': 'boto3 is not installed'}
            return
        modelId = as_str(body.get('model'), as_str(self.config.get('defaultModel'), ''))
        messages = as_list(body.get('messages'), [])
        system = as_list(body.get('system'), [])
        toolConfig = self._buildToolConfig(as_list(body.get('tools'), []))
        try:
            import asyncio

            response = await asyncio.to_thread(
                cast(Any, br).converse_stream,
                modelId=modelId,
                messages=messages,
                system=system,
                toolConfig=toolConfig,
                **self._extractInferenceConfig(body),
            )
            stream = response.get('stream', [])
            for event in stream:
                yield {'type': 'bedrock_event', 'event': event}
        except Exception as exc:
            yield {'type': 'error', 'error': str(exc)}

    def _resolveEnv(self, name: str, default: str = '') -> str:
        import os

        return os.environ.get(name, default)

    def _extractInferenceConfig(self, body: dict[str, object]) -> dict[str, object]:
        config: dict[str, object] = {}
        if 'maxTokens' in body or 'max_tokens' in body:
            config['maxTokens'] = body.get('maxTokens', body.get('max_tokens'))
        if 'temperature' in body:
            config['temperature'] = body['temperature']
        if 'topP' in body or 'top_p' in body:
            config['topP'] = body.get('topP', body.get('top_p'))
        if 'stopSequences' in body:
            config['stopSequences'] = body['stopSequences']
        return config

    def _buildToolConfig(self, tools: list[object]) -> dict[str, object]:
        if not tools:
            return {}
        bedrockTools = []
        for tool in tools:
            toolDict = as_dict(tool)
            func = as_dict(toolDict.get('function'), {})
            bedrockTools.append(
                {
                    'toolSpec': {
                        'name': as_str(func.get('name'), ''),
                        'description': as_str(func.get('description'), ''),
                        'inputSchema': {'json': as_dict(func.get('parameters'), as_dict(func.get('input_schema'), {}))},
                    }
                }
            )
        return {'tools': bedrockTools}
