export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, voiceName, speed } = req.body;
  const region = process.env.AZURE_SPEECH_REGION;
  const key = process.env.AZURE_SPEECH_KEY;

  if (!region || !key) {
    return res.status(500).json({ error: 'Missing AZURE_SPEECH_REGION or AZURE_SPEECH_KEY in Vercel environment variables.' });
  }

  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;

  const ssml = `
    <speak version='1.0' xml:lang='en-US'>
      <voice name='${voiceName || 'en-US-AriaNeural'}'>
        <prosody rate='${speed || '+20%'}'>
          ${text}
        </prosody>
      </voice>
    </speak>
  `.trim();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'Tilux-Mobile-Web'
      },
      body: ssml
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: `Azure TTS Error: ${response.status} ${errText}` });
    }

    const audioBuffer = await response.arrayBuffer();
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(audioBuffer));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
