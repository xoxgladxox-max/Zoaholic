"""utils_pkg 兼容包。

修改原因：原业务实现已经按领域迁移到 core/config、core/model_catalog、core/stream_pipeline 等模块。
修改方式：保留包和子模块 shim，只负责把旧导入路径转发到新的 core 模块。
目的：避免外部扩展在过渡期因直接导入 utils_pkg 而中断，同时防止新的业务逻辑继续写入 utils_pkg。
"""
