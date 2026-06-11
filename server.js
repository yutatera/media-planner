const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const HTML_PATH = path.join(__dirname, 'media-planner-rakuten-gateway.html');
const UPSTREAM_LLM_URL = process.env.UPSTREAM_LLM_URL || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 60000);

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

function requestUpstream(targetUrl, headers, rawBody) {
  return new Promise((resolve, reject) => {
    const upstreamUrl = new URL(targetUrl);
    const transport = upstreamUrl.protocol === 'http:' ? http : https;
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
          resolve({
            statusCode: upstreamRes.statusCode || 502,
            contentType: upstreamRes.headers['content-type'] || 'application/json; charset=utf-8',
            body: Buffer.concat(chunks).toString('utf8')
          });
        });
      }
    );

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('Upstream request timed out'));
    });

    upstreamReq.on('error', reject);

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

  try {
    const upstream = await requestUpstream(
      UPSTREAM_LLM_URL,
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(rawBody)
      },
      rawBody
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

  try {
    const upstream = await requestUpstream(
      targetUrl,
      {
        ...providerConfig.buildHeaders(key),
        'Content-Length': Buffer.byteLength(requestBody)
      },
      requestBody
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
    sendJson(res, 502, {
      error: `Failed to reach built-in gateway upstream: ${error.message}`
    });
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
});
