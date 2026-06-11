const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const HTML_PATH = path.join(__dirname, 'media-planner-rakuten-gateway.html');
const UPSTREAM_LLM_URL = process.env.UPSTREAM_LLM_URL || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 180000);
const EGRESS_IP_CHECK_URL = process.env.EGRESS_IP_CHECK_URL || 'https://api.ipify.org?format=json';
const EGRESS_IP_CHECK_TIMEOUT_MS = Number(process.env.EGRESS_IP_CHECK_TIMEOUT_MS || 10000);
const DEBUG_PROBE_TIMEOUT_MS = Number(process.env.DEBUG_PROBE_TIMEOUT_MS || 10000);

const HTML_BODY = fs.readFileSync(HTML_PATH);
const PROVIDERS = {
  anthropic: {
    url: 'https://api.ai.public.rakuten-it.com/anthropic/v1/messages',
    buildHeaders: (key) => ({
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: key,
      'anthropic-version': '2023-06-01'
    }),
    buildPayload: ({ model, system, user }) => ({
      model,
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: user }]
    }),
    extractText: (data) => ((data.content && data.content[0] && data.content[0].text) || '')
  },
  gemini: {
    url: ({ model }) =>
      `https://api.ai.public.rakuten-it.com/google-vertexai/v1/publishers/google/models/${encodeURIComponent(model)}:generateContent`,
    buildHeaders: (key) => ({
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: key
    }),
    buildPayload: ({ system, user }) => ({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: 4000 }
    }),
    extractText: (data) => {
      const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
      return parts.map((part) => part.text || '').join('');
    }
  },
  rakuten: {
    url: 'https://api.ai.public.rakuten-it.com/rakutenllms/v1/chat/completions',
    buildHeaders: (key) => ({
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Bearer ${key}`
    }),
    buildPayload: ({ model, system, user }) => ({
      model,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    }),
    extractText: (data) => (((data.choices || [])[0] || {}).message || {}).content || ''
  }
};

const DEBUG_PROBES = {
  anthropic: {
    targetUrl: 'https://api.ai.public.rakuten-it.com/anthropic/v1/messages',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }]
    })
  },
  openai: {
    targetUrl: 'https://api.ai.public.rakuten-it.com/openai/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    })
  }
};

function logEvent(event, payload) {
  console.log(JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    ...payload
  }));
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, anthropic-version'
  });
  res.end(JSON.stringify(payload));
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendNoContent(res) {
  res.writeHead(204, {
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, anthropic-version'
  });
  res.end();
}

function requestJson(targetUrl, metadata = {}) {
  return new Promise((resolve, reject) => {
    const upstreamUrl = new URL(targetUrl);
    const transport = upstreamUrl.protocol === 'http:' ? http : https;
    const startedAt = Date.now();
    const upstreamReq = transport.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || undefined,
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        method: 'GET',
        timeout: EGRESS_IP_CHECK_TIMEOUT_MS
      },
      (upstreamRes) => {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const data = parseJson(body);
          const durationMs = Date.now() - startedAt;
          logEvent('egress_ip_check_response', {
            ...metadata,
            targetUrl,
            statusCode: upstreamRes.statusCode || 502,
            durationMs,
            ip: data && data.ip ? data.ip : null
          });
          if ((upstreamRes.statusCode || 500) >= 400) {
            reject(new Error(`IP check returned status ${upstreamRes.statusCode || 500}`));
            return;
          }
          if (!data) {
            reject(new Error('IP check returned non-JSON response'));
            return;
          }
          resolve(data);
        });
      }
    );

    upstreamReq.on('timeout', () => {
      logEvent('egress_ip_check_timeout', {
        ...metadata,
        targetUrl,
        durationMs: Date.now() - startedAt,
        timeoutMs: EGRESS_IP_CHECK_TIMEOUT_MS
      });
      upstreamReq.destroy(new Error('Egress IP check timed out'));
    });

    upstreamReq.on('error', (error) => {
      logEvent('egress_ip_check_error', {
        ...metadata,
        targetUrl,
        durationMs: Date.now() - startedAt,
        error: error.message
      });
      reject(error);
    });

    upstreamReq.end();
  });
}

function requestProbe(targetUrl, headers, rawBody, metadata = {}) {
  return new Promise((resolve, reject) => {
    const upstreamUrl = new URL(targetUrl);
    const transport = upstreamUrl.protocol === 'http:' ? http : https;
    const startedAt = Date.now();
    const upstreamReq = transport.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || undefined,
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(rawBody)
        },
        timeout: DEBUG_PROBE_TIMEOUT_MS
      },
      (upstreamRes) => {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const durationMs = Date.now() - startedAt;
          logEvent('debug_probe_response', {
            ...metadata,
            targetUrl,
            statusCode: upstreamRes.statusCode || 502,
            contentType: upstreamRes.headers['content-type'] || '',
            durationMs
          });
          resolve({
            statusCode: upstreamRes.statusCode || 502,
            contentType: upstreamRes.headers['content-type'] || '',
            body
          });
        });
      }
    );

    upstreamReq.on('timeout', () => {
      logEvent('debug_probe_timeout', {
        ...metadata,
        targetUrl,
        durationMs: Date.now() - startedAt,
        timeoutMs: DEBUG_PROBE_TIMEOUT_MS
      });
      upstreamReq.destroy(new Error('Debug probe timed out'));
    });

    upstreamReq.on('error', (error) => {
      logEvent('debug_probe_error', {
        ...metadata,
        targetUrl,
        durationMs: Date.now() - startedAt,
        error: error.message
      });
      reject(error);
    });

    upstreamReq.write(rawBody);
    upstreamReq.end();
  });
}

function requestUpstream(targetUrl, headers, rawBody, metadata = {}) {
  return new Promise((resolve, reject) => {
    const upstreamUrl = new URL(targetUrl);
    const transport = upstreamUrl.protocol === 'http:' ? http : https;
    const startedAt = Date.now();
    const upstreamReq = transport.request(
      {
        protocol: upstreamUrl.protocol,
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || undefined,
        path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
        method: 'POST',
        headers,
        timeout: REQUEST_TIMEOUT_MS
      },
      (upstreamRes) => {
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
          const durationMs = Date.now() - startedAt;
          logEvent('upstream_response', {
            ...metadata,
            targetUrl,
            statusCode: upstreamRes.statusCode || 502,
            contentType: upstreamRes.headers['content-type'] || '',
            durationMs
          });
          resolve({
            statusCode: upstreamRes.statusCode || 502,
            contentType: upstreamRes.headers['content-type'] || 'application/json; charset=utf-8',
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    upstreamReq.on('timeout', () => {
      logEvent('upstream_timeout', {
        ...metadata,
        targetUrl,
        durationMs: Date.now() - startedAt,
        timeoutMs: REQUEST_TIMEOUT_MS
      });
      upstreamReq.destroy(new Error('Upstream request timed out'));
    });

    upstreamReq.on('error', (error) => {
      logEvent('upstream_error', {
        ...metadata,
        targetUrl,
        durationMs: Date.now() - startedAt,
        error: error.message
      });
      reject(error);
    });

    upstreamReq.write(rawBody);
    upstreamReq.end();
  });
}

function parseJson(rawText) {
  try {
    return rawText ? JSON.parse(rawText) : null;
  } catch (error) {
    return null;
  }
}

function normalizeProvider(provider) {
  if (provider === 'rakutenai') return 'rakuten';
  return provider;
}

async function proxyToUpstream(res, rawBody) {
  if (!UPSTREAM_LLM_URL) {
    return false;
  }

  logEvent('configured_upstream_request', {
    mode: 'configured_upstream',
    rawBodyBytes: Buffer.byteLength(rawBody)
  });

  try {
    const upstream = await requestUpstream(
      UPSTREAM_LLM_URL,
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(rawBody)
      },
      rawBody,
      { mode: 'configured_upstream' }
    );
    res.writeHead(upstream.statusCode, {
      'Content-Type': upstream.contentType,
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, anthropic-version'
    });
    res.end(upstream.body);
    return true;
  } catch (error) {
    sendJson(res, 502, {
      error: `Failed to reach configured upstream gateway: ${error.message}`
    });
    return true;
  }
}

async function handleBuiltinGateway(res, rawBody) {
  const payload = parseJson(rawBody) || {};
  const provider = normalizeProvider(String(payload.provider || ''));
  const providerConfig = PROVIDERS[provider];
  const key = String(payload.key || payload.apiKey || '').trim();
  const model = String(payload.model || '').trim();
  const system = String(payload.system || '');
  const user = String(payload.user || '');

  if (!key) {
    sendJson(res, 400, { error: 'Missing key' });
    return;
  }
  if (!providerConfig) {
    sendJson(res, 400, { error: `Unsupported provider: ${provider || 'unknown'}` });
    return;
  }
  if (!model) {
    sendJson(res, 400, { error: 'Missing model' });
    return;
  }

  const targetUrl = typeof providerConfig.url === 'function' ? providerConfig.url({ model }) : providerConfig.url;
  const requestBody = JSON.stringify(providerConfig.buildPayload({ model, system, user }));
  const requestMeta = {
    mode: 'builtin_gateway',
    provider,
    model,
    systemLength: system.length,
    userLength: user.length,
    upstreamBodyBytes: Buffer.byteLength(requestBody)
  };

  logEvent('builtin_gateway_request', requestMeta);

  try {
    const upstream = await requestUpstream(
      targetUrl,
      {
        ...providerConfig.buildHeaders(key),
        'Content-Length': Buffer.byteLength(requestBody)
      },
      requestBody,
      requestMeta
    );
    const data = parseJson(upstream.body);
    if (upstream.statusCode >= 200 && upstream.statusCode < 300 && data) {
      sendJson(res, upstream.statusCode, {
        text: providerConfig.extractText(data),
        raw: data
      });
      return;
    }

    sendJson(res, upstream.statusCode, {
      error: data || upstream.body
    });
  } catch (error) {
    logEvent('builtin_gateway_failure', {
      ...requestMeta,
      error: error.message
    });
    sendJson(res, 502, {
      error: `Failed to reach built-in gateway upstream: ${error.message}`
    });
  }
}

async function checkEgressIp(source) {
  const data = await requestJson(EGRESS_IP_CHECK_URL, { source });
  logEvent('egress_ip_check_success', {
    source,
    targetUrl: EGRESS_IP_CHECK_URL,
    ip: data.ip || null
  });
  return data;
}

async function runDebugProbe(probeName, source) {
  const probe = DEBUG_PROBES[probeName];
  if (!probe) {
    throw new Error(`Unsupported probe: ${probeName}`);
  }

  logEvent('debug_probe_request', {
    source,
    probe: probeName,
    targetUrl: probe.targetUrl
  });

  try {
    const response = await requestProbe(
      probe.targetUrl,
      probe.headers,
      probe.body,
      { source, probe: probeName }
    );
    return {
      ok: response.statusCode < 500,
      source,
      probe: probeName,
      targetUrl: probe.targetUrl,
      statusCode: response.statusCode,
      contentType: response.contentType,
      bodyPreview: response.body.slice(0, 500)
    };
  } catch (error) {
    logEvent('debug_probe_failure', {
      source,
      probe: probeName,
      targetUrl: probe.targetUrl,
      error: error.message
    });
    return {
      ok: false,
      source,
      probe: probeName,
      targetUrl: probe.targetUrl,
      error: error.message
    };
  }
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: 'Invalid request URL.' });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS' && url.pathname === '/api/llm') {
    sendNoContent(res);
    return;
  }

  if (req.method === 'GET' && (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/media-planner-rakuten-gateway.html'
  )) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(HTML_BODY);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, {
      ok: true,
      proxyMode: UPSTREAM_LLM_URL ? 'upstream' : 'builtin',
      upstreamConfigured: Boolean(UPSTREAM_LLM_URL)
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/debug/egress-ip') {
    try {
      const data = await checkEgressIp('debug_endpoint');
      sendJson(res, 200, {
        ok: true,
        source: 'debug_endpoint',
        targetUrl: EGRESS_IP_CHECK_URL,
        ip: data.ip || null,
        raw: data
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        source: 'debug_endpoint',
        targetUrl: EGRESS_IP_CHECK_URL,
        error: error.message
      });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/debug/upstream-probe') {
    const probeName = String(url.searchParams.get('provider') || 'anthropic').trim().toLowerCase();
    const result = await runDebugProbe(probeName, 'debug_endpoint');
    sendJson(res, result.ok ? 200 : 502, result);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/debug/upstream-probe/all') {
    const [openai, anthropic] = await Promise.all([
      runDebugProbe('openai', 'debug_endpoint_all'),
      runDebugProbe('anthropic', 'debug_endpoint_all')
    ]);
    const ok = openai.ok && anthropic.ok;
    sendJson(res, ok ? 200 : 502, {
      ok,
      results: {
        openai,
        anthropic
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/llm') {
    try {
      const rawBody = await getRawBody(req);
      const proxied = await proxyToUpstream(res, rawBody);
      if (!proxied) {
        await handleBuiltinGateway(res, rawBody);
      }
    } catch (error) {
      const statusCode = error.message === 'Request body too large' ? 413 : 400;
      sendJson(res, statusCode, { error: error.message });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  void checkEgressIp('startup').catch((error) => {
    logEvent('egress_ip_check_failure', {
      source: 'startup',
      targetUrl: EGRESS_IP_CHECK_URL,
      error: error.message
    });
  });
  void Promise.all([
    runDebugProbe('openai', 'startup'),
    runDebugProbe('anthropic', 'startup')
  ]).catch((error) => {
    logEvent('debug_probe_startup_failure', {
      source: 'startup',
      error: error.message
    });
  });
});
