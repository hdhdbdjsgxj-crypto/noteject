'use strict';
const { randomUUID } = require('node:crypto');
const { requireUser, json, fail, preflight, adminRequest } = require('./_shared');
const { accountLiveMode } = require('./_plans');

// Android uploads at most two minutes of the app's 16 kHz mono PCM WAV at once.
// Keep the request comfortably below Vercel's 4.5 MB function body limit.
const MAX_AUDIO_BYTES = 4_000_000;
const MAX_PROMPT_BYTES = 2400;
const model = () => process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-transcribe';

async function readAudio(req) {
  const declared = Number(req.headers?.['content-length']);
  if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
    throw Object.assign(new Error('Audio segments must be under four megabytes. Retry with a shorter recording segment.'), { statusCode: 413 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_AUDIO_BYTES) throw Object.assign(new Error('Audio segments must be under four megabytes. Retry with a shorter recording segment.'), { statusCode: 413 });
    chunks.push(bytes);
  }
  if (size < 46) throw Object.assign(new Error('The audio segment is empty or incomplete.'), { statusCode: 400 });
  const audio = Buffer.concat(chunks, size);
  const marker = (offset, value) => audio.subarray(offset, offset + value.length).toString('ascii') === value;
  const dataBytes = audio.readUInt32LE(40);
  if (!marker(0, 'RIFF') || !marker(8, 'WAVE') || !marker(12, 'fmt ') || !marker(36, 'data') ||
      audio.readUInt32LE(4) !== size - 8 || dataBytes !== size - 44 || audio.readUInt32LE(16) !== 16 ||
      audio.readUInt16LE(20) !== 1 || audio.readUInt16LE(22) !== 1 || audio.readUInt32LE(24) !== 16000 ||
      audio.readUInt32LE(28) !== 32000 || audio.readUInt16LE(32) !== 2 || audio.readUInt16LE(34) !== 16 || dataBytes % 2) {
    throw Object.assign(new Error('This is not a valid Noteject WAV audio segment.'), { statusCode: 400 });
  }
  return audio;
}

function promptContext(req) {
  const encoded = String(req.query?.context || '');
  if (!encoded) return '';
  if (!/^[A-Za-z0-9_-]{1,3600}$/.test(encoded)) throw Object.assign(new Error('The transcription context is invalid.'), { statusCode: 400 });
  const text = Buffer.from(encoded, 'base64url').toString('utf8').trim();
  if (Buffer.byteLength(text, 'utf8') > MAX_PROMPT_BYTES) throw Object.assign(new Error('The transcription context is too long.'), { statusCode: 400 });
  return text.slice(-1200);
}

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
  if (!process.env.OPENAI_API_KEY) return json(res, 503, { error: 'Noteject AI is not configured on this site yet.' });
  let reservation, auth, providerSubmitted = false, canRelease = false;
  try {
    auth = await requireUser(req);
    const contentType = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'audio/wav') return json(res, 415, { error: 'Send a WAV audio segment to transcribe.' });
    const audio = await readAudio(req);
    const prompt = promptContext(req);
    const requestId = randomUUID();
    reservation = await adminRequest('rpc/noteject_reserve_ai_action', {
      p_user_id: auth.user.id, p_action_kind: 'advanced', p_request_id: requestId, p_livemode: accountLiveMode()
    });
    if (!Number.isSafeInteger(Number(reservation?.id)) || Number(reservation.id) < 1) {
      throw Object.assign(new Error('Could not start AI usage tracking.'), { statusCode: 503 });
    }

    const form = new FormData();
    form.set('model', model());
    form.set('file', new Blob([audio], { type: 'audio/wav' }), 'recording.wav');
    if (prompt) form.set('prompt', prompt);
    providerSubmitted = true;
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body: form,
      signal: AbortSignal.timeout(80000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      canRelease = [400, 401, 403, 404, 413, 415, 422, 429].includes(response.status);
      throw Object.assign(new Error(response.status === 401 || response.status === 403
        ? 'Noteject AI needs a connection update by the site owner.'
        : response.status === 429 ? 'AI transcription is temporarily busy. Wait a moment and try again.'
          : 'This audio segment could not be transcribed. The original recording is still saved.'), { statusCode: 503 });
    }
    const transcript = typeof result.text === 'string' ? result.text.trim() : '';
    let usageRecorded = false;
    try {
      usageRecorded = await adminRequest('rpc/noteject_complete_ai_action', {
        p_user_id: auth.user.id, p_event_id: reservation.id, p_model: model(),
        p_input_tokens: Number(result.usage?.input_tokens) || 0, p_output_tokens: Number(result.usage?.output_tokens) || 0
      });
    } catch { /* Keep the reservation counted if the provider succeeded. */ }
    return json(res, 200, { text: transcript, plan: reservation.plan, aiTier: 'advanced', remaining: reservation.remaining, usageRecorded: usageRecorded === true });
  } catch (error) {
    if (reservation?.id && auth && (!providerSubmitted || canRelease)) {
      await adminRequest('rpc/noteject_fail_ai_action', { p_user_id: auth.user.id, p_event_id: reservation.id }).catch(() => {});
    }
    if (error.code === 'AI_ADVANCED_UNAVAILABLE') error.message = 'AI transcription requires a paid Starter, Pro, or Team plan.';
    else if (error.code === 'AI_MONTHLY_LIMIT') error.message = 'You have used this month’s Advanced AI allowance. Check your plan for the reset date.';
    else if (error.code === 'AI_RATE_LIMIT') error.message = 'Please wait a moment before transcribing more audio.';
    else if (error.code === 'AI_BUSY') error.message = 'Another AI action is still running. Wait for it to finish and try again.';
    fail(res, error, 'Could not transcribe this audio segment. Your recording is still saved.');
  }
};
module.exports.config = { api: { bodyParser: false } };
