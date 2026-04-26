"""
Key Rules 统一错误处理引擎

将 api_key_cooldown_period、auto_disable_key、status_code_overrides 三套机制
合并为一个 key_rules 规则数组。

规则格式：
    key_rules:
      - match: { status: 429 }        # 匹配状态码
        duration: 30                   # 冷却 30 秒
      - match: { status: [401, 403] }  # 匹配多个状态码
        duration: -1                   # 永久禁用
      - match: { keyword: "quota" }    # 匹配错误信息关键词
        duration: 3600
      - match: { status: 529 }         # 错误码映射
        remap: 429
        duration: 30
      - match: default                 # 兜底
        duration: 60

duration 含义：
  -1  = 永久禁用（需手动恢复）
   0  = 不做 key 处理（仅 remap 生效）
  >0  = 冷却 N 秒后自动恢复
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from core.log_config import logger


def _normalize_status(val: Any) -> List[int]:
    """将 status 值统一为 int 列表"""
    if isinstance(val, int):
        return [val]
    if isinstance(val, list):
        return [int(v) for v in val if str(v).isdigit()]
    if isinstance(val, str) and val.isdigit():
        return [int(val)]
    return []


def _normalize_keywords(val: Any) -> List[str]:
    """将 keyword 值统一为字符串列表"""
    if isinstance(val, str):
        return [val.strip()] if val.strip() else []
    if isinstance(val, list):
        return [str(k).strip() for k in val if str(k).strip()]
    return []


def _normalize_rules(rules: List[dict]) -> List[dict]:
    """规范化规则列表，确保格式一致"""
    normalized = []
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        match = rule.get("match")
        if match is None:
            continue
        
        entry: Dict[str, Any] = {}
        
        if match == "default" or (isinstance(match, str) and match.lower() == "default"):
            entry["match"] = "default"
        elif isinstance(match, dict):
            m: Dict[str, Any] = {}
            if "status" in match:
                codes = _normalize_status(match["status"])
                if codes:
                    m["status"] = codes
            if "keyword" in match:
                kws = _normalize_keywords(match["keyword"])
                if kws:
                    m["keyword"] = kws
            if not m:
                continue
            entry["match"] = m
        else:
            continue
        
        if "duration" in rule:
            try:
                entry["duration"] = int(rule["duration"])
            except (TypeError, ValueError):
                entry["duration"] = 0
        
        if "remap" in rule:
            try:
                remap = int(rule["remap"])
                if 100 <= remap <= 599:
                    entry["remap"] = remap
            except (TypeError, ValueError):
                pass
        
        normalized.append(entry)
    
    return normalized


def resolve_key_rules(preferences: Dict[str, Any]) -> List[dict]:
    """
    从 preferences 读取 key_rules。
    如果没有 key_rules，从旧配置（api_key_cooldown_period / auto_disable_key / status_code_overrides）自动转换。
    """
    # 新配置优先
    rules = preferences.get("key_rules")
    if rules and isinstance(rules, list):
        return _normalize_rules(rules)
    
    # ── 旧配置兼容转换 ──
    converted: List[dict] = []
    
    # 1. status_code_overrides → remap-only 规则（插到最前面，优先匹配）
    sc_overrides = preferences.get("status_code_overrides")
    if sc_overrides and isinstance(sc_overrides, dict):
        for from_code, to_code in sc_overrides.items():
            try:
                from_int = int(from_code)
                to_int = int(to_code)
                if 100 <= to_int <= 599:
                    converted.append({
                        "match": {"status": [from_int]},
                        "remap": to_int,
                        "duration": 0,  # 仅 remap，不做 key 处理
                    })
            except (TypeError, ValueError):
                pass
    
    # 2. auto_disable_key → 状态码 + 关键词规则
    auto_disable = preferences.get("auto_disable_key")
    if auto_disable and isinstance(auto_disable, dict):
        codes = auto_disable.get("status_codes", [401, 403])
        if not isinstance(codes, list):
            codes = [codes]
        old_duration = int(auto_disable.get("duration", 0))
        # 旧配置 duration=0 表示永久 → 新配置 -1
        new_duration = -1 if old_duration == 0 else old_duration
        
        if codes:
            int_codes = [int(c) for c in codes if str(c).isdigit()]
            if int_codes:
                converted.append({
                    "match": {"status": int_codes},
                    "duration": new_duration,
                })
        
        keywords = auto_disable.get("keywords") or []
        if isinstance(keywords, list):
            kws = [str(k).strip() for k in keywords if str(k).strip()]
            if kws:
                converted.append({
                    "match": {"keyword": kws},
                    "duration": new_duration,
                })
    
    # 3. api_key_cooldown_period / cooldown_period → default 兜底规则
    cooldown = preferences.get("api_key_cooldown_period") or preferences.get("cooldown_period")
    if cooldown:
        try:
            cd = int(cooldown)
            if cd > 0:
                converted.append({
                    "match": "default",
                    "duration": cd,
                })
        except (TypeError, ValueError):
            pass
    
    if converted:
        return _normalize_rules(converted)
    
    # ── 全部为空：使用硬编码默认规则 ──
    return _normalize_rules([
        {"match": {"status": [401, 403]}, "duration": -1},
        {"match": "default", "duration": 3},
    ])


def match_key_rules(
    rules: List[dict],
    status_code: int,
    error_message: str,
) -> Optional[Dict[str, Any]]:
    """
    按顺序匹配规则，返回第一个命中的规则结果。
    
    Returns:
        {"duration": int, "remap": int|None, "reason": str} 或 None
    """
    if not rules:
        return None
    
    error_lower = (error_message or "").lower()
    
    for rule in rules:
        match = rule.get("match")
        matched = False
        reason = ""
        
        if match == "default":
            matched = True
            reason = "default"
        elif isinstance(match, dict):
            # 状态码匹配
            status_list = match.get("status")
            if status_list and isinstance(status_list, list):
                if status_code in status_list:
                    matched = True
                    reason = f"status={status_code}"
            
            # 关键词匹配（与状态码是 OR 关系）
            if not matched:
                keyword_list = match.get("keyword")
                if keyword_list and isinstance(keyword_list, list):
                    for kw in keyword_list:
                        if kw.lower() in error_lower:
                            matched = True
                            reason = f"keyword={kw}"
                            break
        
        if matched:
            result: Dict[str, Any] = {"reason": reason}
            if "duration" in rule:
                result["duration"] = rule["duration"]
            if "remap" in rule:
                result["remap"] = rule["remap"]
            return result
    
    return None
