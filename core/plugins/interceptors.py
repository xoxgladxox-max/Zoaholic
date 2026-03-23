"""
请求/响应拦截器系统

提供 request 和 response 两个拦截点，允许插件在请求发送前和响应返回后进行拦截和处理。

支持插件参数：
- enabled_plugins 格式：["plugin_name:options", "plugin_name", ...]
- 例如：["gthink:max", "claude_thinking", "my_plugin:foo,bar"]
- 插件内部通过 parse_plugin_options() 或 get_plugin_options() 读取参数

使用方式：
```python
from core.plugins.interceptors import (
    register_request_interceptor,
    register_response_interceptor,
    get_plugin_options,
)

# 注册请求拦截器
async def my_request_interceptor(request, engine, provider, api_key, url, headers, payload):
    # 读取插件参数（从 provider 中解析）
    options = get_plugin_options("my_plugin", provider)
    # options 是字符串，如 "max" 或 "foo,bar"，插件自行解析
    
    if options == "max":
        payload["custom_param"] = 9999
    elif options:
        parts = options.split(",")
        # ...
    
    return url, headers, payload

register_request_interceptor("my_plugin", my_request_interceptor, priority=50)

# 注册响应拦截器
async def my_response_interceptor(response_chunk, engine, model, is_stream):
    # 处理响应
    return response_chunk

register_response_interceptor("my_plugin", my_response_interceptor, priority=50)
```
"""

from typing import Any, Callable, Dict, List, Optional, Tuple, Union
from dataclasses import dataclass, field
import asyncio
from contextvars import ContextVar
from contextlib import asynccontextmanager
import re

from ..log_config import logger


# ==================== 插件参数解析工具 ====================

# 响应拦截器调用期间的 enabled_plugins 上下文
# 由 apply_response_interceptors 在调用回调前设置，插件通过 get_current_plugin_options() 读取
_current_enabled_plugins: ContextVar[Optional[List[str]]] = ContextVar('_current_enabled_plugins', default=None)

def parse_plugin_entry(entry: str) -> Tuple[str, Optional[str]]:
    """
    解析单个插件条目，分离插件名和参数
    
    格式：plugin_name 或 plugin_name:options
    
    Args:
        entry: 插件条目字符串，如 "gthink:max" 或 "claude_thinking"
        
    Returns:
        (plugin_name, options) 元组，options 可能为 None
        
    Examples:
        >>> parse_plugin_entry("gthink:max")
        ("gthink", "max")
        >>> parse_plugin_entry("gthink:12000")
        ("gthink", "12000")
        >>> parse_plugin_entry("claude_thinking")
        ("claude_thinking", None)
        >>> parse_plugin_entry("my_plugin:foo,bar")
        ("my_plugin", "foo,bar")
    """
    if not entry or not isinstance(entry, str):
        return ("", None)
    
    entry = entry.strip()
    if not entry:
        return ("", None)
    
    # 查找第一个冒号
    colon_idx = entry.find(":")
    if colon_idx == -1:
        # 没有冒号，整个是插件名
        return (entry, None)
    
    plugin_name = entry[:colon_idx].strip()
    options = entry[colon_idx + 1:].strip()
    
    return (plugin_name, options if options else None)


def parse_enabled_plugins(enabled_plugins: Optional[List[str]]) -> Dict[str, Optional[str]]:
    """
    解析 enabled_plugins 列表，返回 {plugin_name: options} 映射
    
    Args:
        enabled_plugins: 插件列表，如 ["gthink:max", "claude_thinking", "my_plugin:foo,bar"]
        
    Returns:
        {plugin_name: options} 字典，options 可能为 None
        
    Examples:
        >>> parse_enabled_plugins(["gthink:max", "claude_thinking"])
        {"gthink": "max", "claude_thinking": None}
    """
    if not enabled_plugins or not isinstance(enabled_plugins, list):
        return {}
    
    result = {}
    for entry in enabled_plugins:
        plugin_name, options = parse_plugin_entry(entry)
        if plugin_name:
            result[plugin_name] = options
    
    return result


def get_plugin_options(plugin_name: str, provider: Dict[str, Any]) -> Optional[str]:
    """
    从 provider 配置中获取指定插件的参数
    
    这是插件内部读取参数的推荐方式。
    
    Args:
        plugin_name: 插件名称
        provider: 提供商配置（包含 preferences.enabled_plugins）
        
    Returns:
        插件参数字符串，如果没有参数则返回 None
        
    Examples:
        # provider = {"preferences": {"enabled_plugins": ["gthink:max", "claude_thinking"]}}
        >>> get_plugin_options("gthink", provider)
        "max"
        >>> get_plugin_options("claude_thinking", provider)
        None
        >>> get_plugin_options("not_enabled", provider)
        None
    """
    prefs = provider.get("preferences") if isinstance(provider, dict) else None
    if not prefs or not isinstance(prefs, dict):
        return None
    
    enabled_plugins = prefs.get("enabled_plugins")
    if not enabled_plugins or not isinstance(enabled_plugins, list):
        return None
    
    plugin_options = parse_enabled_plugins(enabled_plugins)
    return plugin_options.get(plugin_name)


def is_plugin_enabled(plugin_name: str, provider: Dict[str, Any]) -> bool:
    """
    检查指定插件是否在 provider 中启用
    
    Args:
        plugin_name: 插件名称
        provider: 提供商配置
        
    Returns:
        是否启用
    """
    prefs = provider.get("preferences") if isinstance(provider, dict) else None
    if not prefs or not isinstance(prefs, dict):
        return False
    
    enabled_plugins = prefs.get("enabled_plugins")
    if not enabled_plugins or not isinstance(enabled_plugins, list):
        return False
    
    plugin_options = parse_enabled_plugins(enabled_plugins)
    return plugin_name in plugin_options


def get_current_plugin_options(plugin_name: str) -> Optional[str]:
    """在响应拦截器回调内部读取当前插件的参数。

    该函数利用 ContextVar 获取当前调用链的 enabled_plugins，
    从中解析出指定插件的 options 字符串。

    仅在 apply_response_interceptors 调用回调期间有效，
    其他时刻调用返回 None。

    Args:
        plugin_name: 插件名称

    Returns:
        插件参数字符串，未启用或无参数时返回 None
    """
    enabled_plugins = _current_enabled_plugins.get()
    if not enabled_plugins:
        return None
    plugin_map = parse_enabled_plugins(enabled_plugins)
    return plugin_map.get(plugin_name)


# 类型定义
# RequestInterceptor: (request, engine, provider, api_key, url, headers, payload) -> (url, headers, payload)
RequestInterceptor = Callable[
    [Any, str, Dict[str, Any], Optional[str], str, Dict[str, Any], Dict[str, Any]],
    "asyncio.coroutines.coroutine"
]

# ResponseInterceptor: (response_chunk, engine, model, is_stream) -> response_chunk
ResponseInterceptor = Callable[
    [Any, str, str, bool],
    "asyncio.coroutines.coroutine"
]


@dataclass
class InterceptorEntry:
    """拦截器条目"""
    id: str
    callback: Callable
    priority: int = 100
    enabled: bool = True
    plugin_name: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


class InterceptorRegistry:
    """
    拦截器注册表
    
    管理 request 和 response 拦截器的注册、注销和调用。
    """
    
    def __init__(self):
        self._request_interceptors: Dict[str, InterceptorEntry] = {}
        self._response_interceptors: Dict[str, InterceptorEntry] = {}
    
    # ==================== 请求拦截器 ====================
    
    def register_request_interceptor(
        self,
        interceptor_id: str,
        callback: RequestInterceptor,
        priority: int = 100,
        plugin_name: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        overwrite: bool = False,
    ) -> InterceptorEntry:
        """
        注册请求拦截器
        
        Args:
            interceptor_id: 拦截器唯一标识
            callback: 拦截器回调函数，签名为:
                async def interceptor(request, engine, provider, api_key, url, headers, payload)
                    -> (url, headers, payload)
            priority: 优先级（数值越小越先执行，默认 100）
            plugin_name: 所属插件名称
            metadata: 元数据
            overwrite: 是否覆盖已存在的拦截器
            
        Returns:
            注册的 InterceptorEntry 对象
            
        Raises:
            ValueError: 如果拦截器已存在且 overwrite=False
        """
        if interceptor_id in self._request_interceptors and not overwrite:
            raise ValueError(f"Request interceptor '{interceptor_id}' already registered")
        
        entry = InterceptorEntry(
            id=interceptor_id,
            callback=callback,
            priority=priority,
            plugin_name=plugin_name,
            metadata=metadata or {},
        )
        self._request_interceptors[interceptor_id] = entry
        logger.debug(f"Registered request interceptor: {interceptor_id} (priority={priority})")
        return entry
    
    def unregister_request_interceptor(self, interceptor_id: str) -> bool:
        """注销请求拦截器"""
        if interceptor_id in self._request_interceptors:
            del self._request_interceptors[interceptor_id]
            logger.debug(f"Unregistered request interceptor: {interceptor_id}")
            return True
        return False
    
    def get_request_interceptors(self, enabled_only: bool = True) -> List[InterceptorEntry]:
        """获取所有请求拦截器（按优先级排序）"""
        interceptors = list(self._request_interceptors.values())
        if enabled_only:
            interceptors = [i for i in interceptors if i.enabled]
        interceptors.sort(key=lambda i: i.priority)
        return interceptors
    
    async def apply_request_interceptors(
        self,
        request: Any,
        engine: str,
        provider: Dict[str, Any],
        api_key: Optional[str],
        url: str,
        headers: Dict[str, Any],
        payload: Dict[str, Any],
        enabled_plugins: Optional[List[str]] = None,
    ) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
        """
        应用所有请求拦截器
        
        按优先级顺序依次调用每个拦截器，每个拦截器可以修改 url/headers/payload。
        
        支持插件参数：enabled_plugins 中的条目可以是 "plugin_name:options" 格式，
        插件内部通过 get_plugin_options(plugin_name, provider) 读取参数。
        
        Args:
            request: 原始请求对象
            engine: 引擎类型
            provider: 提供商配置
            api_key: API 密钥
            url: 请求 URL
            headers: 请求头
            payload: 请求体
            enabled_plugins: 该渠道启用的插件列表，支持 "plugin:options" 格式
                            （None 表示不过滤，执行所有启用的拦截器）
            
        Returns:
            (url, headers, payload) 经过所有拦截器处理后的结果
        """
        interceptors = self.get_request_interceptors(enabled_only=True)
        
        # 解析 enabled_plugins，提取插件名（忽略参数部分用于过滤）
        enabled_plugin_names = None
        if enabled_plugins is not None:
            enabled_plugin_names = set(parse_enabled_plugins(enabled_plugins).keys())
        
        for interceptor in interceptors:
            # 如果拦截器属于某个插件，需要该插件被显式启用
            # enabled_plugins 为 None 或空列表时，跳过所有插件拦截器
            if interceptor.plugin_name:
                if not enabled_plugin_names or interceptor.plugin_name not in enabled_plugin_names:
                    continue
            
            try:
                result = await interceptor.callback(request, engine, provider, api_key, url, headers, payload)
                if result is not None:
                    if isinstance(result, tuple) and len(result) == 3:
                        url, headers, payload = result
                    else:
                        logger.warning(f"Request interceptor '{interceptor.id}' returned invalid result, expected (url, headers, payload)")
            except Exception as e:
                logger.error(f"Request interceptor '{interceptor.id}' error: {e}")
                # 继续执行其他拦截器
        
        return url, headers, payload
    
    # ==================== 响应拦截器 ====================
    
    def register_response_interceptor(
        self,
        interceptor_id: str,
        callback: ResponseInterceptor,
        priority: int = 100,
        plugin_name: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        overwrite: bool = False,
    ) -> InterceptorEntry:
        """
        注册响应拦截器
        
        Args:
            interceptor_id: 拦截器唯一标识
            callback: 拦截器回调函数，签名为:
                async def interceptor(response_chunk, engine, model, is_stream) -> response_chunk
            priority: 优先级（数值越小越先执行，默认 100）
            plugin_name: 所属插件名称
            metadata: 元数据
            overwrite: 是否覆盖已存在的拦截器
            
        Returns:
            注册的 InterceptorEntry 对象
        """
        if interceptor_id in self._response_interceptors and not overwrite:
            raise ValueError(f"Response interceptor '{interceptor_id}' already registered")
        
        entry = InterceptorEntry(
            id=interceptor_id,
            callback=callback,
            priority=priority,
            plugin_name=plugin_name,
            metadata=metadata or {},
        )
        self._response_interceptors[interceptor_id] = entry
        logger.debug(f"Registered response interceptor: {interceptor_id} (priority={priority})")
        return entry
    
    def unregister_response_interceptor(self, interceptor_id: str) -> bool:
        """注销响应拦截器"""
        if interceptor_id in self._response_interceptors:
            del self._response_interceptors[interceptor_id]
            logger.debug(f"Unregistered response interceptor: {interceptor_id}")
            return True
        return False
    
    def get_response_interceptors(self, enabled_only: bool = True) -> List[InterceptorEntry]:
        """获取所有响应拦截器（按优先级排序）"""
        interceptors = list(self._response_interceptors.values())
        if enabled_only:
            interceptors = [i for i in interceptors if i.enabled]
        interceptors.sort(key=lambda i: i.priority)
        return interceptors
    
    async def apply_response_interceptors(
        self,
        response_chunk: Any,
        engine: str,
        model: str,
        is_stream: bool,
        enabled_plugins: Optional[List[str]] = None,
    ) -> Any:
        """
        应用所有响应拦截器
        
        按优先级顺序依次调用每个拦截器，每个拦截器可以修改响应内容。
        
        enabled_plugins 会通过 ContextVar 暴露给回调，插件可通过
        get_current_plugin_options(plugin_name) 读取自己的参数。
        
        Args:
            response_chunk: 响应数据（流式时为单个 chunk，非流式时为完整响应）
            engine: 引擎类型
            model: 模型名称
            is_stream: 是否为流式响应
            enabled_plugins: 该渠道启用的插件列表，支持 "plugin:options" 格式
                            （None 表示不过滤，执行所有启用的拦截器）
            
        Returns:
            经过所有拦截器处理后的响应数据
        """
        interceptors = self.get_response_interceptors(enabled_only=True)
        
        # 将 enabled_plugins 写入 ContextVar，供回调通过 get_current_plugin_options() 读取
        token = _current_enabled_plugins.set(enabled_plugins)
        
        # 解析 enabled_plugins，提取插件名（忽略参数部分用于过滤）
        enabled_plugin_names = None
        if enabled_plugins is not None:
            enabled_plugin_names = set(parse_enabled_plugins(enabled_plugins).keys())
        
        for interceptor in interceptors:
            # 如果拦截器属于某个插件，需要该插件被显式启用
            # enabled_plugins 为 None 或空列表时，跳过所有插件拦截器
            if interceptor.plugin_name:
                if not enabled_plugin_names or interceptor.plugin_name not in enabled_plugin_names:
                    continue
            
            try:
                result = await interceptor.callback(response_chunk, engine, model, is_stream)
                if result is not None:
                    response_chunk = result
            except Exception as e:
                logger.error(f"Response interceptor '{interceptor.id}' error: {e}")
                # 继续执行其他拦截器
        
        # 恢复 ContextVar
        _current_enabled_plugins.reset(token)
        
        return response_chunk
    
    # ==================== 启用/禁用 ====================
    
    def enable_request_interceptor(self, interceptor_id: str) -> bool:
        """启用请求拦截器"""
        if interceptor_id in self._request_interceptors:
            self._request_interceptors[interceptor_id].enabled = True
            return True
        return False
    
    def disable_request_interceptor(self, interceptor_id: str) -> bool:
        """禁用请求拦截器"""
        if interceptor_id in self._request_interceptors:
            self._request_interceptors[interceptor_id].enabled = False
            return True
        return False
    
    def enable_response_interceptor(self, interceptor_id: str) -> bool:
        """启用响应拦截器"""
        if interceptor_id in self._response_interceptors:
            self._response_interceptors[interceptor_id].enabled = True
            return True
        return False
    
    def disable_response_interceptor(self, interceptor_id: str) -> bool:
        """禁用响应拦截器"""
        if interceptor_id in self._response_interceptors:
            self._response_interceptors[interceptor_id].enabled = False
            return True
        return False
    
    # ==================== 按插件注销 ====================
    
    def unregister_plugin_interceptors(self, plugin_name: str) -> int:
        """
        注销指定插件的所有拦截器
        
        Args:
            plugin_name: 插件名称
            
        Returns:
            注销的拦截器数量
        """
        count = 0
        
        # 注销请求拦截器
        to_remove = [i.id for i in self._request_interceptors.values() if i.plugin_name == plugin_name]
        for interceptor_id in to_remove:
            del self._request_interceptors[interceptor_id]
            count += 1
        
        # 注销响应拦截器
        to_remove = [i.id for i in self._response_interceptors.values() if i.plugin_name == plugin_name]
        for interceptor_id in to_remove:
            del self._response_interceptors[interceptor_id]
            count += 1
        
        if count > 0:
            logger.debug(f"Unregistered {count} interceptors for plugin: {plugin_name}")
        
        return count
    
    # ==================== 状态查询 ====================
    
    def get_stats(self) -> Dict[str, Any]:
        """获取拦截器统计信息"""
        return {
            "request_interceptors": {
                "total": len(self._request_interceptors),
                "enabled": len([i for i in self._request_interceptors.values() if i.enabled]),
                "interceptors": [
                    {
                        "id": i.id,
                        "priority": i.priority,
                        "enabled": i.enabled,
                        "plugin_name": i.plugin_name,
                    }
                    for i in sorted(self._request_interceptors.values(), key=lambda x: x.priority)
                ],
            },
            "response_interceptors": {
                "total": len(self._response_interceptors),
                "enabled": len([i for i in self._response_interceptors.values() if i.enabled]),
                "interceptors": [
                    {
                        "id": i.id,
                        "priority": i.priority,
                        "enabled": i.enabled,
                        "plugin_name": i.plugin_name,
                    }
                    for i in sorted(self._response_interceptors.values(), key=lambda x: x.priority)
                ],
            },
        }
    
    def get_interceptor_plugins(self) -> List[Dict[str, Any]]:
        """
        获取所有注册了拦截器的插件列表
        
        Returns:
            插件信息列表，每个元素包含 plugin_name 和该插件注册的拦截器信息
        """
        plugins = {}
        
        # 收集请求拦截器的插件
        for interceptor in self._request_interceptors.values():
            if interceptor.plugin_name:
                if interceptor.plugin_name not in plugins:
                    plugins[interceptor.plugin_name] = {
                        "plugin_name": interceptor.plugin_name,
                        "request_interceptors": [],
                        "response_interceptors": [],
                    }
                plugins[interceptor.plugin_name]["request_interceptors"].append({
                    "id": interceptor.id,
                    "priority": interceptor.priority,
                    "enabled": interceptor.enabled,
                })
        
        # 收集响应拦截器的插件
        for interceptor in self._response_interceptors.values():
            if interceptor.plugin_name:
                if interceptor.plugin_name not in plugins:
                    plugins[interceptor.plugin_name] = {
                        "plugin_name": interceptor.plugin_name,
                        "request_interceptors": [],
                        "response_interceptors": [],
                    }
                plugins[interceptor.plugin_name]["response_interceptors"].append({
                    "id": interceptor.id,
                    "priority": interceptor.priority,
                    "enabled": interceptor.enabled,
                })
        
        return list(plugins.values())
    
    def clear(self) -> None:
        """清空所有拦截器"""
        self._request_interceptors.clear()
        self._response_interceptors.clear()


# 全局拦截器注册表实例
_interceptor_registry: Optional[InterceptorRegistry] = None


def get_interceptor_registry() -> InterceptorRegistry:
    """获取全局拦截器注册表实例"""
    global _interceptor_registry
    if _interceptor_registry is None:
        _interceptor_registry = InterceptorRegistry()
    return _interceptor_registry


def reset_interceptor_registry() -> None:
    """重置全局拦截器注册表（主要用于测试）"""
    global _interceptor_registry
    _interceptor_registry = None


# ==================== 便捷函数 ====================

def register_request_interceptor(
    interceptor_id: str,
    callback: RequestInterceptor,
    priority: int = 100,
    plugin_name: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    overwrite: bool = False,
) -> InterceptorEntry:
    """注册请求拦截器（便捷函数）"""
    return get_interceptor_registry().register_request_interceptor(
        interceptor_id, callback, priority, plugin_name, metadata, overwrite
    )


def unregister_request_interceptor(interceptor_id: str) -> bool:
    """注销请求拦截器（便捷函数）"""
    return get_interceptor_registry().unregister_request_interceptor(interceptor_id)


def register_response_interceptor(
    interceptor_id: str,
    callback: ResponseInterceptor,
    priority: int = 100,
    plugin_name: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    overwrite: bool = False,
) -> InterceptorEntry:
    """注册响应拦截器（便捷函数）"""
    return get_interceptor_registry().register_response_interceptor(
        interceptor_id, callback, priority, plugin_name, metadata, overwrite
    )


def unregister_response_interceptor(interceptor_id: str) -> bool:
    """注销响应拦截器（便捷函数）"""
    return get_interceptor_registry().unregister_response_interceptor(interceptor_id)


async def apply_request_interceptors(
    request: Any,
    engine: str,
    provider: Dict[str, Any],
    api_key: Optional[str],
    url: str,
    headers: Dict[str, Any],
    payload: Dict[str, Any],
    enabled_plugins: Optional[List[str]] = None,
) -> Tuple[str, Dict[str, Any], Dict[str, Any]]:
    """应用所有请求拦截器（便捷函数）"""
    return await get_interceptor_registry().apply_request_interceptors(
        request, engine, provider, api_key, url, headers, payload, enabled_plugins
    )


async def apply_response_interceptors(
    response_chunk: Any,
    engine: str,
    model: str,
    is_stream: bool,
    enabled_plugins: Optional[List[str]] = None,
) -> Any:
    """应用所有响应拦截器（便捷函数）"""
    return await get_interceptor_registry().apply_response_interceptors(
        response_chunk, engine, model, is_stream, enabled_plugins
    )

# ==================== 透明 Client 包装 ====================

class InterceptedClient:
    """
    httpx.AsyncClient 的透明包装。

    在每次 HTTP 请求发出前，自动将 url 和 headers 传入请求拦截器链，
    让已启用的插件有机会修改请求头（如认证方式转换）。

    用于 models_adapter 等不经过 get_payload 的请求路径，
    使其也能被插件拦截，无需修改任何渠道代码。

    用法::

        from core.plugins.interceptors import InterceptedClient

        wrapped = InterceptedClient(client, engine, provider, enabled_plugins)
        # 之后将 wrapped 当作普通 httpx.AsyncClient 使用即可
    """

    def __init__(
        self,
        client,
        engine: str,
        provider: Dict[str, Any],
        enabled_plugins: Optional[List[str]] = None,
    ):
        self._client = client
        self._engine = engine
        self._provider = provider
        self._enabled_plugins = enabled_plugins
        api_key = provider.get("api", "")
        self._api_key = api_key[0] if isinstance(api_key, list) and api_key else (api_key or "")

    async def _intercept(self, url: str, headers: Optional[Dict] = None) -> Tuple[str, Dict]:
        """对 url 和 headers 应用请求拦截器"""
        headers = dict(headers or {})
        if not self._enabled_plugins:
            return url, headers
        url, headers, _ = await apply_request_interceptors(
            None, self._engine, self._provider, self._api_key,
            str(url), headers, {},
            self._enabled_plugins,
        )
        return url, headers

    async def get(self, url, *, headers=None, **kwargs):
        url, headers = await self._intercept(url, headers)
        return await self._client.get(url, headers=headers, **kwargs)

    async def post(self, url, *, headers=None, **kwargs):
        url, headers = await self._intercept(url, headers)
        return await self._client.post(url, headers=headers, **kwargs)

    @asynccontextmanager
    async def _stream_intercepted(self, method, url, *, headers=None, **kwargs):
        url, headers = await self._intercept(url, headers)
        async with self._client.stream(method, url, headers=headers, **kwargs) as response:
            yield response

    def stream(self, method, url, *, headers=None, **kwargs):
        return self._stream_intercepted(method, url, headers=headers, **kwargs)

    def __getattr__(self, name):
        """未覆盖的属性和方法直接转发到原始 client"""
        return getattr(self._client, name)
