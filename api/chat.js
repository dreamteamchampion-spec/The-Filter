export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { system, messages, model, stream } = req.body;

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-5',
        // Raised from 2000. This is a CEILING, not a target — output tokens
        // are billed only as actually used, so a higher cap costs nothing
        // extra on short replies. It only stops long ones being truncated.
        // 2000 was fine until C-stage responses grew: the Still Open field,
        // the fuller prep briefings, and long post-date debriefs push a full
        // card (reasoning + gate + frame + move + angle + bids + flags +
        // three tiered replies) past 2000 tokens. When it truncates it fails
        // mid-JSON, so the card breaks rather than simply ending early.
        max_tokens: 8000,
        // Automatic prompt caching. The system prompt is ~12k tokens and is
        // byte-identical on every call, so re-encoding it every turn is pure
        // waste. Writes cost 1.25x base input, reads cost 0.1x, and the
        // 5-minute TTL refreshes on every hit — so a burst of turns pays the
        // write once and reads cheaply thereafter. Because the system prompt
        // is identical for every prospect, switching between prospects inside
        // one sitting still hits the same cache.
        //
        // This CANNOT change model output. It caches the encoding work for a
        // stable prefix, not the response. Same model, same instructions,
        // same reply.
        cache_control: { type: 'ephemeral' },
        // Streaming, requested per-call by the client. This is the fix for
        // "it takes 10 to 20 seconds to respond": nothing rendered until the
        // entire card had been generated, and a full C-stage card is a lot of
        // output tokens. Output tokens are the wall-clock cost, so the only
        // real fix is to show text as it arrives rather than waiting for the
        // last one. This does NOT make generation faster — it makes the first
        // words arrive in about a second instead of after the whole card.
        //
        // Off by default so the summariser and consolidator calls, which
        // nothing watches, keep the simpler JSON path.
        ...(stream ? { stream: true } : {}),
        system,
        messages,
      }),
    });

    // ---- Streaming path: pipe the SSE straight through to the browser -----
    if (stream) {
      if (!upstream.ok || !upstream.body) {
        // Upstream refused before the stream opened (auth, bad request, rate
        // limit). Surface it as normal JSON so the client's existing error
        // handling still works, instead of leaving the browser waiting on a
        // stream that will never produce a token.
        const errText = await upstream.text();
        res.setHeader('Content-Type', 'application/json');
        return res.status(upstream.status || 500).end(errText);
      }
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Belt and braces against anything in front of this buffering the whole
      // response and defeating the point of streaming entirely.
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      const usageLog = { write: 0, read: 0, uncached_input: 0, output: 0 };
      let buffered = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          res.write(chunk);

          // Sniff usage out of the passing stream purely for the server log,
          // so cache behaviour stays verifiable rather than assumed. The
          // client parses its own copy independently for cost display.
          buffered += chunk;
          const lines = buffered.split('\n');
          buffered = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            try {
              const ev = JSON.parse(line.slice(5).trim());
              const u = (ev.message && ev.message.usage) || ev.usage;
              if (!u) continue;
              usageLog.write = u.cache_creation_input_tokens || usageLog.write;
              usageLog.read = u.cache_read_input_tokens || usageLog.read;
              usageLog.uncached_input = u.input_tokens || usageLog.uncached_input;
              usageLog.output = u.output_tokens || usageLog.output;
            } catch { /* partial or non-JSON keepalive line, ignore */ }
          }
        }
      } finally {
        console.log('[cache]', JSON.stringify({ ...usageLog, streamed: true }));
        res.end();
      }
      return;
    }

    // ---- Non-streaming path (summariser, consolidator, card retry) --------
    const data = await upstream.json();

    // Surface cache behaviour so it can be verified rather than assumed.
    // cache_creation_input_tokens = a write happened (first call in a window)
    // cache_read_input_tokens     = a hit, charged at a tenth
    // If reads stay at zero across a burst of turns, caching is NOT working
    // and the saving isn't real, however plausible the config looks.
    if (data && data.usage) {
      console.log('[cache]', JSON.stringify({
        write: data.usage.cache_creation_input_tokens || 0,
        read: data.usage.cache_read_input_tokens || 0,
        uncached_input: data.usage.input_tokens || 0,
        output: data.usage.output_tokens || 0,
      }));
    }

    return res.status(200).json(data);
  } catch (err) {
    // If headers already went out we're mid-stream and can't send JSON any
    // more — just close. The client treats a truncated stream as a failure
    // and offers a retry rather than silently showing half an answer.
    if (res.headersSent) { try { res.end(); } catch { /* already closed */ } return; }
    return res.status(500).json({ error: err.message });
  }
}
