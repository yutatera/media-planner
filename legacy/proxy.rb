require 'webrick'
require 'net/http'
require 'uri'
require 'json'

PORT = 8000
STATIC_DIR = File.dirname(__FILE__)

server = WEBrick::HTTPServer.new(Port: PORT, DocumentRoot: STATIC_DIR)


def add_cors(res)
  res['Access-Control-Allow-Origin'] = '*'
  res['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
  res['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, anthropic-version'
end


def post_json(url, headers, body)
  target = URI.parse(url)
  http = Net::HTTP.new(target.host, target.port)
  http.use_ssl = (target.scheme == 'https')
  http.read_timeout = 180
  http.open_timeout = 30

  req = Net::HTTP::Post.new(target.request_uri)
  headers.each { |k, v| req[k] = v }
  req.body = body.to_json

  http.request(req)
end


def extract_text(provider, raw_body)
  data = JSON.parse(raw_body)

  case provider
  when 'anthropic'
    return data.dig('content', 0, 'text').to_s
  when 'gemini'
    parts = data.dig('candidates', 0, 'content', 'parts') || []
    return parts.map { |p| p['text'].to_s }.join
  when 'rakutenai'
    return data.dig('choices', 0, 'message', 'content').to_s
  else
    return ''
  end
rescue
  ''
end

# Unified endpoint expected by ad-strategy-studio-internal-api.html
# Request body: { key, provider, model, system, user }
server.mount_proc('/api/llm') do |req, res|
  add_cors(res)
  if req.request_method == 'OPTIONS'
    res.status = 204
    next
  end

  begin
    payload = JSON.parse(req.body || '{}')
    key = payload['key'].to_s
    provider = payload['provider'].to_s
    model = payload['model'].to_s
    system_prompt = payload['system'].to_s
    user_prompt = payload['user'].to_s

    raise 'Missing key' if key.empty?
    raise 'Missing provider' if provider.empty?
    raise 'Missing model' if model.empty?

    case provider
    when 'anthropic'
      upstream = post_json(
        'https://api.ai.public.rakuten-it.com/anthropic/v1/messages',
        {
          'Content-Type' => 'application/json',
          'Authorization' => key,
          'anthropic-version' => '2023-06-01'
        },
        {
          model: model,
          max_tokens: 4000,
          system: system_prompt,
          messages: [{ role: 'user', content: user_prompt }]
        }
      )
    when 'gemini'
      upstream = post_json(
        "https://api.ai.public.rakuten-it.com/google-vertexai/v1/publishers/google/models/#{URI.encode_www_form_component(model)}:generateContent",
        {
          'Content-Type' => 'application/json',
          'Authorization' => key
        },
        {
          system_instruction: { parts: [{ text: system_prompt }] },
          contents: [{ role: 'user', parts: [{ text: user_prompt }] }],
          generationConfig: { maxOutputTokens: 4000 }
        }
      )
    when 'rakutenai'
      upstream = post_json(
        'https://api.ai.public.rakuten-it.com/rakutenllms/v1/chat/completions',
        {
          'Content-Type' => 'application/json',
          'Authorization' => "Bearer #{key}"
        },
        {
          model: model,
          stream: false,
          messages: [
            { role: 'system', content: system_prompt },
            { role: 'user', content: user_prompt }
          ]
        }
      )
    else
      raise "Unsupported provider: #{provider}"
    end

    res.status = upstream.code.to_i
    res['Content-Type'] = 'application/json'

    if upstream.code.to_i >= 200 && upstream.code.to_i < 300
      res.body = JSON.generate({ text: extract_text(provider, upstream.body), raw: JSON.parse(upstream.body) })
    else
      res.body = JSON.generate({ error: upstream.body })
    end
  rescue => e
    res.status = 500
    res['Content-Type'] = 'application/json'
    res.body = JSON.generate({ error: e.message })
  end
end

# Legacy endpoints kept for old HTML versions.
def proxy(req, res, target_url, extra_headers = {})
  target = URI.parse(target_url)
  http = Net::HTTP.new(target.host, 443)
  http.use_ssl = true
  http.read_timeout = 120

  proxy_req = Net::HTTP::Post.new(target.request_uri)
  proxy_req['Content-Type'] = 'application/json'
  proxy_req['Authorization'] = req['Authorization']
  extra_headers.each { |k, v| proxy_req[k] = v }
  proxy_req.body = req.body

  proxy_res = http.request(proxy_req)
  res.status = proxy_res.code.to_i
  res['Content-Type'] = 'application/json'
  res.body = proxy_res.body
rescue => e
  res.status = 500
  res.body = JSON.generate({ error: e.message })
end

server.mount_proc('/proxy/anthropic') do |req, res|
  add_cors(res)
  next if req.request_method == 'OPTIONS'
  proxy(req, res,
    'https://api.ai.public.rakuten-it.com/anthropic/v1/messages',
    { 'anthropic-version' => '2023-06-01' }
  )
end

server.mount_proc('/proxy/rakuten') do |req, res|
  add_cors(res)
  next if req.request_method == 'OPTIONS'
  proxy(req, res,
    'https://api.ai.public.rakuten-it.com/rakutenllms/v1/chat/completions'
  )
end

trap('INT') { server.shutdown }
puts "Server running at http://localhost:#{PORT}"
puts "  Decision Lab:     http://localhost:#{PORT}/decision-lab-rakuten-gateway.html"
puts "  Ad Strategy:      http://localhost:#{PORT}/ad-strategy-studio-internal-api.html"
puts "  Media Planner:    http://localhost:#{PORT}/media-planner-rakuten-gateway.html"
puts "Proxy URL: /api/llm"
server.start
