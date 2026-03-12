import { useAuthStore } from '../store/authStore';

/**
 * 带鉴权与自动登出的 fetch。
 *
 * 说明：
 * - 管理控制台使用 JWT（Authorization: Bearer <jwt>）。
 * - 部分接口会把上游渠道的 401/403 透传回来（例如填错 OpenAI Key 导致上游返回 401）。
 *   这些 401/403 并不代表管理端 JWT 失效，不能因此把用户踢回登录页。
 *
 * 因此仅当后端返回的错误明确指向「本地鉴权失败」时，才自动登出。
 */

/**
 * core/auth.py 中本地鉴权失败的 detail 文案。
 * 如果后端修改了这些文案，此处需要同步更新。
 */
const LOCAL_AUTH_FAILURE_DETAILS = new Set([
  'Invalid or missing API Key',
  'Invalid or missing credentials',
  'Permission denied',
]);

/**
 * 判断 401/403 响应是否来自本地鉴权层。
 *
 * 本地鉴权层（core/auth.py）只返回 403 + FastAPI 标准 {"detail": "..."} 格式。
 * 上游透传的错误通常是 {"error": {...}} 或其他结构，不会命中这里的匹配。
 */
async function isLocalAuthFailure(res: Response): Promise<boolean> {
  if (res.status !== 401 && res.status !== 403) return false;

  try {
    const data = await res.clone().json();
    if (data && typeof data === 'object' && typeof data.detail === 'string') {
      return LOCAL_AUTH_FAILURE_DETAILS.has(data.detail);
    }
  } catch {
    // 响应体不是 JSON，不是本地鉴权错误
  }
  return false;
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const { token, logout } = useAuthStore.getState();

  const headers = new Headers(init.headers || undefined);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(input, {
    ...init,
    headers,
  });

  // 仅当「本地鉴权失败」时才自动登出
  if (await isLocalAuthFailure(res)) {
    try {
      logout();
    } catch {
      // ignore
    }

    // 避免在登录页反复跳转
    if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
  }

  return res;
}
