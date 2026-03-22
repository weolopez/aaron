---
name: api-client
description: Build HTTP API clients with fetch, error handling, retries with exponential backoff, response parsing, request interceptors, and timeout support
---

# API Client Skill

## Approach

Building robust HTTP API clients requires handling multiple concerns:

1. **Request Management**: Structuring fetch calls with proper headers, methods, and bodies
2. **Response Parsing**: Safely parsing JSON and handling different content types
3. **Error Handling**: Distinguishing network errors from API errors from validation errors
4. **Retry Logic**: Implementing exponential backoff for transient failures
5. **Request Interceptors**: Modifying requests before sending (auth tokens, headers)
6. **Timeout Support**: Preventing hanging requests with AbortController
7. **Type Safety**: Validating response shapes and providing clear interfaces

## Templates

### Basic API Client with Timeout

```javascript
const createApiClient = (baseUrl, options = {}) => {
  const defaultTimeout = options.timeout || 30000;
  const defaultHeaders = options.headers || {};
  const interceptors = options.interceptors || [];

  const request = async (endpoint, requestOptions = {}) => {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), defaultTimeout);

    try {
      // Build URL
      const url = `${baseUrl}${endpoint}`;
      
      // Prepare request
      let request = {
        method: requestOptions.method || 'GET',
        headers: { ...defaultHeaders, ...requestOptions.headers },
        signal: controller.signal,
      };

      // Add body if present
      if (requestOptions.body) {
        request.body = typeof requestOptions.body === 'string' 
          ? requestOptions.body 
          : JSON.stringify(requestOptions.body);
      }

      // Apply interceptors
      for (const interceptor of interceptors) {
        request = await interceptor(request);
      }

      // Make request
      const response = await fetch(url, request);

      clearTimeout(timeoutId);

      // Handle response
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
        error.status = response.status;
        error.response = response;
        throw error;
      }

      // Parse response
      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        return await response.json();
      }
      return await response.text();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout after ${defaultTimeout}ms`);
      }
      throw error;
    }
  };

  return {
    get: (endpoint, options) => request(endpoint, { ...options, method: 'GET' }),
    post: (endpoint, body, options) => request(endpoint, { ...options, method: 'POST', body }),
    put: (endpoint, body, options) => request(endpoint, { ...options, method: 'PUT', body }),
    patch: (endpoint, body, options) => request(endpoint, { ...options, method: 'PATCH', body }),
    delete: (endpoint, options) => request(endpoint, { ...options, method: 'DELETE' }),
    request,
  };
};
```

### Retry Logic with Exponential Backoff

```javascript
const withRetry = async (
  fn,
  options = {}
) => {
  const maxRetries = options.maxRetries || 3;
  const baseDelay = options.baseDelay || 1000;
  const maxDelay = options.maxDelay || 30000;
  const backoffMultiplier = options.backoffMultiplier || 2;
  const retryableStatus = options.retryableStatus || [408, 429, 500, 502, 503, 504];

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Determine if error is retryable
      const isRetryable = 
        error.name === 'AbortError' ||
        (error.status && retryableStatus.includes(error.status)) ||
        !error.status; // Network errors

      if (attempt === maxRetries || !isRetryable) {
        throw error;
      }

      // Calculate delay with exponential backoff and jitter
      const delay = Math.min(
        baseDelay * Math.pow(backoffMultiplier, attempt) + Math.random() * 1000,
        maxDelay
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
};
```

### Request Interceptor Pattern

```javascript
// Authentication interceptor
const authInterceptor = (token) => async (request) => {
  return {
    ...request,
    headers: {
      ...request.headers,
      'Authorization': `Bearer ${token}`,
    },
  };
};

// Logging interceptor
const loggingInterceptor = async (request) => {
  console.log(`[${request.method}] ${request.url}`);
  return request;
};

// Request ID interceptor
const requestIdInterceptor = async (request) => {
  return {
    ...request,
    headers: {
      ...request.headers,
      'X-Request-ID': crypto.randomUUID?.() || Math.random().toString(36).slice(2),
    },
  };
};

// Usage
const client = createApiClient('https://api.example.com', {
  headers: { 'Content-Type': 'application/json' },
  interceptors: [
    requestIdInterceptor,
    loggingInterceptor,
    authInterceptor('token123'),
  ],
});
```

### Response Parser with Validation

```javascript
const parseResponse = (response, schema) => {
  if (!response) {
    throw new Error('Empty response');
  }

  // Basic validation against schema
  if (schema && schema.required) {
    for (const field of schema.required) {
      if (!(field in response)) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
  }

  return response;
};

// Usage
const userSchema = {
  required: ['id', 'email', 'name'],
};

const user = await client.get('/users/123')
  .then(data => parseResponse(data, userSchema))
  .catch(error => console.error('Failed to fetch user:', error.message));
```

### Complete Example: Typed API Client

```javascript
const createTypedClient = (baseUrl, options = {}) => {
  const client = createApiClient(baseUrl, options);

  const validateAndParse = (data, schema) => {
    if (!data) throw new Error('No data');
    if (schema?.required) {
      for (const field of schema.required) {
        if (!(field in data)) throw new Error(`Missing: ${field}`);
      }
    }
    return data;
  };

  return {
    async getUser(id) {
      const data = await withRetry(() => client.get(`/users/${id}`));
      return validateAndParse(data, { required: ['id', 'email'] });
    },

    async createUser(userData) {
      const data = await withRetry(() => client.post('/users', userData));
      return validateAndParse(data, { required: ['id'] });
    },

    async listUsers(params) {
      return await withRetry(() => 
        client.get('/users', { params: new URLSearchParams(params) })
      );
    },

    async updateUser(id, updates) {
      return await withRetry(() => client.patch(`/users/${id}`, updates));
    },

    async deleteUser(id) {
      return await withRetry(() => client.delete(`/users/${id}`));
    },
  };
};
```

## Checklists

### Building an API Client

- [ ] Define base URL and default headers
- [ ] Implement timeout handling with AbortController
- [ ] Add HTTP method helpers (GET, POST, PUT, PATCH, DELETE)
- [ ] Implement error handling with custom error types
- [ ] Add retry logic with exponential backoff
- [ ] Create request interceptor system
- [ ] Add response parsing and validation
- [ ] Handle different content types (JSON, text, binary)
- [ ] Add logging/debugging support
- [ ] Test network failures
- [ ] Test timeout scenarios
- [ ] Test retry behavior
- [ ] Validate response schemas
- [ ] Handle authentication tokens
- [ ] Add request correlation IDs
- [ ] Document error codes and handling

### Error Handling Strategy

- [ ] Distinguish network errors from API errors
- [ ] Handle HTTP error status codes appropriately
- [ ] Implement custom error classes
- [ ] Determine which errors are retryable
- [ ] Set sensible retry limits and backoff curves
- [ ] Add context to error messages
- [ ] Log errors with sufficient detail for debugging
- [ ] Provide fallback values when appropriate
- [ ] Clean up resources (abort, timeouts) on error

### Performance & Reliability

- [ ] Set appropriate timeouts (30s default for long operations)
- [ ] Implement exponential backoff (1s, 2s, 4s, 8s, etc.)
- [ ] Add jitter to prevent thundering herd
- [ ] Reuse HTTP connections where possible
- [ ] Cache responses when appropriate
- [ ] Monitor retry rates and adjust thresholds
- [ ] Implement circuit breaker for failing services
- [ ] Add request deduplication for idempotent operations
- [ ] Track metrics: success rate, latency, error types
- [ ] Use request IDs for tracing across systems

## Examples in Context

### Fetching Weather Data with Retry

```javascript
const weatherClient = createApiClient('https://api.weather.gov');

const fetchWeather = async (lat, lon) => {
  try {
    const data = await withRetry(
      () => weatherClient.get(`/points/${lat},${lon}`),
      { maxRetries: 3, baseDelay: 500 }
    );
    return data;
  } catch (error) {
    console.error('Weather fetch failed:', error.message);
    return null;
  }
};
```

### API Client with Auth Token Refresh

```javascript
let authToken = 'initial-token';

const refreshToken = async () => {
  const response = await fetch('https://api.example.com/refresh', {
    method: 'POST',
  });
  const data = await response.json();
  authToken = data.token;
  return authToken;
};

const client = createApiClient('https://api.example.com', {
  interceptors: [
    authInterceptor(authToken),
  ],
});

// Handle 401 responses by refreshing token
const withAuthRefresh = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    if (error.status === 401) {
      await refreshToken();
      return await fn();
    }
    throw error;
  }
};
```

## Related Skills

- **component-builder**: For rendering API response data as UI components
- **data-transform**: For processing and reshaping API responses
- **weather**: Practical example using weather API client patterns
