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

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
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

function proxyToUpstream(req, res, rawBody) {
  if (!UPSTREAM_LLM_URL) {
    sendJson(res, 500, {
      error: 'UPSTREAM_LLM_URL is not configured on this Cloud Run service.'
    });
    return;
  }

  let upstreamUrl;
  try {
    upstreamUrl = new URL(UPSTREAM_LLM_URL);
  } catch (error) {
    sendJson(res, 500, { error: 'UPSTREAM_LLM_URL is invalid.' });
    return;
  }

  const transport = upstreamUrl.protocol === 'http:' ? http : https;
  const upstreamReq = transport.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || undefined,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(rawBody)
      },
      timeout: REQUEST_TIMEOUT_MS
    },
    (upstreamRes) => {
      const chunks = [];
      upstreamRes.on('data', (chunk) => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        const contentType = upstreamRes.headers['content-type'] || 'application/json; charset=utf-8';
        res.writeHead(upstreamRes.statusCode || 502, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store'
        });
        res.end(responseBody);
      });
    }
  );

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('Upstream request timed out'));
  });

  upstreamReq.on('error', (error) => {
    sendJson(res, 502, {
      error: `Failed to reach upstream LLM gateway: ${error.message}`
    });
  });

  upstreamReq.write(rawBody);
  upstreamReq.end();
}

const server = http.createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 400, { error: 'Invalid request URL.' });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
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
      upstreamConfigured: Boolean(UPSTREAM_LLM_URL)
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/llm') {
    try {
      const rawBody = await getRawBody(req);
      proxyToUpstream(req, res, rawBody);
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
