/**
 * llm-client.js — Invariant LLM client
 *
 * NEVER modified by RSI. These LLM client implementations are foundational.
 * See ADR.md Decision 11.
 *
 * Exports: createAnthropicClient, createAskArchitectClient, getLLMClient
 */

// ════════════════════════════════════════════════════
// ENVIRONMENT DETECTION
// ════════════════════════════════════════════════════

const isNode = typeof process !== 'undefined' && process.versions?.node;
const isBrowser = typeof window !== 'undefined';

// ════════════════════════════════════════════════════
// TOKEN STORAGE
// ════════════════════════════════════════════════════

function getToken(key) {
  // Browser environment: use localStorage
  if (typeof localStorage !== 'undefined') {
    return localStorage.getItem(key);
  }
  // Node environment: use process.env
  if (isNode && process.env) {
    return process.env[key];
  }
  return null;
}

function setToken(key, value) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(key, value);
  }
  // Node: no-op (env vars are immutable)
}

// Node-only: file-based session storage for CLI
async function getNodeSessionStorage() {
  if (!isNode) return null;
  try {
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    return join(homedir(), '.askarchitect_session');
  } catch {
    return null;
  }
}

async function loadNodeSession() {
  const cachePath = await getNodeSessionStorage();
  if (!cachePath) return null;
  try {
    const { readFileSync } = await import('node:fs');
    const raw = readFileSync(cachePath, 'utf8');
    const parsed = JSON.parse(raw);
    return new SessionInfo(
      parsed.cookieName || parsed.cookie_name,
      parsed.cookieValue || parsed.cookie_value,
      parsed.user,
      parsed.expiresAt || parsed.expires_at
    );
  } catch {
    return null;
  }
}

async function saveNodeSession(session) {
  const cachePath = await getNodeSessionStorage();
  if (!cachePath) return;
  try {
    const { writeFileSync, chmodSync } = await import('node:fs');
    const payload = {
      cookieName: session.cookieName,
      cookieValue: session.cookieValue,
      user: session.user,
      expiresAt: session.expiresAt,
    };
    writeFileSync(cachePath, JSON.stringify(payload, null, 2));
    // Set file permissions to 0600 on Unix
    if (process.platform !== 'win32') {
      chmodSync(cachePath, 0o600);
    }
  } catch (error) {
    console.warn('Failed to save session:', error.message);
  }
}

async function clearNodeSession() {
  const cachePath = await getNodeSessionStorage();
  if (!cachePath) return;
  try {
    const { unlinkSync } = await import('node:fs');
    unlinkSync(cachePath);
  } catch {
    // Ignore errors
  }
}

// ════════════════════════════════════════════════════
// ANTHROPIC CLIENT
// ════════════════════════════════════════════════════

export function createAnthropicClient({
  model,
  apiUrl = 'https://api.anthropic.com/v1/messages',
  apiKey = null, // if null, reads from storage
  headers = {},
} = {}) {
  const resolvedApiKey = apiKey ?? getToken('ANTHROPIC_API_KEY');

  return {
    model,
    provider: 'anthropic',
    async call(messages, system) {
      if (!resolvedApiKey) {
        throw new Error('Anthropic API key is not set. Configure ANTHROPIC_API_KEY or use AskArchitect.');
      }
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': resolvedApiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-allow-browser': 'true',
          ...headers,
        },
        body: JSON.stringify({ model, max_tokens: 16384, system, messages }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? `LLM API error ${res.status}`);
      }
      return res.json();
    },
  };
}

// ════════════════════════════════════════════════════
// ASKARCHITECT CLIENT
// ════════════════════════════════════════════════════

// AskArchitect server configuration
const ASKARCHITECT_SERVER_URL = isBrowser
  ? ''
  : 'https://askarchitect-westus3-dev-app-appservice.azurewebsites.net';
const SSO_TENANT_ID = 'e741d71c-c6b6-47b0-803c-0f3b32b07556';
const SSO_CLIENT_ID = 'f5df8be3-4473-4c28-b74d-bac0671b4dd8';
const SSO_SCOPES = 'openid profile offline_access User.Read';
const SESSION_EXPIRY_SKEW_SECONDS = 60;

class SessionInfo {
  constructor(cookieName, cookieValue, user, expiresAt) {
    this.cookieName = cookieName;
    this.cookieValue = cookieValue;
    this.user = user;
    this.expiresAt = expiresAt;
  }

  get cookieHeader() {
    return `${this.cookieName}=${this.cookieValue}`;
  }

  get isExpired() {
    return this.expiresAt <= Math.floor(Date.now() / 1000) + SESSION_EXPIRY_SKEW_SECONDS;
  }
}

function loadCachedSession() {
  const raw = getToken('ASKARCHITECT_SESSION');
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    const session = new SessionInfo(
      parsed.cookieName,
      parsed.cookieValue,
      parsed.user,
      parsed.expiresAt
    );
    return session.isExpired ? null : session;
  } catch {
    return null;
  }
}

async function saveSession(session) {
  const payload = {
    cookieName: session.cookieName,
    cookieValue: session.cookieValue,
    user: session.user,
    expiresAt: session.expiresAt,
  };
  setToken('ASKARCHITECT_SESSION', JSON.stringify(payload));
  // Also save to Node file storage if in Node environment
  if (isNode) {
    await saveNodeSession(session);
  }
}

function clearSessionCache() {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('ASKARCHITECT_SESSION');
  }
  if (isNode) {
    clearNodeSession();
  }
}

function parseSessionCookie(setCookieHeaders) {
  for (const header of setCookieHeaders) {
    const cookiePart = header.split(';')[0];
    const [name, value] = cookiePart.split('=');

    if (name && value) {
      const cookieName = name.trim();
      if (cookieName === 'session' || cookieName === 'flask_session') {
        return { cookieName, cookieValue: value.trim() };
      }
    }
  }

  // Fallback: take the first cookie
  if (setCookieHeaders.length > 0) {
    const header = setCookieHeaders[0];
    const cookiePart = header.split(';')[0];
    const [name, value] = cookiePart.split('=');

    if (name && value) {
      return { cookieName: name.trim(), cookieValue: value.trim() };
    }
  }

  return { cookieName: null, cookieValue: null };
}

async function exchangeCodeForSession(authCode, serverUrl) {
  const sessionUrl = `${serverUrl}/api/cli/session`;
  const body = JSON.stringify({
    code: authCode.code,
    code_verifier: authCode.codeVerifier,
    redirect_uri: authCode.redirectUri,
  });

  const response = await fetch(sessionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Server rejected token (${response.status}): ${errText}`);
  }

  const responseJson = await response.json();
  const setCookieHeaders = response.headers.getSetCookie?.() || [];

  // For browsers, we need to handle the Set-Cookie differently
  // The fetch API doesn't expose Set-Cookie headers by default due to security
  // So we rely on the response body containing session info
  const { cookieName, cookieValue } = parseSessionCookie(setCookieHeaders);

  if (!cookieName || !cookieValue) {
    // Fallback: try to get session from response body
    if (responseJson.session_cookie) {
      return new SessionInfo(
        responseJson.session_cookie.name || 'session',
        responseJson.session_cookie.value,
        responseJson.user || 'unknown',
        responseJson.expires_at || (Math.floor(Date.now() / 1000) + 3600)
      );
    }
    throw new Error('Server did not return a session cookie');
  }

  const user = responseJson.user || 'unknown';
  const expiresAt = responseJson.expires_at || (Math.floor(Date.now() / 1000) + 3600);

  return new SessionInfo(cookieName, cookieValue, user, expiresAt);
}

async function resolveSession(forceLogin, serverUrl, interactive = true) {
  if (!forceLogin) {
    // Try browser storage first, then Node file storage
    let cached = loadCachedSession();
    if (!cached && isNode) {
      cached = await loadNodeSession();
    }
    if (cached) {
      console.log(`[AskArchitect] Using cached session (user: ${cached.user})`);
      return cached;
    }
  }

  if (!interactive) {
    throw new Error('No cached session available and interactive login disabled');
  }

  // Node.js CLI: perform browser SSO flow
  if (isNode) {
    console.log('[AskArchitect] No cached session. Starting browser SSO login...');
    const authCode = await getAuthCodeViaBrowserSSO();
    const session = await exchangeCodeForSession(authCode, serverUrl);
    await saveNodeSession(session);
    console.log(`[AskArchitect] Authenticated as: ${session.user}`);
    return session;
  }

  // Browser: can't do CLI OAuth
  throw new Error('AskArchitect authentication required. Please login via the UI first.');
}

// SSO Configuration
const SSO_REDIRECT_HOST = 'localhost';
const SSO_REDIRECT_PATH = '/getAToken';
const SSO_REDIRECT_PORT_CANDIDATES = [8787, 8000, 8080];

class AuthCode {
  constructor(code, codeVerifier, redirectUri) {
    this.code = code;
    this.codeVerifier = codeVerifier;
    this.redirectUri = redirectUri;
  }
}

async function getAuthCodeViaBrowserSSO() {
  const { randomUUID } = await import('node:crypto');
  const state = `state-${randomUUID()}`;
  const codeVerifier = `verifier-${randomUUID()}-${randomUUID()}`;
  const codeChallenge = await codeChallengeS256(codeVerifier);

  const { server, redirectPort } = await bindCallbackListener();
  const redirectUri = `http://${SSO_REDIRECT_HOST}:${redirectPort}${SSO_REDIRECT_PATH}`;

  const authorizeUrl = `https://login.microsoftonline.com/${encodeURIComponent(SSO_TENANT_ID)}/oauth2/v2.0/authorize?` +
    `client_id=${encodeURIComponent(SSO_CLIENT_ID)}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_mode=query&scope=${encodeURIComponent(SSO_SCOPES)}&state=${encodeURIComponent(state)}` +
    `&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256`;

  console.log('[AskArchitect] Opening browser for Microsoft SSO login...');
  await openBrowser(authorizeUrl);

  const query = await waitForCallbackQuery(server);
  const returnedState = query.get('state') || '';

  if (returnedState !== state) {
    throw new Error('OAuth state mismatch');
  }

  const error = query.get('error');
  if (error) {
    const description = query.get('error_description') || '';
    throw new Error(`OAuth authorization failed: ${error} ${description}`);
  }

  const code = query.get('code');
  if (!code) {
    throw new Error('OAuth callback did not include authorization code');
  }

  return new AuthCode(code, codeVerifier, redirectUri);
}

async function codeChallengeS256(verifier) {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(verifier).digest('base64url');
}

async function bindCallbackListener() {
  const { createServer } = await import('node:http');

  for (const port of SSO_REDIRECT_PORT_CANDIDATES) {
    try {
      const server = createServer();

      await new Promise((resolve, reject) => {
        server.listen(port, SSO_REDIRECT_HOST)
          .on('listening', resolve)
          .on('error', reject);
      });

      return { server, redirectPort: port };
    } catch {
      // Try next port
    }
  }

  throw new Error(`Failed to bind callback listener on ports ${SSO_REDIRECT_PORT_CANDIDATES.join(', ')}`);
}

async function waitForCallbackQuery(server) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error('Timeout waiting for OAuth callback (2 minutes)'));
    }, 120000);

    server.on('request', (req, res) => {
      clearTimeout(timeout);

      const urlObj = new URL(req.url, `http://${req.headers.host}`);
      const path = urlObj.pathname;
      const query = urlObj.searchParams;

      if (path !== SSO_REDIRECT_PATH) {
        res.writeHead(400);
        res.end('Bad Request');
        server.close();
        reject(new Error(`Unexpected callback path: ${path}`));
        return;
      }

      // Send success response
      const body = 'Login completed. You can close this browser tab and return to the terminal.';
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Connection': 'close'
      });
      res.end(body);

      server.close();
      resolve(query);
    });

    server.on('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`Failed waiting for OAuth callback: ${error.message}`));
    });
  });
}

async function openBrowser(url) {
  const { exec } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execAsync = promisify(exec);

  const platform = process.platform;

  try {
    if (platform === 'darwin') {
      await execAsync(`open "${url}"`);
    } else if (platform === 'linux') {
      await execAsync(`xdg-open "${url}"`);
    } else if (platform === 'win32') {
      await execAsync(`cmd /c start "" "${url}"`);
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }
  } catch (error) {
    throw new Error(`Failed to open browser: ${error.message}`);
  }
}

async function makeServerRequest(session, method, path, body, serverUrl) {
  const baseUrl = (serverUrl || '').replace(/\/$/, '');
  const url = `${baseUrl}${path}`;
  let attempt = 0;
  let currentSession = session;

  while (attempt < 2) {
    console.log(`[AskArchitect] Request: ${method} ${url}`);
    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(currentSession?.cookieHeader && { 'Cookie': currentSession.cookieHeader }),
      },
      body: body || undefined,
    });

    console.log(`[AskArchitect] Response: ${response.status} ${response.statusText}`);
    console.log(`[AskArchitect] Content-Type: ${response.headers.get('content-type')}`);

    // Detect auth failure: explicit 401 OR HTML login redirect
    const contentType = response.headers.get('content-type') || '';
    const isHtmlResponse = contentType.includes('text/html');
    const isAuthFailure = response.status === 401 || isHtmlResponse;

    if (isAuthFailure && attempt === 0) {
      clearSessionCache();
      try {
        currentSession = await resolveSession(true, serverUrl);
        await saveSession(currentSession);
        attempt++;
        continue;
      } catch (error) {
        throw new Error(`Re-authentication failed: ${error.message}`);
      }
    }

    return response;
  }

  throw new Error('Max retry attempts exceeded');
}

export function createAskArchitectClient({
  model = 'gpt-5.2',
  useGeneric = true,
  serverUrl = ASKARCHITECT_SERVER_URL,
  interactive = true,
} = {}) {
  return {
    model,
    provider: 'askarchitect',
    async call(messages, system) {
      // Resolve or get session
      let session;
      try {
        session = await resolveSession(false, serverUrl, interactive);
      } catch (err) {
        // If we can't get a session, try without authentication
        // Some endpoints may be public
        session = null;
      }

      // Build prompt from messages
      const lastMessage = messages[messages.length - 1];
      const prompt = lastMessage?.content || '';

      let endpoint, body;

      if (useGeneric) {
        // Generic chat endpoint expects messages format
        endpoint = '/api/ask-att/chat-with-tools';
        body = JSON.stringify({
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            ...messages,
          ],
          model,
          max_tokens: 16384,
        });
      } else {
        // Domain endpoint expects question field (last message only)
        endpoint = '/api/ask-att/domain-v2';
        body = JSON.stringify({ question: prompt });
      }

      const response = await makeServerRequest(session, 'POST', endpoint, body, serverUrl);

      if (!response.ok) {
        const errorText = await response.text();
        console.log(`[AskArchitect] Error response preview: ${errorText.slice(0, 200)}`);
        throw new Error(`Error (HTTP ${response.status}): ${errorText.slice(0, 200)}`);
      }

      // Check content type before attempting JSON parse
      const contentType = response.headers.get('content-type');
      if (!contentType?.includes('application/json')) {
        const rawText = await response.text();
        console.log(`[AskArchitect] Unexpected content-type: ${contentType}`);
        console.log(`[AskArchitect] Response body: ${rawText.slice(0, 1000)}`);
        throw new Error(`Expected JSON but got ${contentType}. Body: ${rawText.slice(0, 200)}`);
      }

      const responseJson = await response.json();
      console.log(`[AskArchitect] Response body keys: ${Object.keys(responseJson).join(', ')}`);

      // Convert to Anthropic-like format for compatibility
      return {
        content: [
          {
            type: 'text',
            text: responseJson.content || responseJson.answer || responseJson.response || responseJson.text || JSON.stringify(responseJson),
          },
        ],
      };
    },
  };
}

// ════════════════════════════════════════════════════
// OPENROUTER CLIENT (CORS-friendly for browser use)
// ════════════════════════════════════════════════════

export function createOpenRouterClient({
  model = 'xiaomi/mimo-v2-omni',
  apiUrl = 'https://openrouter.ai/api/v1/chat/completions',
  apiKey = null,
} = {}) {
  const resolvedApiKey = apiKey ?? getToken('OPENROUTER_API_KEY');

  return {
    model,
    provider: 'openrouter',
    async call(messages, system) {
      if (!resolvedApiKey) {
        throw new Error('OpenRouter API key is not set. Configure OPENROUTER_API_KEY.');
      }
      // OpenRouter uses OpenAI format: system is a message, not a separate field
      const allMessages = system
        ? [{ role: 'system', content: system }, ...messages]
        : messages;

      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${resolvedApiKey}`,
        },
        body: JSON.stringify({ model, max_tokens: 16384, messages: allMessages }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error?.message ?? `LLM API error ${res.status}`);
      }
      const data = await res.json();
      // Convert OpenAI response format to Anthropic format for compatibility
      const text = data.choices?.[0]?.message?.content ?? '';
      return { content: [{ type: 'text', text }] };
    },
  };
}

// ════════════════════════════════════════════════════
// FACTORY: Get LLM Client
// ════════════════════════════════════════════════════

/**
 * Get an LLM client based on configuration.
 * Reads provider and tokens from storage.
 *
 * Options (from localStorage/env):
 *   - LLM_PROVIDER: 'anthropic' | 'openrouter' | 'askarchitect'
 *   - ANTHROPIC_API_KEY: API key for Anthropic (direct, requires proxy in browser)
 *   - OPENROUTER_API_KEY: API key for OpenRouter (CORS-friendly, works in browser)
 *   - ANTHROPIC_MODEL: model name override
 *
 * Auto-detection order: explicit provider → OPENROUTER_API_KEY → ANTHROPIC_API_KEY → askarchitect
 */
export function getLLMClient(options = {}) {
  const configuredProvider = options.provider ?? getToken('LLM_PROVIDER');
  const hasOpenRouter = !!getToken('OPENROUTER_API_KEY');
  const hasAnthropic = !!getToken('ANTHROPIC_API_KEY');
  const provider = configuredProvider ?? (hasOpenRouter ? 'openrouter' : hasAnthropic ? 'anthropic' : 'askarchitect');

  switch (provider) {
    case 'openrouter':
      return createOpenRouterClient({
        model: options.model ?? getToken('ANTHROPIC_MODEL') ?? 'xiaomi/mimo-v2-omni',
        apiKey: options.apiKey,
        // Note: do NOT spread ...options here — apiUrl from options targets Anthropic, not OpenRouter
      });

    case 'anthropic':
      return createAnthropicClient({
        model: options.model ?? getToken('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6',
        apiKey: options.apiKey,
        ...options,
      });

    case 'askarchitect':
      return createAskArchitectClient({
        model: options.model ?? 'gpt-4.1-mini',
        ...options,
      });

    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
