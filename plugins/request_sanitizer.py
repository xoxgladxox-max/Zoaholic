"""请求参数清洗插件（request_sanitizer）

定位：
- 作为"请求拦截器插件"运行，在请求发送到上游之前修正常见的非法/不兼容参数。
- 仅当渠道在 provider.preferences.enabled_plugins 显式启用本插件时生效。

修正规则（始终生效）：
1. 强制流式：将 stream 设为 True
2. 温度范围：将 temperature 钳制到 [0, 1]
3. 移除 safety_settings：上游不接受该参数（"safety_settings: Extra inputs are not permitted"）
4. 修正空 system 消息：移除内容为空白的 system 消息
   （"system: text content blocks must contain non-whitespace text"）
5. 修正空顶层 system 字段：移除 Claude API 格式中空白的顶层 "system" 字段
6. 解决 temperature/top_p 冲突：部分模型不允许同时传 temperature 和 top_p，
   当两者同时存在时移除 top_p（保留 temperature）

可选参数（通过 enabled_plugins 配置）：
- "request_sanitizer"                → 仅执行上述默认修正规则
- "request_sanitizer:merge_system"   → 额外合并连续的 system 消息为一条
- "request_sanitizer:merge_all"      → 额外合并所有连续同角色消息（system/user/assistant 等）
- "request_sanitizer:ensure_system"  → 若 messages 中没有 system 消息，在开头插入一条空 system

参数可组合使用（逗号分隔），如 "request_sanitizer:merge_system,ensure_system"

配置位置：
- provider.preferences.enabled_plugins 中添加 "request_sanitizer" 或 "request_sanitizer:merge_system" 等
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Set, Tuple

from core.log_config import logger
from core.plugins import register_request_interceptor, unregister_request_interceptor
from core.plugins.interceptors import get_plugin_options


PLUGIN_NAME = "request_sanitizer"

PLUGIN_INFO = {
    "name": PLUGIN_NAME,
    "version": "1.1.0",
    "description": "请求参数清洗插件 - 自动修正常见非法参数，可选合并连续同角色消息",
    "author": "Zoaholic Team",
    "dependencies": [],
    "metadata": {
        "category": "interceptors",
        "tags": ["sanitizer", "compat", "payload", "merge"],
        "params_hint": (
            "参数格式：request_sanitizer[:merge_system|merge_all]\n"
            "  (空)          = 仅默认清洗规则\n"
            "  merge_system  = 额外合并连续 system 消息\n"
            "  merge_all     = 额外合并所有连续同角色消息\n"
            "  ensure_system = 若无 system 消息则在开头插入一条\n"
            "  可组合: merge_system,ensure_system"
        ),
    },
}

EXTENSIONS = [
    "interceptors:request_sanitizer_request",
]


# ==================== 清洗函数 ====================

def _force_stream(payload: Dict[str, Any]) -> bool:
    """强制开启流式，返回是否做了修改"""
    if not payload.get("stream"):
        payload["stream"] = True
        return True
    return False


def _clamp_temperature(payload: Dict[str, Any]) -> bool:
    """将 temperature 钳制到 [0, 1] 范围，返回是否做了修改"""
    temp = payload.get("temperature")
    if temp is None or not isinstance(temp, (int, float)):
        return False

    original = temp
    clamped = max(0.0, min(1.0, float(temp)))
    if clamped != original:
        payload["temperature"] = clamped
        return True
    return False


def _fix_temperature_top_p_conflict(payload: Dict[str, Any]) -> bool:
    """当 temperature 和 top_p 同时存在时移除 top_p，返回是否做了修改

    部分模型（如 OpenAI o1/o3 系列）不允许同时指定 temperature 和 top_p，
    报错："temperature and top_p cannot both be specified for this model"
    策略：保留 temperature，移除 top_p。
    """
    has_temp = "temperature" in payload and payload["temperature"] is not None
    has_top_p = "top_p" in payload and payload["top_p"] is not None

    if has_temp and has_top_p:
        del payload["top_p"]
        return True
    return False


def _remove_safety_settings(payload: Dict[str, Any]) -> bool:
    """移除 safety_settings 参数，返回是否做了修改"""
    if "safety_settings" in payload:
        del payload["safety_settings"]
        return True
    return False


def _is_blank_text(content: Any) -> bool:
    """判断 content 是否为空白文本"""
    if isinstance(content, str):
        return not content.strip()
    # content 可能是 list 格式 [{"type": "text", "text": "..."}]
    if isinstance(content, list):
        # 如果列表为空，视为空白
        if not content:
            return True
        # 检查所有 text block 是否都为空白
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "text":
                    text = item.get("text", "")
                    if isinstance(text, str) and text.strip():
                        return False
                else:
                    # 非 text 类型的 block（如 image），不算空白
                    return False
            else:
                return False
        return True
    # None 也视为空白
    if content is None:
        return True
    return False


def _fix_empty_top_level_system(payload: Dict[str, Any]) -> bool:
    """移除空白的顶层 system 字段（Claude API 格式），返回是否做了修改

    Claude API 使用顶层 "system" 字段而非 messages 数组中的 system 消息。
    当该字段为纯空白文本时，Claude 会拒绝请求：
    "system: text content blocks must contain non-whitespace text"
    """
    system = payload.get("system")
    if system is None:
        return False

    # 字符串格式：直接检查是否为空白
    if isinstance(system, str):
        if not system.strip():
            del payload["system"]
            return True
        return False

    # 列表格式 [{"type": "text", "text": "..."}]：复用已有的 _is_blank_text
    if isinstance(system, list) and _is_blank_text(system):
        del payload["system"]
        return True

    return False


def _fix_empty_system_messages(payload: Dict[str, Any]) -> bool:
    """移除内容为空白的 system 消息，返回是否做了修改"""
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        return False

    original_len = len(messages)
    cleaned = [
        msg for msg in messages
        if not (
            isinstance(msg, dict)
            and msg.get("role") == "system"
            and _is_blank_text(msg.get("content"))
        )
    ]

    if len(cleaned) < original_len:
        payload["messages"] = cleaned
        return True
    return False


# ==================== 合并函数 ====================

def _get_text_content(content: Any) -> str:
    """从 content 中提取纯文本（兼容 str 和 list 格式）"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
        return "\n".join(parts)
    return str(content) if content is not None else ""


def _is_text_only_message(msg: Dict[str, Any]) -> bool:
    """判断消息是否仅包含文本内容（不含图片等多模态内容）"""
    content = msg.get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        return all(
            isinstance(item, dict) and item.get("type") == "text"
            for item in content
        )
    if content is None:
        return True
    return False


def _merge_consecutive_messages(
    payload: Dict[str, Any],
    merge_roles: Optional[Set[str]] = None,
) -> bool:
    """合并连续的同角色消息为一条，返回是否做了修改。

    Args:
        payload: 请求 payload
        merge_roles: 要合并的角色集合，None 表示合并所有角色。
                     例如 {"system"} 只合并连续 system，
                     {"system", "user", "assistant"} 合并所有。

    合并规则：
    - 只合并连续的、角色相同的消息
    - 只合并纯文本消息（含图片/tool_calls 等的不合并）
    - 合并时用 \n\n 连接内容
    - 保留第一条消息的其他字段（如 name）
    """
    messages = payload.get("messages")
    if not isinstance(messages, list) or len(messages) <= 1:
        return False

    merged: List[Dict[str, Any]] = []
    i = 0

    while i < len(messages):
        current = messages[i]
        if not isinstance(current, dict):
            merged.append(current)
            i += 1
            continue

        current_role = current.get("role", "")

        # 检查是否需要合并该角色
        should_merge = (
            merge_roles is None or current_role in merge_roles
        ) and _is_text_only_message(current)

        if not should_merge:
            merged.append(current)
            i += 1
            continue

        # 收集连续同角色的纯文本消息
        group_texts = [_get_text_content(current.get("content"))]
        j = i + 1
        while j < len(messages):
            nxt = messages[j]
            if (
                isinstance(nxt, dict)
                and nxt.get("role") == current_role
                and _is_text_only_message(nxt)
                # 不合并带 tool_calls 或 tool_call_id 的消息
                and not nxt.get("tool_calls")
                and not nxt.get("tool_call_id")
            ):
                group_texts.append(_get_text_content(nxt.get("content")))
                j += 1
            else:
                break

        if j > i + 1:
            # 有多条可以合并
            merged_msg = dict(current)  # 保留第一条的字段
            merged_msg["content"] = "\n\n".join(group_texts)
            merged.append(merged_msg)
        else:
            # 只有一条，原样保留
            merged.append(current)

        i = j

    if len(merged) < len(messages):
        payload["messages"] = merged
        return True
    return False


# ==================== 补全函数 ====================

def _ensure_system_message(payload: Dict[str, Any]) -> bool:
    """若 messages 中没有 system 角色的消息，在开头插入一条空 system 消息。

    某些渠道/上游强制要求 messages 中至少包含一条 system 消息，
    缺少时会报错。本函数在开头补一条 {role: "system", content: ""}。
    """
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return False

    has_system = any(
        isinstance(msg, dict) and msg.get("role") == "system"
        for msg in messages
    )
    if not has_system:
        messages.insert(0, {"role": "system", "content": ""})
        return True
    return False


# ==================== 拦截器主函数 ====================

async def request_sanitizer_request_interceptor(
    request: Any,
    engine: str,
    provider: Dict[str, Any],
    api_key: Optional[str],
    url: str,
    headers: Dict[str, Any],
    payload: Dict[str, Any],
) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
    if not isinstance(payload, dict) or not payload:
        return url, headers, payload

    fixes: List[str] = []

    # ── 默认清洗规则（始终执行） ──

    if _force_stream(payload):
        fixes.append("stream=true")

    if _clamp_temperature(payload):
        fixes.append(f"temperature={payload['temperature']}")

    if _fix_temperature_top_p_conflict(payload):
        fixes.append("removed top_p (conflicts with temperature)")

    if _remove_safety_settings(payload):
        fixes.append("removed safety_settings")

    if _fix_empty_system_messages(payload):
        fixes.append("removed empty system messages")

    if _fix_empty_top_level_system(payload):
        fixes.append("removed empty top-level system field")

    # ── 可选参数（支持逗号组合，如 merge_system,ensure_system） ──

    options = get_plugin_options(PLUGIN_NAME, provider) or ""
    # 兼容用户误填完整格式 "request_sanitizer:xxx"
    if options.startswith(PLUGIN_NAME + ":"):
        options = options[len(PLUGIN_NAME) + 1:]

    option_set = set(
        opt.strip().lower()
        for opt in (options.strip().split(",") if options.strip() else [])
        if opt.strip()
    )

    if "merge_system" in option_set:
        before_count = len(payload.get("messages", []))
        if _merge_consecutive_messages(payload, merge_roles={"system"}):
            after_count = len(payload.get("messages", []))
            fixes.append(f"merged consecutive system messages ({before_count} → {after_count})")

    if "merge_all" in option_set:
        before_count = len(payload.get("messages", []))
        if _merge_consecutive_messages(payload, merge_roles=None):
            after_count = len(payload.get("messages", []))
            fixes.append(f"merged consecutive same-role messages ({before_count} → {after_count})")

    if "ensure_system" in option_set:
        if _ensure_system_message(payload):
            fixes.append("inserted empty system message at beginning")

    # ── 日志 ──

    if fixes:
        logger.info(
            f"[{PLUGIN_NAME}] Sanitized payload: {', '.join(fixes)} "
            f"(engine={engine}, model={payload.get('model', '?')})"
        )

    return url, headers, payload


# ==================== 插件生命周期 ====================

def setup(manager):
    logger.info(f"[{PLUGIN_NAME}] 正在初始化...")

    register_request_interceptor(
        interceptor_id="request_sanitizer_request",
        callback=request_sanitizer_request_interceptor,
        priority=900,
        plugin_name=PLUGIN_NAME,
        metadata={"description": "请求参数清洗（强制流式、温度范围、移除非法字段、修复空系统消息、可选合并消息）"},
        overwrite=True,
    )

    logger.info(f"[{PLUGIN_NAME}] 已注册请求拦截器")


def teardown(manager):
    logger.info(f"[{PLUGIN_NAME}] 正在清理...")
    unregister_request_interceptor("request_sanitizer_request")
    logger.info(f"[{PLUGIN_NAME}] 已清理完成")
