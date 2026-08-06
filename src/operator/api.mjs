/**
 * API client for the operator console.
 *
 * Responses are consumed as-is: no numeric coercion anywhere. The server sends
 * every amount as a decimal string, and turning one into a JS number here would
 * undo that on the way to the screen.
 */

export class ApiError extends Error {
  constructor(status, problem) {
    super(problem?.detail ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
    this.status = status;
    this.title = problem?.title ?? 'Error';
    this.correlationId = problem?.correlationId ?? null;
  }
}

/**
 * Session token storage.
 *
 * `sessionStorage`, so the credential dies with the tab and never outlives the
 * browser session. It is still readable by script running on this origin — the
 * durable answer is an httpOnly cookie with CSRF protection, which is recorded
 * as a known gap rather than pretended away. The page's CSP forbids inline and
 * third-party script, which is what makes this defensible for now.
 */
const TOKEN_KEY = 'reserveos.token';

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    if (token === null) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing modes can refuse storage; the session simply will not
    // survive a reload.
  }
}

async function request(method, path, body) {
  const token = getToken();
  const headers = { accept: 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    // The API is same-origin and token-authenticated; sending cookies would
    // only create a CSRF surface without adding anything.
    credentials: 'omit',
  });

  if (response.status === 204) return null;

  const text = await response.text();
  let parsed = null;
  if (text !== '') {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ApiError(response.status, { detail: 'The server returned a malformed response.' });
    }
  }

  if (!response.ok) {
    // A 401 is the server saying this credential is invalid, expired or revoked.
    // Keeping it leaves the console holding a dead token: every screen fails the
    // same way, the operator is never returned to the sign-in form, and a token
    // the issuer has just revoked sits in browser storage until the tab closes.
    // Dropped here rather than in a caller because this is the only place the
    // status is seen, and a caller that forgot would fail open.
    if (response.status === 401) setToken(null);
    throw new ApiError(response.status, parsed);
  }
  return parsed;
}

export const api = {
  me: () => request('GET', '/api/me'),

  periods: () => request('GET', '/api/periods'),
  period: (id) => request('GET', `/api/periods/${id}`),
  openPeriod: (periodStart, periodEnd) =>
    request('POST', '/api/periods', { periodStart, periodEnd }),
  computation: (id) => request('GET', `/api/periods/${id}/computation`),
  generateReport: (id) => request('POST', `/api/periods/${id}/report`),
  publish: (id) => request('POST', `/api/periods/${id}/publish`),

  report: (versionId) => request('GET', `/api/reports/${versionId}`),
  approvals: (versionId) => request('GET', `/api/reports/${versionId}/approvals`),
  approve: (versionId, role, decision) =>
    request('POST', `/api/reports/${versionId}/approvals`, { role, decision }),

  stepUp: () => request('POST', '/api/auth/step-up'),

  custodians: () => request('GET', '/api/custodians'),
  deployments: () => request('GET', '/api/deployments'),
  documents: () => request('GET', '/api/documents'),
  openRedemptions: () => request('GET', '/api/redemptions/open'),
};
