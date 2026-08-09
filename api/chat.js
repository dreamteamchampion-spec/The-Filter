export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { system, messages, model } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-5',
        max_tokens: 2000,
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
        system,
        messages,
      }),
    });
    const data = await response.json();

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
    return res.status(500).json({ error: err.message });
  }
}
