"""
Descript 渠道插件

将请求代理到 Descript AI Agent API (web.descript.com)，
上游响应为标准 OpenAI SSE 格式，直接复用 OpenAI 渠道的响应处理器。

核心功能：
1. 将 OpenAI 格式的请求转换为 Descript 上游格式（白名单字段）
2. 消息内容统一转为数组格式 [{type: "text", text: "..."}]
3. 思考参数适配：reasoning 原样透传；reasoning_effort / thinking 兼容转换
4. 努力程度适配：verbosity 原样透传；output_config.effort / 顶层 effort 兼容转换
5. 注入 Descript 专用请求头 (x-descript-app-*)
6. 响应直接复用 OpenAI 渠道的流式/非流式处理器（Descript 返回标准 OpenAI 格式）

配置示例（在 config.yaml 中）:
providers:
  - provider: descript
    engine: descript
    base_url: https://web.descript.com
    api:
      - <your_descript_bearer_token>
    model:
      - auto: auto
      - claude-sonnet-4.6: anthropic/claude-sonnet-4.6
      - claude-opus-4.6: anthropic/claude-opus-4.6
      - claude-haiku-4.5: anthropic/claude-haiku-4.5
      - claude-sonnet-4.5: anthropic/claude-sonnet-4.5
      - claude-opus-4.5: anthropic/claude-opus-4.5
      - gpt-5.4: openai/gpt-5.4
      - gemini-3.1-pro-preview: google/gemini-3.1-pro-preview
"""

import uuid
from typing import TYPE_CHECKING, Any, Dict, List, Optional

if TYPE_CHECKING:
    from core.plugins import PluginManager

from core.log_config import logger
from core.utils import get_model_dict

# ==================== Plugin Metadata ====================

PLUGIN_INFO = {
    "name": "descript_channel",
    "version": "1.0.0",
    "description": "Descript AI Agent 渠道插件 - 代理到 web.descript.com，响应为标准 OpenAI 格式",
    "author": "Zoaholic",
    "dependencies": [],
    "metadata": {
        "category": "channel",
        "tags": ["descript", "openai-compat", "claude", "gemini", "gpt"],
    },
}

EXTENSIONS = ["channels:descript"]

# ==================== Constants ====================

DEFAULT_BASE_URL = "https://web.descript.com"
UPSTREAM_PATH = "/v2/agent/completions"

# Descript 专用请求头
DESCRIPT_HEADERS = {
    "x-descript-app-build-number": "f82cd5fcb7a5fbdcafa3eaf2574af244d73e30ba",
    "x-descript-app-build-type": "release",
    "x-descript-app-id": "41d3f044-c92d-45d4-bb1c-6cc21f3aa5e8",
    "x-descript-app-version": "139.0.5",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/146.0.0.0 Safari/537.36"
    ),
}

# 上游支持的 effort 值
VALID_EFFORTS = frozenset({"xhigh", "high", "medium", "low", "minimal", "none"})

# 硬编码模型列表
DESCRIPT_MODELS = [
    "auto",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-opus-4.6",
    "anthropic/claude-haiku-4.5",
    "anthropic/claude-sonnet-4.5",
    "anthropic/claude-opus-4.5",
    "openai/gpt-5.4",
    "google/gemini-3.1-pro-preview",
]


# ==================== Helpers ====================

def _normalize_effort(effort: Any) -> str:
    """将 effort 值规范化为 Descript 支持的格式"""
    v = str(effort).lower()
    if v in VALID_EFFORTS:
        return v
    # 兼容 OpenAI 的 high/medium/low 映射
    return "medium"


def _extract_reasoning_config(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    从请求 payload 中提取思考参数，转换为 Descript reasoning 格式。

    支持的输入格式：
    1. reasoning: {...}              → 原样透传，不做任何处理
    2. reasoning_effort: "high"      → {effort: "high"}
    3. thinking: true                → {effort: "medium"}
    4. thinking: false               → {enabled: false}
    5. thinking.type: "enabled"      → {max_tokens: budget_tokens}
    6. thinking.type: "adaptive"     → {effort: "high"} (or 格式)
    7. thinking.type: "disabled"     → {enabled: false}
    8. 未传任何思考参数                → None（不传 reasoning）
    """
    # 优先级 1: reasoning → 原样透传，不做任何处理
    reasoning = payload.get("reasoning")
    if reasoning is not None and isinstance(reasoning, dict):
        return dict(reasoning)

    # 优先级 2: OpenAI reasoning_effort
    reasoning_effort = payload.get("reasoning_effort")
    if reasoning_effort is not None:
        effort = _normalize_effort(reasoning_effort)
        if effort == "none":
            return {"enabled": False}
        return {"effort": effort}

    # 优先级 3: Claude/Anthropic thinking
    thinking = payload.get("thinking")
    if thinking is not None:
        if thinking is True:
            return {"effort": "medium"}
        if thinking is False:
            return {"enabled": False}

        if isinstance(thinking, dict):
            t_type = thinking.get("type")

            if t_type == "adaptive":
                return {"effort": "high"}

            if t_type == "disabled" or thinking.get("enabled") is False:
                return {"enabled": False}

            if t_type == "enabled" or thinking.get("enabled") is True:
                budget = thinking.get("budget_tokens")
                if isinstance(budget, (int, float)) and budget > 0:
                    return {"max_tokens": int(budget)}
                return {"effort": "medium"}

    return None


def _extract_verbosity(payload: Dict[str, Any]) -> Optional[str]:
    """
    从请求 payload 中提取 verbosity 参数。

    支持的输入格式（按优先级）：
    1. verbosity: "..."               → 原样透传
    2. output_config.effort: "..."    → 取其值作为 verbosity
    3. effort: "..."（顶层）           → 取其值作为 verbosity
    4. 未传任何相关参数                → None（不传 verbosity）
    """
    # 优先级 1: verbosity → 原样透传
    verbosity = payload.get("verbosity")
    if verbosity is not None:
        return str(verbosity)

    # 优先级 2: output_config.effort
    output_config = payload.get("output_config")
    if isinstance(output_config, dict):
        oc_effort = output_config.get("effort")
        if oc_effort is not None:
            return str(oc_effort)

    # 优先级 3: 顶层 effort
    effort = payload.get("effort")
    if effort is not None:
        return str(effort)

    return None


def _convert_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    将 OpenAI 格式的 messages 转换为 Descript 上游格式。
    主要区别：content转为数组格式 [{type: "text", text: "..."}]
    """
    result = []
    for msg in messages:
        out: Dict[str, Any] = {"role": msg.get("role", "user")}

        content = msg.get("content")
        if isinstance(content, str):
            out["content"] = [{"type": "text", "text": content}]
        elif isinstance(content, list):
            # 已经是数组格式，确保 text 类型的结构正确
            out["content"] = [
                {"type": "text", "text": p.get("text", "")} if p.get("type") == "text" else p
                for p in content
            ]
        else:
            out["content"] = content

        # 透传可选字段
        if msg.get("name"):
            out["name"] = msg["name"]
        if msg.get("tool_calls"):
            out["tool_calls"] = msg["tool_calls"]
        if msg.get("tool_call_id"):
            out["tool_call_id"] = msg["tool_call_id"]

        result.append(out)
    return result


# ==================== Channel Adapter ====================

async def get_descript_payload(request, engine, provider, api_key=None):
    """
    构建 Descript 渠道的请求 payload。

    将 Zoaholic 标准请求转换为 Descript 上游格式（严格白名单）。
    """
    if not api_key:
        raise ValueError("Descript Bearer token is required (configured as api key)")

    model_dict = get_model_dict(provider)
    original_model = model_dict.get(request.model, request.model)

    # 构建上游 URL
    base_url = (provider.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
    url = f"{base_url}{UPSTREAM_PATH}"

    # 构建请求头
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
        **DESCRIPT_HEADERS,
    }

    # ---- 构建消息列表 ----
    raw_messages = []
    for msg in request.messages:
        m = {"role": msg.role}
        if isinstance(msg.content, list):
            m["content"] = [
                {"type": "text", "text": item.text}
                if hasattr(item, "type") and item.type == "text"
                else {"type": "text", "text": str(item)}
                for item in msg.content
            ]
        elif msg.content is not None:
            m["content"] = [{"type": "text", "text": str(msg.content)}]
        else:
            m["content"] = []

        if hasattr(msg, "name") and msg.name:
            m["name"] = msg.name
        if hasattr(msg, "tool_calls") and msg.tool_calls:
            m["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in msg.tool_calls
            ]
        if hasattr(msg, "tool_call_id") and msg.tool_call_id:
            m["tool_call_id"] = msg.tool_call_id

        raw_messages.append(m)

    # ---- 构建上游 payload（严格白名单） ----
    payload = {
        "conversation_id": str(uuid.uuid4()),
        "call_source": "main",
        "model": original_model,
        "messages": raw_messages,
        "stream": request.stream if request.stream is not None else True,
    }

    if request.temperature is not None:
        payload["temperature"] = request.temperature

    # 适配思考参数 + verbosity
    # 从 request 对象中提取可能存在的扩展属性
    raw_payload: Dict[str, Any] = {}
    for attr in ("reasoning", "reasoning_effort", "thinking", "verbosity", "output_config", "effort"):
        val = getattr(request, attr, None)
        if val is not None:
            raw_payload[attr] = val

    reasoning = _extract_reasoning_config(raw_payload)
    if reasoning is not None:
        payload["reasoning"] = reasoning

    # 适配 verbosity 参数
    verbosity = _extract_verbosity(raw_payload)
    if verbosity is not None:
        payload["verbosity"] = verbosity

    logger.info(
        f"[descript] Request: model={original_model}, "
        f"stream={payload.get('stream')}, "
        f"messages={len(raw_messages)}, "
        f"reasoning={reasoning}, "
        f"verbosity={verbosity}"
    )
    logger.debug(f"[descript] URL: {url}")

    return url, headers, payload


async def fetch_descript_models(client, provider):
    """返回 Descript 支持的模型列表（硬编码）"""
    return list(DESCRIPT_MODELS)


# ==================== Channel Definition ====================

class DescriptChannelAdapter:
    """Descript channel adapter class."""

    id = "descript"
    type_name = "openai"

    request_adapter = staticmethod(get_descript_payload)

    # 响应是标准 OpenAI 格式，直接复用 OpenAI 渠道的处理器
    @staticmethod
    async def _get_stream_adapter():
        from core.channels.openai_channel import fetch_gpt_response_stream
        return fetch_gpt_response_stream

    @staticmethod
    async def _get_response_adapter():
        from core.channels.openai_channel import fetch_openai_response
        return fetch_openai_response


# ==================== Plugin Lifecycle ====================

def setup(manager: "PluginManager"):
    """Plugin initialization."""
    from core.channels.openai_channel import fetch_gpt_response_stream, fetch_openai_response

    manager.register_extension(
        extension_point="channels",
        extension_id="descript",
        implementation=DescriptChannelAdapter,
        priority=100,
        metadata={
            "description": "Descript AI Agent channel (OpenAI-compatible response)",
            "supported_features": ["chat", "stream"],
        },
        plugin_name=PLUGIN_INFO["name"],
    )

    from core.channels.registry import register_channel

    try:
        register_channel(
            id=DescriptChannelAdapter.id,
            type_name="openai",
            default_base_url=DEFAULT_BASE_URL,
            auth_header="Authorization: Bearer {api_key}",
            description="Descript AI Agent - proxy to web.descript.com (OpenAI-compatible response)",
            request_adapter=DescriptChannelAdapter.request_adapter,
            stream_adapter=fetch_gpt_response_stream,
            response_adapter=fetch_openai_response,
            models_adapter=fetch_descript_models,
            overwrite=True,
        )
        logger.info(f"[{PLUGIN_INFO['name']}] Channel 'descript' registered successfully!")
    except Exception as e:
        logger.error(f"[{PLUGIN_INFO['name']}] Channel registration failed: {e}")


def teardown(manager: "PluginManager"):
    """Plugin cleanup."""
    manager.unregister_extension("channels", "descript")

    from core.channels.registry import unregister_channel
    unregister_channel("descript")

    logger.info(f"[{PLUGIN_INFO['name']}] Channel 'descript' unregistered!")


def unload():
    """Plugin unload callback."""
    logger.info(f"[{PLUGIN_INFO['name']}] Plugin unloading...")
