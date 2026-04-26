"""
Descript 渠道插件

将请求代理到 Descript AI Agent API (web.descript.com)，
上游响应为标准 OpenAI SSE 格式，直接复用 OpenAI 渠道的响应处理器。

核心功能：
1. 将 OpenAI 格式的请求转换为 Descript 上游格式（白名单字段）
2. 消息内容统一转为数组格式 [{type: "text", text}]
3. 适配多种思考参数格式 (reasoning / reasoning_effort / thinking) → Descript reasoning
4. 注入 Descript 专用请求头 (x-descript-app-*)
5. 响应直接复用 OpenAI 渠道的流式/非流式处理器（Descript 返回标准 OpenAI 格式）

配置示例（在 config.yaml 中）:
providers:
  - provider: descript
    engine: descript
    base_url: https://web.descript.com
    preferences:
      enabled_plugins:
        - descript_channel    # version 从 /version 端点自动获取
    api:
      - <your_descript_app_id>:<your_project_id>:<your_descript_jwt_token>
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

import time
import uuid
from typing import TYPE_CHECKING, Any, Dict, List, Optional

if TYPE_CHECKING:
    from core.plugins import PluginManager

from core.log_config import logger
from core.utils import get_model_dict
from core.plugins import get_plugin_options
from core.plugins import (
    register_request_interceptor,
    unregister_request_interceptor,
)

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

EXTENSIONS = [
    "channels:descript",
    "interceptors:descript_channel_request",
]

# ==================== Constants ====================


DEFAULT_BASE_URL = "https://web.descript.com"
UPSTREAM_PATH = "/v2/agent/completions"

# Descript 专用请求头（固定部分，version/build 从 /version 端点动态获取）
DESCRIPT_HEADERS = {
    "x-descript-app-build-type": "release",
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/146.0.0.0 Safari/537.36"
    ),
}

FORCED_SYSTEM_PROMPT = "Agent Underlord"
FORCED_TOOLS = [
    {"type": "function", "function": {"name": "query_ai_voices"}},
    {"type": "function", "function": {"name": "query_brand_kit"}},
    {"type": "function", "function": {"name": "query_captions"}},
    {"type": "function", "function": {"name": "query_folders"}},
    {"type": "function", "function": {"name": "query_layouts"}},
    {"type": "function", "function": {"name": "query_media_library_v2"}},
    {"type": "function", "function": {"name": "query_scenes"}},
    {"type": "function", "function": {"name": "query_script_markdown"}},
    {"type": "function", "function": {"name": "query_speakers"}},
    {"type": "function", "function": {"name": "query_stock_avatars"}},
    {"type": "function", "function": {"name": "query_tracks_v2"}},
    {"type": "function", "function": {"name": "scene_screenshot"}},
    {"type": "function", "function": {"name": "search_stock_media"}},
    {"type": "function", "function": {"name": "shorten_word_gaps"}},
    {"type": "function", "function": {"name": "update_scene_properties"}},
    {"type": "function", "function": {"name": "wait_for_transcriptions"}},
    {"type": "function", "function": {"name": "get_dub_speakers"}},
    {"type": "function", "function": {"name": "update_translation_dub_and_speakers"}},
    {"type": "function", "function": {"name": "translate-composition"}},
    {"type": "function", "function": {"name": "search_help"}},
]

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

# payload 中由本适配器单独处理的字段，不参与通用透传
_SKIP_FIELDS = frozenset({
    "model", "messages", "stream", "temperature",
    # 思考参数由 _extract_reasoning_config 专门适配
    "reasoning", "reasoning_effort", "thinking",
    # 内部字段
    "request_type",
})

# ==================== Version Cache ====================

_version_cache: Dict[str, Any] = {}
_version_cache_ts: float = 0
_VERSION_CACHE_TTL = 3600  # 1 hour
_DEFAULT_APP_VERSION = "139.0.17"
_DEFAULT_BUILD = "11bf593753cd968d474759b9f03f6f36c943652b"


async def _fetch_descript_version(base_url: str = DEFAULT_BASE_URL) -> Dict[str, Any]:
    """Fetch app_version and build from Descript /version endpoint, with 1h cache."""
    global _version_cache, _version_cache_ts
    now = time.time()
    if _version_cache and (now - _version_cache_ts) < _VERSION_CACHE_TTL:
        return _version_cache
    try:
        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{base_url.rstrip('/')}/version")
            resp.raise_for_status()
            data = resp.json()
            _version_cache = {
                "app_version": data.get("app_version", _DEFAULT_APP_VERSION),
                "build": data.get("build", _DEFAULT_BUILD),
            }
            _version_cache_ts = now
            logger.info(f"[descript] Fetched version: v{_version_cache['app_version']} build={_version_cache['build'][:8]}...")
    except Exception as e:
        logger.warning(f"[descript] Failed to fetch /version: {e}, using cached/default")
        if not _version_cache:
            _version_cache = {"app_version": _DEFAULT_APP_VERSION, "build": _DEFAULT_BUILD}
    return _version_cache


# ==================== Helpers ====================

def _normalize_effort(effort: Any) -> str:
    """将 effort 值规范化为 Descript 支持的格式"""
    v = str(effort).lower()
    if v in VALID_EFFORTS:
        return v
    # 兼容 OpenAI 的 high/medium/low 映射
    return "medium"


def _extract_verbosity(payload: Dict[str, Any]) -> Optional[str]:
    verbosity = payload.get("verbosity")
    if verbosity is not None:
        return str(verbosity)
    output_config = payload.get("output_config")
    if isinstance(output_config, dict) and "effort" in output_config:
        return str(output_config["effort"])
    effort = payload.get("effort")
    if effort is not None:
        return str(effort)
    return None

def _extract_reasoning_config(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    从请求 payload 中提取并适配思考参数为 Descript reasoning 格式。

    支持的输入格式：
    1. reasoning: {...}              → 透传（校验 effort）
    2. reasoning_effort: "high"      → {effort: "high"}
    3. thinking: true                → {effort: "medium"}
    4. thinking: false               → {enabled: false}
    5. thinking.type: "enabled"      → {max_tokens: budget_tokens}
    6. thinking.type: "adaptive"     → {effort: "high"}
    7. thinking.type: "disabled"     → {enabled: false}
    8. 未传任何思考参数                → None（不传 reasoning）
    """
    # 优先级 1: reasoning
    reasoning = payload.get("reasoning")
    if reasoning is not None and isinstance(reasoning, dict):
        r = dict(reasoning)
        if "effort" in r:
            r["effort"] = _normalize_effort(r["effort"])
        return r

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




# ==================== Request Interceptor (no-op) ====================

async def _descript_noop_request_interceptor(request, engine, provider, api_key, url, headers, payload):
    """
    空操作请求拦截器。

    注册此拦截器的唯一目的是让 descript_channel 出现在前端的插件配置列表中，
    使用户可以通过 UI 设置 enabled_plugins: ['descript_channel:<version>'] 参数。
    实际的参数读取在 get_descript_payload 中通过 get_plugin_options 完成。
    """
    return url, headers, payload



# ==================== Channel Adapter ====================

async def get_descript_payload(request, engine, provider, api_key=None):
    """
    构建 Descript 渠道的请求 payload。

    将 Zoaholic 标准请求转换为 Descript 上游格式。
    """
    if not api_key:
        raise ValueError("Descript api key is required (format: app_id:project_id:jwt)")

    # 解析 api_key，格式为 app_id:project_id:jwt
    parts = api_key.split(":", 2)
    if len(parts) < 3:
        raise ValueError("Descript api key format error: expected 'app_id:project_id:jwt'")
    app_id, project_id, jwt_token = parts

    # 动态获取 app_version 和 build_number（插件参数可覆盖 version）
    base_url = (provider.get("base_url") or DEFAULT_BASE_URL).rstrip("/")
    version_override = get_plugin_options(PLUGIN_INFO["name"], provider)
    version_info = await _fetch_descript_version(base_url)
    app_version = version_override or version_info.get("app_version", _DEFAULT_APP_VERSION)
    build_number = version_info.get("build", _DEFAULT_BUILD)

    model_dict = get_model_dict(provider)
    original_model = model_dict.get(request.model, request.model)

    # 构建上游 URL
    url = f"{base_url}{UPSTREAM_PATH}"

    # 构建请求头
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {jwt_token}",
        "x-descript-app-id": app_id,
        "x-descript-app-version": app_version,
        "x-descript-app-build-number": build_number,
        **DESCRIPT_HEADERS,
    }

    # ---- 构建消息列表 ----
    system_texts = []
    non_system_msgs = []
    for msg in request.messages:
        if msg.role == "system":
            if isinstance(msg.content, list):
                parts = []
                for item in msg.content:
                    if hasattr(item, 'text') and item.text:
                        parts.append(item.text)
                    elif isinstance(item, dict) and item.get("type") == "text" and "text" in item:
                        parts.append(item["text"])
                text = "\n".join(parts)
            elif msg.content is not None:
                text = str(msg.content)
            else:
                text = ""
            if text.strip():
                system_texts.append(text.strip())
        else:
            non_system_msgs.append(msg)
            
    final_system_text = FORCED_SYSTEM_PROMPT
    if system_texts:
        final_system_text += "\n" + "\n".join(system_texts)
        
    raw_messages = [{"role": "system", "content": [{"type": "text", "text": final_system_text}]}]

    for msg in non_system_msgs:
        m = {"role": msg.role}
        if isinstance(msg.content, list):
            m["content"] = [
                item.model_dump(exclude_none=True) if hasattr(item, 'model_dump') else item
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

    # ---- 构建上游 payload ----
    payload = {
        "project": {"id": project_id},
        "conversation_id": str(uuid.uuid4()),
        "call_source": "main",
        "harness_id": "mammoth-haiku45",
        "model": original_model,
        "messages": raw_messages,
        "stream": request.stream if request.stream is not None else True,
    }

    if request.temperature is not None:
        payload["temperature"] = request.temperature

    # ---- 强制伪装 tools ----
    payload["tools"] = FORCED_TOOLS

    # ---- 适配思考与冗长参数 ----
    raw_payload: Dict[str, Any] = {}
    for attr in ("reasoning", "reasoning_effort", "thinking", "verbosity", "output_config", "effort"):
        val = getattr(request, attr, None)
        if val is not None:
            raw_payload[attr] = val
            
    # 如果 request 有 extra_body 也可以提取
    extra_body = getattr(request, "extra_body", None) or {}
    if isinstance(extra_body, dict):
        for attr in ("verbosity", "output_config", "effort"):
            if attr in extra_body and attr not in raw_payload:
                raw_payload[attr] = extra_body[attr]

    reasoning = _extract_reasoning_config(raw_payload)
    if reasoning is not None:
        payload["reasoning"] = reasoning
        
    verbosity = _extract_verbosity(raw_payload)
    if verbosity is not None:
        payload["verbosity"] = verbosity

    logger.info(
        f"[descript] Request: model={original_model}, "
        f"stream={payload.get('stream')}, "
        f"messages={len(raw_messages)}, "
        f"tools={len(payload.get('tools', []) or [])}, "
        f"reasoning={reasoning}"
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

    register_request_interceptor(
        interceptor_id="descript_channel_request",
        callback=_descript_noop_request_interceptor,
        priority=100,
        plugin_name=PLUGIN_INFO["name"],
        metadata={
            "description": "Descript 渠道参数占位拦截器",
            "params_hint": "可选: 指定 app_version 覆盖自动获取",
        },
    )

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

    unregister_request_interceptor("descript_channel_request")

    from core.channels.registry import unregister_channel
    unregister_channel("descript")

    logger.info(f"[{PLUGIN_INFO['name']}] Channel 'descript' unregistered!")


def unload():
    """Plugin unload callback."""
    logger.info(f"[{PLUGIN_INFO['name']}] Plugin unloading...")
