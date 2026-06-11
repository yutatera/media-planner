const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL } = require('url');

let PrismaClient = null;
try {
  ({ PrismaClient } = require('@prisma/client'));
} catch (error) {
  PrismaClient = null;
}

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const HTML_PATH = path.join(__dirname, 'media-planner-rakuten-gateway.html');
const USAGE_HTML_PATH = path.join(__dirname, 'usage.html');
const UPSTREAM_LLM_URL = process.env.UPSTREAM_LLM_URL || '';
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 180000);
const EGRESS_IP_CHECK_URL = process.env.EGRESS_IP_CHECK_URL || 'https://api.ipify.org?format=json';
const EGRESS_IP_CHECK_TIMEOUT_MS = Number(process.env.EGRESS_IP_CHECK_TIMEOUT_MS || 10000);
const DEBUG_PROBE_TIMEOUT_MS = Number(process.env.DEBUG_PROBE_TIMEOUT_MS || 10000);
const DATABASE_URL = process.env.DATABASE_URL || '';

const HTML_BODY = fs.readFileSync(HTML_PATH);
const USAGE_HTML_BODY = fs.readFileSync(USAGE_HTML_PATH);
const prisma = PrismaClient && DATABASE_URL ? new PrismaClient() : null;

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

function sendHtml(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
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

function getUsageTrackingStatus() {
  if (prisma) {
    return {
      enabled: true,
      dependencyAvailable: true,
      databaseConfigured: true,
      reason: 'ready'
    };
  }

  if (!DATABASE_URL) {
    return {
      enabled: false,
      dependencyAvailable: Boolean(PrismaClient),
      databaseConfigured: false,
      reason: 'missing_database_url'
    };
  }

  return {
    enabled: false,
    dependencyAvailable: false,
    databaseConfigured: true,
    reason: 'missing_prisma_client'
  };
}

function isMissingUsageTableError(error) {
  if (!error) return false;
  if (error.code === 'P2021') return true;
  return typeof error.message === 'string' && error.message.includes('usage_events');
}

function getPrismaCliPath() {
  return path.join(__dirname, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');
}

function runStartupMigrations() {
  if (!DATABASE_URL || !prisma) {
    return;
  }

  const prismaCliPath = getPrismaCliPath();
  if (!fs.existsSync(prismaCliPath)) {
    logEvent('startup_migration_skipped', {
      reason: 'missing_prisma_cli'
    });
    return;
  }

  logEvent('startup_migration_begin', {
    command: 'prisma migrate deploy'
  });

  try {
    const output = execFileSync(prismaCliPath, ['migrate', 'deploy'], {
      cwd: __dirname,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    logEvent('startup_migration_success', {
      output: output.trim().slice(0, 4000)
    });
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : '';
    const stderr = error.stderr ? String(error.stderr) : '';
    logEvent('startup_migration_failure', {
      error: error.message,
      stdout: stdout.trim().slice(0, 4000),
      stderr: stderr.trim().slice(0, 4000)
    });
    throw error;
  }
}

function getIapUserEmail(req) {
  const headerCandidates = [
    req.headers['x-goog-authenticated-user-email'],
    req.headers['x-forwarded-email'],
    req.headers['x-goog-authenticated-user-id']
  ];

  for (const candidate of headerCandidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    const normalized = trimmed.includes(':') ? trimmed.slice(trimmed.indexOf(':') + 1) : trimmed;
    if (normalized.includes('@')) {
      return normalized.toLowerCase();
    }
  }

  return null;
}

function getTraceId(req) {
  const raw = String(req.headers['x-cloud-trace-context'] || '').trim();
  if (!raw) return null;
  const traceId = raw.split('/')[0].trim();
  return traceId || null;
}

function getPagePath(req, payload = null) {
  if (payload && typeof payload.pagePath === 'string' && payload.pagePath.startsWith('/')) {
    return payload.pagePath;
  }

  const referer = String(req.headers.referer || '');
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      return refererUrl.pathname || '/';
    } catch (error) {
      return '/';
    }
  }

  return '/';
}

async function recordUsageEvent(eventData) {
  if (!prisma) {
    return;
  }

  try {
    await prisma.usageEvent.create({
      data: {
        occurredAt: eventData.occurredAt || new Date(),
        userEmail: eventData.userEmail || null,
        pagePath: eventData.pagePath || '/',
        eventType: eventData.eventType,
        provider: eventData.provider || null,
        model: eventData.model || null,
        success: typeof eventData.success === 'boolean' ? eventData.success : null,
        statusCode: Number.isInteger(eventData.statusCode) ? eventData.statusCode : null,
        durationMs: Number.isInteger(eventData.durationMs) ? eventData.durationMs : null,
        requestBytes: Number.isInteger(eventData.requestBytes) ? eventData.requestBytes : null,
        responseBytes: Number.isInteger(eventData.responseBytes) ? eventData.responseBytes : null,
        systemLength: Number.isInteger(eventData.systemLength) ? eventData.systemLength : null,
        userLength: Number.isInteger(eventData.userLength) ? eventData.userLength : null,
        errorMessage: eventData.errorMessage || null,
        traceId: eventData.traceId || null,
        metadata: eventData.metadata || undefined
      }
    });
  } catch (error) {
    logEvent('usage_record_error', {
      error: error.message,
      eventType: eventData.eventType,
      pagePath: eventData.pagePath || '/',
      userEmail: eventData.userEmail || null
    });
  }
}

function recordPageView(req, pagePath) {
  return recordUsageEvent({
    eventType: 'PAGE_VIEW',
    pagePath,
    userEmail: getIapUserEmail(req),
    traceId: getTraceId(req),
    metadata: {
      method: req.method || 'GET'
    }
  });
}

function clampUsageDays(rawValue) {
  const value = Number.parseInt(String(rawValue || '7'), 10);
  if (!Number.isFinite(value)) return 7;
  return Math.min(90, Math.max(1, value));
}

async function buildUsageSummary(days) {
  const status = getUsageTrackingStatus();
  if (!prisma) {
    return {
      usageTracking: status,
      summary: {
        totalEvents: 0,
        llmCalls: 0,
        successRate: 0,
        activeUsers: 0
      },
      topUsers: [],
      modelUsage: [],
      recentEvents: []
    };
  }

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const baseWhere = {
    occurredAt: { gte: since }
  };

  let totalEvents;
  let llmCalls;
  let llmSuccessCount;
  let userGroups;
  let modelGroups;
  let recentEvents;

  try {
    [
      totalEvents,
      llmCalls,
      llmSuccessCount,
      userGroups,
      modelGroups,
      recentEvents
    ] = await Promise.all([
      prisma.usageEvent.count({ where: baseWhere }),
      prisma.usageEvent.count({
        where: {
          ...baseWhere,
          eventType: 'LLM_REQUEST'
        }
      }),
      prisma.usageEvent.count({
        where: {
          ...baseWhere,
          eventType: 'LLM_REQUEST',
          success: true
        }
      }),
      prisma.usageEvent.groupBy({
        by: ['userEmail', 'eventType'],
        where: {
          ...baseWhere,
          userEmail: {
            not: null
          }
        },
        _count: {
          _all: true
        }
      }),
      prisma.usageEvent.groupBy({
        by: ['provider', 'model', 'success'],
        where: {
          ...baseWhere,
          eventType: 'LLM_REQUEST'
        },
        _count: {
          _all: true
        }
      }),
      prisma.usageEvent.findMany({
        where: baseWhere,
        orderBy: {
          occurredAt: 'desc'
        },
        take: 30,
        select: {
          occurredAt: true,
          userEmail: true,
          pagePath: true,
          eventType: true,
          provider: true,
          model: true,
          success: true,
          statusCode: true,
          durationMs: true,
          errorMessage: true
        }
      })
    ]);
  } catch (error) {
    if (isMissingUsageTableError(error)) {
      return {
        usageTracking: {
          ...status,
          enabled: false,
          reason: 'missing_usage_table'
        },
        summary: {
          totalEvents: 0,
          llmCalls: 0,
          successRate: 0,
          activeUsers: 0
        },
        topUsers: [],
        modelUsage: [],
        recentEvents: []
      };
    }

    throw error;
  }

  const userMap = new Map();
  for (const row of userGroups) {
    if (!row.userEmail) continue;
    const existing = userMap.get(row.userEmail) || {
      userEmail: row.userEmail,
      totalEvents: 0,
      pageViews: 0,
      llmCalls: 0
    };
    existing.totalEvents += row._count._all;
    if (row.eventType === 'PAGE_VIEW') {
      existing.pageViews += row._count._all;
    }
    if (row.eventType === 'LLM_REQUEST') {
      existing.llmCalls += row._count._all;
    }
    userMap.set(row.userEmail, existing);
  }

  const topUsers = Array.from(userMap.values())
    .sort((left, right) => right.totalEvents - left.totalEvents)
    .slice(0, 8);

  const modelMap = new Map();
  for (const row of modelGroups) {
    const key = `${row.provider || ''}::${row.model || ''}`;
    const existing = modelMap.get(key) || {
      provider: row.provider || null,
      model: row.model || null,
      count: 0,
      successCount: 0,
      failureCount: 0
    };
    existing.count += row._count._all;
    if (row.success === true) existing.successCount += row._count._all;
    if (row.success === false) existing.failureCount += row._count._all;
    modelMap.set(key, existing);
  }

  const modelUsage = Array.from(modelMap.values())
    .sort((left, right) => right.count - left.count)
    .slice(0, 8);

  return {
    usageTracking: status,
    summary: {
      totalEvents,
      llmCalls,
      successRate: llmCalls > 0 ? (llmSuccessCount / llmCalls) * 100 : 0,
      activeUsers: userMap.size
    },
    topUsers,
    modelUsage,
    recentEvents
  };
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

async function handleBuiltinGateway(req, res, rawBody) {
  const payload = parseJson(rawBody) || {};
  const provider = normalizeProvider(String(payload.provider || ''));
  const providerConfig = PROVIDERS[provider];
  const key = String(payload.key || payload.apiKey || '').trim();
  const model = String(payload.model || '').trim();
  const system = String(payload.system || '');
  const user = String(payload.user || '');
  const requestStartedAt = Date.now();
  const userEmail = getIapUserEmail(req);
  const pagePath = getPagePath(req, payload);
  const traceId = getTraceId(req);

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
    upstreamBodyBytes: Buffer.byteLength(requestBody),
    userEmail,
    pagePath
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
    const durationMs = Date.now() - requestStartedAt;
    const success = upstream.statusCode >= 200 && upstream.statusCode < 300 && Boolean(data);

    await recordUsageEvent({
      occurredAt: new Date(requestStartedAt),
      eventType: 'LLM_REQUEST',
      userEmail,
      pagePath,
      provider,
      model,
      success,
      statusCode: upstream.statusCode,
      durationMs,
      requestBytes: Buffer.byteLength(requestBody),
      responseBytes: Buffer.byteLength(upstream.body || '', 'utf8'),
      systemLength: system.length,
      userLength: user.length,
      errorMessage: success ? null : typeof upstream.body === 'string' ? upstream.body.slice(0, 1000) : null,
      traceId
    });

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
    await recordUsageEvent({
      occurredAt: new Date(requestStartedAt),
      eventType: 'LLM_REQUEST',
      userEmail,
      pagePath,
      provider,
      model,
      success: false,
      statusCode: 502,
      durationMs: Date.now() - requestStartedAt,
      requestBytes: Buffer.byteLength(requestBody),
      systemLength: system.length,
      userLength: user.length,
      errorMessage: error.message,
      traceId
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
    sendHtml(res, 200, HTML_BODY);
    void recordPageView(req, '/');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/usage') {
    sendHtml(res, 200, USAGE_HTML_BODY);
    void recordPageView(req, '/usage');
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
        await handleBuiltinGateway(req, res, rawBody);
      }
    } catch (error) {
      const statusCode = error.message === 'Request body too large' ? 413 : 400;
      sendJson(res, statusCode, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/usage/summary') {
    try {
      const days = clampUsageDays(url.searchParams.get('days'));
      const summary = await buildUsageSummary(days);
      sendJson(res, 200, {
        currentUser: getIapUserEmail(req),
        range: {
          days
        },
        ...summary
      });
    } catch (error) {
      sendJson(res, 500, {
        error: `Failed to load usage summary: ${error.message}`,
        usageTracking: getUsageTrackingStatus()
      });
    }
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
});

try {
  runStartupMigrations();
} catch (error) {
  console.error(`Startup migration failed: ${error.message}`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  logEvent('usage_tracking_status', getUsageTrackingStatus());
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
