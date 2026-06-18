import { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '../store/authStore';
import { apiFetch } from '../lib/api';
import {
  RefreshCw, Filter, ChevronDown, ChevronRight, FileText,
  Clock, ArrowDownToLine, CheckCircle2, XCircle,
  Globe, Key, Server, RotateCcw, Eye, EyeOff,
  Flag, Users, Zap, AlertTriangle, X, Search, Calendar
} from 'lucide-react';

// 匹配后端 LogEntry 模型
interface LogEntry {
  id: number;
  timestamp: string;
  endpoint?: string;
  client_ip?: string;
  provider?: string;
  model?: string;
  api_key_prefix?: string;
  process_time?: number;
  first_response_time?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  // Prompt Caching 字段来自后端 request_stats，用于展示缓存命中和缓存创建 token。
  cached_tokens?: number;
  cache_creation_tokens?: number;
  prompt_price?: number;
  completion_price?: number;
  success: boolean;
  status_code?: number;
  is_flagged: boolean;
  // 扩展字段
  provider_id?: string;
  provider_key_index?: number;
  api_key_name?: string;
  api_key_group?: string;
  retry_count?: number;
  retry_path?: string;
  request_headers?: string;
  request_body?: string;
  // 修改原因：日志详情需要展示后端已保存的上游请求头和新增的上游响应头。
  // 修改方式：在前端 LogEntry 类型中补齐两个可选字段。
  // 目的：让 TypeScript 能识别接口返回的上下游头信息。
  upstream_request_headers?: string;
  upstream_request_body?: string;
  upstream_response_headers?: string;
  upstream_response_body?: string;
  response_body?: string;
  raw_data_expires_at?: string;
}

// ── 时间快捷选项 ──
const TIME_PRESETS = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
] as const;

export default function Logs() {
  const { token } = useAuthStore();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [totalCount, setTotalCount] = useState(0);

  // Pagination
  const [page, setPage] = useState(1);
  const [pageSize] = useState(50);

  // Search & Filter States
  // 修改原因：文本筛选原来直接参与请求依赖，输入每个字符都会触发日志请求并放大竞态风险。
  // 修改方式：将文本框的输入态和真正参与请求的提交态拆开，输入态只负责界面显示。
  // 目的：让模型、渠道、Key 三个文本筛选只在防抖提交或手动清除时影响请求。
  const [inputModel, setInputModel] = useState('');
  const [inputProvider, setInputProvider] = useState('');
  const [inputApiKey, setInputApiKey] = useState('');
  const [committedModel, setCommittedModel] = useState('');
  const [committedProvider, setCommittedProvider] = useState('');
  const [committedApiKey, setCommittedApiKey] = useState('');
  const [filterSuccess, setFilterSuccess] = useState<string>('ALL');
  const [filterTimePreset, setFilterTimePreset] = useState<number | null>(null);
  const [filterStartTime, setFilterStartTime] = useState('');
  const [filterEndTime, setFilterEndTime] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  // 修改原因：清除按钮可能只清空尚未提交的输入值，此时提交态不变，普通依赖不会触发请求。
  // 修改方式：维护一个刷新序号，清除操作递增它，让筛选请求立即重新执行。
  // 目的：确保清除按钮不等待防抖，并且始终能立即刷新日志列表。
  const [filterRefreshNonce, setFilterRefreshNonce] = useState(0);
  // 修改原因：需要手写 500ms 防抖并取消上一次待提交任务，避免依赖 lodash。
  // 修改方式：使用 useRef 保存 setTimeout 返回值，输入变化时清理旧定时器后创建新定时器。
  // 目的：连续输入时只在最后一次输入停止 500ms 后提交文本筛选。
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 修改原因：快速筛选会产生并发请求，旧响应可能后到并覆盖新结果。
  // 修改方式：使用 useRef 保存当前 AbortController，每次请求前 abort 上一次请求。
  // 目的：只允许最新请求更新日志列表，避免搜索结果回退。
  const abortControllerRef = useRef<AbortController | null>(null);
  // 修改原因：列表接口为性能不再返回请求体、响应体和头信息，展开日志时需要单独保存完整详情。
  // 修改方式：按日志 ID 缓存 /v1/logs/{id} 的返回，并为每条详情维护加载和错误状态。
  // 目的：列表页保持轻量，用户展开某一条日志时才按需读取大字段。
  const [logDetails, setLogDetails] = useState<Record<number, LogEntry>>({});
  const [detailLoadingIds, setDetailLoadingIds] = useState<Set<number>>(new Set());
  const [detailErrorById, setDetailErrorById] = useState<Record<number, string>>({});
  const detailAbortControllersRef = useRef<Map<number, AbortController>>(new Map());

  // Accordion State
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  // ── 构造时间参数 ──
  const getTimeParams = () => {
    if (filterTimePreset) {
      const start = new Date(Date.now() - filterTimePreset * 3600_000);
      return { start_time: start.toISOString(), end_time: '' };
    }
    return { start_time: filterStartTime, end_time: filterEndTime };
  };

  const fetchLogs = async (resetPage = false) => {
    if (!token) return;

    // 修改原因：筛选和分页可能连续触发请求，旧请求如果后完成会覆盖新结果。
    // 修改方式：每次请求前取消上一个 AbortController，并为本次请求创建新的 controller。
    // 目的：让 fetch 层面停止旧请求，配合状态更新检查消除竞态覆盖。
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setLoading(true);

    const currentPage = resetPage ? 1 : page;
    if (resetPage) setPage(1);

    try {
      const queryParams = new URLSearchParams({
        page: currentPage.toString(),
        page_size: pageSize.toString(),
      });

      if (committedModel.trim()) queryParams.append('model', committedModel.trim());
      if (committedProvider.trim()) queryParams.append('provider', committedProvider.trim());
      if (committedApiKey.trim()) queryParams.append('api_key', committedApiKey.trim());
      if (filterSuccess === 'SUCCESS') queryParams.append('success', 'true');
      if (filterSuccess === 'FAILED') queryParams.append('success', 'false');

      const { start_time, end_time } = getTimeParams();
      if (start_time) queryParams.append('start_time', start_time);
      if (end_time) queryParams.append('end_time', end_time);

      const res = await apiFetch(`/v1/logs?${queryParams.toString()}`, {
        signal: controller.signal,
      });

      if (res.ok) {
        const data = await res.json();
        // 修改原因：即使请求已被取消，也可能已经进入响应解析阶段。
        // 修改方式：更新状态前确认当前 controller 仍是最新请求且未被 abort。
        // 目的：防止旧请求在极端时序下覆盖新筛选结果。
        if (controller.signal.aborted || abortControllerRef.current !== controller) return;
        const fetchedLogs = data.items || [];
        setLogs(fetchedLogs);
        setTotalCount(data.total || 0);
        setHasMore(currentPage * pageSize < (data.total || 0));
      }
    } catch (err) {
      const errorName = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
      if (errorName === 'AbortError') return;
      console.error('Failed to fetch logs:', err);
    } finally {
      // 修改原因：被取消的旧请求进入 finally 时，不应关闭新请求的加载状态。
      // 修改方式：只有当前 controller 仍是最新请求时，才清理引用并结束 loading。
      // 目的：避免旧请求影响新请求的界面状态。
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    fetchLogs(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedModel, committedProvider, committedApiKey, filterSuccess, filterTimePreset, filterStartTime, filterEndTime, filterRefreshNonce]);

  const loadMore = () => {
    setPage(prev => prev + 1);
  };

  useEffect(() => {
    if (page > 1) {
      fetchLogs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);

  const fetchLogDetail = async (id: number) => {
    if (!token || logDetails[id] || detailLoadingIds.has(id)) return;

    // 修改原因：展开详情会触发单条日志请求，用户可能快速折叠、切换或离开页面。
    // 修改方式：为每个日志详情请求创建独立 AbortController，并按日志 ID 清理加载状态。
    // 目的：避免无效详情请求更新界面，同时保持列表请求的取消逻辑不受影响。
    const previousController = detailAbortControllersRef.current.get(id);
    if (previousController) previousController.abort();

    const controller = new AbortController();
    detailAbortControllersRef.current.set(id, controller);
    setDetailLoadingIds(prev => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setDetailErrorById(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

    try {
      const res = await apiFetch(`/v1/logs/${id}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      if (controller.signal.aborted || detailAbortControllersRef.current.get(id) !== controller) return;
      setLogDetails(prev => ({ ...prev, [id]: data }));
    } catch (err) {
      const errorName = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
      if (errorName === 'AbortError') return;
      console.error('Failed to fetch log detail:', err);
      setDetailErrorById(prev => ({ ...prev, [id]: '详情加载失败' }));
    } finally {
      if (detailAbortControllersRef.current.get(id) === controller) {
        detailAbortControllersRef.current.delete(id);
        setDetailLoadingIds(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  };

  const toggleExpand = (id: number) => {
    const willExpand = !expandedIds.has(id);
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (willExpand) {
      void fetchLogDetail(id);
    }
  };

  useEffect(() => {
    if (
      inputModel === committedModel &&
      inputProvider === committedProvider &&
      inputApiKey === committedApiKey
    ) {
      return;
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      setCommittedModel(inputModel);
      setCommittedProvider(inputProvider);
      setCommittedApiKey(inputApiKey);
      debounceTimerRef.current = null;
    }, 500);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [inputModel, inputProvider, inputApiKey, committedModel, committedProvider, committedApiKey]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      // 修改原因：详情请求独立于列表请求，组件卸载时也需要取消，避免卸载后继续更新状态。
      // 修改方式：遍历当前按日志 ID 保存的 AbortController 并清空 Map。
      // 目的：防止详情懒加载在页面切换后留下悬空请求。
      detailAbortControllersRef.current.forEach(controller => controller.abort());
      detailAbortControllersRef.current.clear();
    };
  }, []);

  const hasActiveFilters = Boolean(
    inputModel || inputProvider || inputApiKey ||
    committedModel || committedProvider || committedApiKey ||
    filterSuccess !== 'ALL' || filterTimePreset || filterStartTime || filterEndTime
  );

  const triggerImmediateFilterRefresh = () => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setFilterRefreshNonce(prev => prev + 1);
  };

  const clearModelFilter = () => {
    setInputModel('');
    setCommittedModel('');
    triggerImmediateFilterRefresh();
  };

  const clearProviderFilter = () => {
    setInputProvider('');
    setCommittedProvider('');
    triggerImmediateFilterRefresh();
  };

  const clearApiKeyFilter = () => {
    setInputApiKey('');
    setCommittedApiKey('');
    triggerImmediateFilterRefresh();
  };

  const clearAllFilters = () => {
    setInputModel('');
    setInputProvider('');
    setInputApiKey('');
    setCommittedModel('');
    setCommittedProvider('');
    setCommittedApiKey('');
    setFilterSuccess('ALL');
    setFilterTimePreset(null);
    setFilterStartTime('');
    setFilterEndTime('');
    triggerImmediateFilterRefresh();
  };

  // ========== Helpers ==========
  const getStatusColor = (success: boolean, code?: number) => {
    if (success) return 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    if (code && code >= 400 && code < 500) return 'text-yellow-600 dark:text-yellow-500 bg-yellow-500/10 border-yellow-500/20';
    return 'text-red-600 dark:text-red-500 bg-red-500/10 border-red-500/20';
  };

  const calculateSpeed = (log: LogEntry) => {
    if (!log.completion_tokens || !log.process_time) return null;
    const startTime = log.first_response_time || 0;
    const genTime = log.process_time - startTime;
    if (genTime <= 0) return null;
    const speed = log.completion_tokens / genTime;
    let color = 'text-muted-foreground';
    if (speed >= 80) color = 'text-purple-600 dark:text-purple-400';
    else if (speed >= 40) color = 'text-emerald-600 dark:text-emerald-400';
    else if (speed < 15) color = 'text-yellow-600 dark:text-yellow-500';
    return { speed: speed.toFixed(1), color };
  };

  const formatTimestamp = (ts: string) => {
    try {
      const date = new Date(ts);
      return date.toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    } catch { return ts; }
  };

  const formatFullTimestamp = (ts: string) => {
    try { return new Date(ts).toLocaleString('zh-CN'); }
    catch { return ts; }
  };

  const formatJsonBestEffort = (raw: string): { formatted: string; isJson: boolean } => {
    const input = String(raw ?? '').trim();
    if (!input) return { formatted: '', isJson: false };
    try {
      let parsed: unknown = JSON.parse(input);
      if (typeof parsed === 'string') {
        const inner = parsed.trim();
        try { parsed = JSON.parse(inner); }
        catch { return { formatted: inner, isJson: false }; }
      }
      if (parsed === null) return { formatted: 'null', isJson: true };
      if (typeof parsed === 'object') return { formatted: JSON.stringify(parsed, null, 2), isJson: true };
      return { formatted: String(parsed), isJson: false };
    } catch { return { formatted: raw, isJson: false }; }
  };

  const getHttpCodeColor = (code?: number | null) => {
    if (code == null) return 'text-muted-foreground bg-muted/30 border-border';
    if (code >= 200 && code < 300) return 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    if (code >= 400 && code < 500) return 'text-yellow-600 dark:text-yellow-500 bg-yellow-500/10 border-yellow-500/20';
    return 'text-red-600 dark:text-red-500 bg-red-500/10 border-red-500/20';
  };

  type RetryHop = { provider?: string; status_code?: number | null; error?: string };

  const RetryPathView = ({ retryPathJson }: { retryPathJson: string }) => {
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    let items: RetryHop[] | null = null;
    try {
      const parsed = JSON.parse(retryPathJson);
      if (Array.isArray(parsed)) items = parsed;
    } catch { items = null; }

    if (!items) {
      return (
        <pre className="bg-background border border-border p-3 rounded-lg text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap">
          {retryPathJson}
        </pre>
      );
    }
    if (items.length === 0) {
      return <div className="text-sm text-muted-foreground">无重试记录</div>;
    }
    return (
      <div className="space-y-2">
        {items.map((hop, idx) => {
          const provider = hop.provider || '-';
          const code = hop.status_code;
          const error = hop.error || '';
          const isOpen = openIndex === idx;
          const preview = error.length > 120 ? `${error.slice(0, 120)}...` : error;
          return (
            <div key={`${provider}-${idx}`} className="border border-border rounded-lg overflow-hidden bg-background">
              <button
                type="button"
                onClick={() => setOpenIndex(prev => (prev === idx ? null : idx))}
                className="w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-muted/50 transition-colors"
              >
                <div className="flex-shrink-0 text-xs font-mono text-muted-foreground mt-0.5">#{idx + 1}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground truncate" title={provider}>{provider}</span>
                    <span className={`px-2 py-0.5 rounded text-xs font-mono border ${getHttpCodeColor(code)}`}>{code ?? '-'}</span>
                    {error && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span className="truncate max-w-[520px]">{isOpen ? '展开查看错误详情' : preview}</span>
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex-shrink-0 text-muted-foreground mt-0.5">
                  {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </div>
              </button>
              {isOpen && error && (
                <pre className="border-t border-border p-3 text-xs font-mono text-foreground whitespace-pre-wrap max-h-72 overflow-y-auto">
                  {error}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // 单条日志的手风琴组件
  const LogAccordionItem = ({ log }: { log: LogEntry }) => {
    const isExpanded = expandedIds.has(log.id);
    const speedInfo = calculateSpeed(log);
    // 修改原因：列表行不再携带 body/header 大字段，展开区域必须优先使用单条详情接口返回的数据。
    // 修改方式：按日志 ID 从详情缓存中取完整记录，加载完成前仍用列表行显示基础信息。
    // 目的：保持展开布局不变，同时把大字段读取延后到用户真正展开时。
    const detailLog = logDetails[log.id] || log;
    const isDetailLoading = detailLoadingIds.has(log.id);
    const detailError = detailErrorById[log.id];
    // 缓存字段统一转成数字，目的是避免旧日志缺字段时影响列表和展开详情渲染。
    const cachedTokens = log.cached_tokens || 0;
    const cacheCreationTokens = log.cache_creation_tokens || 0;
    const hasCacheInfo = cachedTokens > 0 || cacheCreationTokens > 0;
    return (
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="cursor-pointer hover:bg-muted/50 transition-colors" onClick={() => toggleExpand(log.id)}>
          {/* 第一行：核心信息 */}
          <div className="flex items-center gap-2 sm:gap-3 p-3 sm:p-4">
            <div className="flex-shrink-0 text-muted-foreground">
              {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </div>
            <div className="flex-shrink-0">
              {log.success ? <CheckCircle2 className="w-5 h-5 text-emerald-500" /> : <XCircle className="w-5 h-5 text-red-500" />}
            </div>
            <div className="flex-shrink-0 text-xs sm:text-sm font-mono text-muted-foreground w-[85px] sm:w-[100px]">
              {formatTimestamp(log.timestamp)}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-foreground text-sm truncate" title={log.model || '-'}>{log.model || '-'}</div>
              <div className="text-xs text-muted-foreground truncate">
                {log.provider || '未知'}
                {log.provider_key_index !== undefined && <span className="opacity-60"> [{log.provider_key_index}]</span>}
              </div>
            </div>
            <div className="hidden sm:flex items-center gap-1.5 flex-shrink-0">
              {log.is_flagged && <span className="text-yellow-500" title="已标记"><Flag className="w-4 h-4" /></span>}
              {(log.retry_count ?? 0) > 0 && (
                <span className="text-orange-500 flex items-center gap-0.5 text-xs" title={`重试 ${log.retry_count} 次`}>
                  <RotateCcw className="w-3.5 h-3.5" />{log.retry_count}
                </span>
              )}
            </div>
            <div className="flex-shrink-0">
              <span className={`px-1.5 sm:px-2 py-0.5 sm:py-1 rounded text-xs font-mono font-medium border ${getStatusColor(log.success, log.status_code)}`}>
                {log.status_code || '-'}
              </span>
            </div>
          </div>
          {/* 第二行：详细指标 */}
          <div className="flex items-center gap-2 sm:gap-4 px-3 sm:px-4 pb-3 sm:pb-4 pt-0 text-xs flex-wrap">
            <div className="flex items-center gap-1 text-muted-foreground" title={`API Key: ${log.api_key_name || log.api_key_prefix || '-'}`}>
              <Key className="w-3.5 h-3.5" />
              <span className="max-w-[80px] sm:max-w-[120px] truncate">{log.api_key_name || log.api_key_prefix || '-'}</span>
            </div>
            {log.api_key_group && (
              <div className="hidden sm:flex items-center gap-1 text-muted-foreground">
                <Users className="w-3.5 h-3.5" /><span>{log.api_key_group}</span>
              </div>
            )}
            <div className="hidden lg:flex items-center gap-1 text-muted-foreground font-mono">
              <Globe className="w-3.5 h-3.5" /><span>{log.client_ip || '-'}</span>
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-1 font-mono" title={`输入: ${log.prompt_tokens || 0}${cachedTokens > 0 ? `，缓存命中 ${cachedTokens}` : ''}${cacheCreationTokens > 0 ? `，缓存创建 ${cacheCreationTokens}` : ''}；输出: ${log.completion_tokens || 0}；总计: ${log.total_tokens || 0}`}>
              {/* 列表摘要只在命中缓存时追加弱化文本，避免缓存数字抢占主要 token 信息。 */}
              {cachedTokens > 0 ? (
                <>
                  <span className="text-muted-foreground">{(log.prompt_tokens || 0) - cachedTokens}</span>
                  <span className="text-[10px] text-emerald-600/80 dark:text-emerald-400/80">(+{cachedTokens} {(cachedTokens / (log.prompt_tokens || 1) * 100).toFixed(1)}%)</span>
                </>
              ) : (
                <span className="text-muted-foreground">{log.prompt_tokens || 0}</span>
              )}
              <span className="text-muted-foreground/50">→</span>
              <span className="text-blue-600 dark:text-blue-400">{log.completion_tokens || 0}</span>
            </div>
            {log.success && (log.prompt_price || log.completion_price) ? (() => {
              const cost = ((log.prompt_tokens || 0) * (log.prompt_price || 0) + (log.completion_tokens || 0) * (log.completion_price || 0)) / 1_000_000;
              return cost > 0 ? (
                <span className="text-amber-600 dark:text-amber-400 font-mono text-xs" title={`输入 $${log.prompt_price}/M · 输出 $${log.completion_price}/M`}>
                  ${cost >= 0.01 ? cost.toFixed(4) : cost.toFixed(6)}
                </span>
              ) : null;
            })() : null}
            <div className="flex items-center gap-1 text-muted-foreground" title={`总耗时: ${log.process_time?.toFixed(2)}s, 首响: ${log.first_response_time?.toFixed(2) || '-'}s`}>
              <Clock className="w-3.5 h-3.5" />
              <span className="font-mono">{log.process_time?.toFixed(2) || '-'}s</span>
              {log.first_response_time !== undefined && (
                <span className="text-muted-foreground/60 hidden sm:inline">(首响 {log.first_response_time.toFixed(2)}s)</span>
              )}
            </div>
            {speedInfo && (
              <div className={`flex items-center gap-1 font-mono ${speedInfo.color}`} title="生成速度">
                <Zap className="w-3.5 h-3.5" /><span>{speedInfo.speed} t/s</span>
              </div>
            )}
          </div>
        </div>
        {/* Expanded Content */}
        {isExpanded && (
          <div className="border-t border-border bg-muted/30 p-4 space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-sm">
              <InfoItem label="日志 ID" value={String(detailLog.id)} mono />
              <InfoItem label="完整时间" value={formatFullTimestamp(detailLog.timestamp)} />
              <InfoItem label="Endpoint" value={detailLog.endpoint || '-'} mono />
              <InfoItem label="客户端 IP" value={detailLog.client_ip || '-'} mono />
              <InfoItem label="Provider ID" value={detailLog.provider_id || '-'} />
              {detailLog.raw_data_expires_at && <InfoItem label="数据过期" value={formatFullTimestamp(detailLog.raw_data_expires_at)} />}
            </div>

            {detailLog.retry_path && (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground flex items-center gap-1">
                  <RotateCcw className="w-3.5 h-3.5" /> 重试路径
                </div>
                <RetryPathView retryPathJson={detailLog.retry_path} />
              </div>
            )}
            {isDetailLoading && (
              <div className="rounded-lg border border-border bg-background/60 p-3 text-sm text-muted-foreground">
                正在加载日志详情...
              </div>
            )}
            {detailError && !isDetailLoading && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-400">
                {detailError}
              </div>
            )}
            {!isDetailLoading && !detailError && (
              <div className="space-y-2">
                {/* 按数据流方向分组：请求链路（用户→上游）、响应链路（上游→用户） */}
                <div className="space-y-2 rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-xs font-medium text-muted-foreground tracking-wide">请求 →</div>
                  <JsonAccordion title="客户端请求头" data={detailLog.request_headers} icon={<FileText className="w-4 h-4" />} />
                  <JsonAccordion title="客户端请求体" data={detailLog.request_body} icon={<Eye className="w-4 h-4" />} />
                  <JsonAccordion title="上游请求头" data={detailLog.upstream_request_headers} icon={<Server className="w-4 h-4" />} />
                  <JsonAccordion title="上游请求体" data={detailLog.upstream_request_body} icon={<Server className="w-4 h-4" />} />
                </div>
                <div className="space-y-2 rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-xs font-medium text-muted-foreground tracking-wide">← 响应</div>
                  <JsonAccordion title="上游响应头" data={detailLog.upstream_response_headers} icon={<Server className="w-4 h-4" />} />
                  <JsonAccordion title="上游响应体" data={detailLog.upstream_response_body} icon={<Server className="w-4 h-4" />} />
                  <JsonAccordion title="客户端响应体" data={detailLog.response_body} icon={<EyeOff className="w-4 h-4" />} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const InfoItem = ({ label, value, mono }: { label: string; value: string; mono?: boolean }) => (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-sm text-foreground truncate ${mono ? 'font-mono' : ''}`} title={value}>{value}</div>
    </div>
  );

  const JsonAccordion = ({ title, data, icon, defaultOpen = false }: { title: string; data?: string; icon?: import('react').ReactNode; defaultOpen?: boolean }) => {
    const [isOpen, setIsOpen] = useState(defaultOpen);
    if (!data) return null;
    const { formatted } = formatJsonBestEffort(data);
    const previewText = formatted.length > 80 ? formatted.substring(0, 80) + '...' : formatted;
    return (
      <div className="border border-border rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 cursor-pointer hover:bg-muted transition-colors" onClick={() => setIsOpen(!isOpen)}>
          <div className="flex-shrink-0 text-muted-foreground">
            {isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </div>
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">{icon}{title}</div>
          {!isOpen && <div className="flex-1 text-xs font-mono text-muted-foreground/60 truncate ml-2">{previewText.replace(/\n/g, ' ')}</div>}
        </div>
        {isOpen && (
          <pre className="bg-background p-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre-wrap max-h-80 overflow-y-auto border-t border-border">
            {formatted}
          </pre>
        )}
      </div>
    );
  };

  // ── datetime-local 工具 ──
  const toLocalDatetimeStr = (iso: string) => {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return ''; }
  };

  const fromLocalDatetimeStr = (local: string) => {
    if (!local) return '';
    try { return new Date(local).toISOString(); }
    catch { return ''; }
  };

  return (
    <div className="space-y-4 sm:space-y-6 animate-in fade-in duration-500 font-sans pb-12 h-full flex flex-col">
      {/* Header */}
      <div className="flex justify-between items-center flex-shrink-0">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">系统日志</h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">监控 API 请求详情与性能</p>
        </div>
        <button
          onClick={() => fetchLogs(true)}
          className="p-2 text-muted-foreground hover:text-foreground bg-card border border-border rounded-lg transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* ── Toolbar ── */}
      <div className="bg-card border border-border rounded-xl shadow-sm flex-shrink-0">
        <div className="p-3 sm:p-4 space-y-3">
          {/* Mobile Filter Toggle */}
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center gap-2 text-sm text-muted-foreground md:hidden w-full justify-center py-1"
          >
            <Filter className="w-4 h-4" />
            {showFilters ? '收起筛选' : '展开筛选'}
            {hasActiveFilters && <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
            <ChevronDown className={`w-4 h-4 transition-transform ${showFilters ? 'rotate-180' : ''}`} />
          </button>

          <div className={`space-y-3 ${showFilters ? 'block' : 'hidden md:block'}`}>
            {/* 第一排：关键词筛选 */}
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text" placeholder="模型名" value={inputModel}
                  onChange={e => setInputModel(e.target.value)}
                  className="w-full bg-background border border-border text-sm pl-8 pr-7 py-2 rounded-lg text-foreground placeholder:text-muted-foreground focus:border-primary outline-none"
                />
                {inputModel && (
                  <button onClick={clearModelFilter} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="relative flex-1 min-w-0">
                <Server className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text" placeholder="渠道名" value={inputProvider}
                  onChange={e => setInputProvider(e.target.value)}
                  className="w-full bg-background border border-border text-sm pl-8 pr-7 py-2 rounded-lg text-foreground placeholder:text-muted-foreground focus:border-primary outline-none"
                />
                {inputProvider && (
                  <button onClick={clearProviderFilter} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="relative flex-1 min-w-0">
                <Key className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                <input
                  type="text" placeholder="Key 名称 / 分组" value={inputApiKey}
                  onChange={e => setInputApiKey(e.target.value)}
                  className="w-full bg-background border border-border text-sm pl-8 pr-7 py-2 rounded-lg text-foreground placeholder:text-muted-foreground focus:border-primary outline-none"
                />
                {inputApiKey && (
                  <button onClick={clearApiKeyFilter} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <select
                value={filterSuccess} onChange={e => setFilterSuccess(e.target.value)}
                className="bg-background border border-border text-sm px-3 py-2 rounded-lg text-foreground sm:w-[110px] flex-shrink-0"
              >
                <option value="ALL">全部状态</option>
                <option value="SUCCESS">成功</option>
                <option value="FAILED">失败</option>
              </select>
            </div>

            {/* 第二排：时间筛选 */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
              <div className="flex items-center gap-1 flex-shrink-0">
                <Calendar className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                {TIME_PRESETS.map(preset => (
                  <button
                    key={preset.hours}
                    onClick={() => {
                      if (filterTimePreset === preset.hours) {
                        setFilterTimePreset(null);
                      } else {
                        setFilterTimePreset(preset.hours);
                        setFilterStartTime('');
                        setFilterEndTime('');
                      }
                    }}
                    className={`px-2 py-1 text-xs rounded-md transition-colors ${
                      filterTimePreset === preset.hours
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80'
                    }`}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>

              <span className="hidden sm:block text-muted-foreground/40 text-xs">|</span>

              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                <input
                  type="datetime-local"
                  value={toLocalDatetimeStr(filterStartTime)}
                  onChange={e => { setFilterStartTime(fromLocalDatetimeStr(e.target.value)); setFilterTimePreset(null); }}
                  className="bg-background border border-border text-xs px-2 py-1.5 rounded-lg text-foreground flex-1 min-w-0"
                  title="开始时间"
                />
                <span className="text-muted-foreground text-xs flex-shrink-0">至</span>
                <input
                  type="datetime-local"
                  value={toLocalDatetimeStr(filterEndTime)}
                  onChange={e => { setFilterEndTime(fromLocalDatetimeStr(e.target.value)); setFilterTimePreset(null); }}
                  className="bg-background border border-border text-xs px-2 py-1.5 rounded-lg text-foreground flex-1 min-w-0"
                  title="结束时间"
                />
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {hasActiveFilters && (
                  <button
                    onClick={clearAllFilters}
                    className="flex items-center gap-1 px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground bg-muted hover:bg-muted/80 rounded-lg transition-colors"
                  >
                    <X className="w-3 h-3" /> 清除
                  </button>
                )}
                <div className="text-xs text-muted-foreground whitespace-nowrap">
                  共 <span className="font-mono text-foreground">{totalCount}</span> 条
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Logs List */}
      <div className="flex-1 overflow-auto space-y-2">
        {logs.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center p-16 text-muted-foreground bg-card border border-border rounded-xl">
            <FileText className="w-12 h-12 mb-4 opacity-50" />
            <p>未找到匹配的日志</p>
          </div>
        ) : (
          logs.map((log) => <LogAccordionItem key={log.id} log={log} />)
        )}

        {hasMore && logs.length > 0 && (
          <button
            onClick={loadMore}
            disabled={loading}
            className="w-full text-sm text-muted-foreground hover:text-foreground font-medium flex items-center justify-center gap-1.5 py-4 bg-card border border-border rounded-xl disabled:opacity-50 transition-colors"
          >
            <ArrowDownToLine className="w-4 h-4" />
            {loading ? '加载中...' : `加载更多 (${logs.length}/${totalCount})`}
          </button>
        )}
      </div>
    </div>
  );
}
