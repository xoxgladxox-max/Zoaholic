"""兼容旧 utils_pkg 导入路径的空壳模块。

修改原因：实现已经归位到 core.config.service，但外部扩展可能仍直接导入 utils_pkg 子模块。
修改方式：动态转发目标 core 模块的所有非 dunder 名称，包括历史下划线辅助函数。
目的：让 utils_pkg 不再承载业务实现，同时保留短期兼容性。
"""

from importlib import import_module as _import_module

_impl = _import_module("core.config.service")

for _name in dir(_impl):
    if not _name.startswith("__"):
        globals()[_name] = getattr(_impl, _name)

__all__ = [_name for _name in dir(_impl) if not _name.startswith("__")]
