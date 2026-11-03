import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { readToken } from './auth.js';

// Base API URL — environment-overridable so a local dev run can hit a
// non-production KiVio server.
const BASE = process.env['KIVIO_API_BASE'] ?? 'https://api.kidsaivideo.com';

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NotLinkedError extends Error {
  constructor() {
    super('Not linked to a KiVio creator account. Run `kivio-mcp link <code>` first, where <code> is minted on the Studio dashboard.');
    this.name = 'NotLinkedError';
  }
}

function authHeader(): string {
  const t = readToken();
  if (!t?.token) throw new NotLinkedError();
  return `Bearer ${t.token}`;
}

export async function api<T>(path: string, init: {
  method?: 'GET' | 'POST' | 'DELETE' | 'PATCH';
  body?: unknown;
  auth?: boolean;      // default true
} = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.auth !== false) headers['authorization'] = authHeader();

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  const parsed = text ? safeJson(text) : null;
  if (!res.ok) {
    const errCode = (parsed as { error?: string } | null)?.error ?? `HTTP_${res.status}`;
    const errMsg  = (parsed as { message?: string } | null)?.message ?? res.statusText;
    throw new ApiError(res.status, errCode, errMsg);
  }
  return parsed as T;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

// Upload a local file to S3 via the two-step presign + register
// flow the web Studio uses. Returns the videoId once the row is
// registered and queued for the pipeline.
export async function uploadVideoFromDisk(args: {
  filePath: string;
  title: string;
  seriesId?: string | undefined;
  episodeNumber?: number | undefined;
}): Promise<{ videoId: string }> {
  const bytes = readFileSync(args.filePath);
  const filename = basename(args.filePath);
  const contentType = filename.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4';

  // Step 1 — presign. Server returns a storageKey + uploadUrl.
  const presign = await api<{ uploadUrl: string; storageKey: string }>(
    '/creator/videos/presign',
    { method: 'POST', body: { filename, contentType, size: bytes.length } },
  );

  // Step 2 — PUT the file directly to S3. No auth header; the presigned
  // URL is the capability.
  const putRes = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: bytes,
  });
  if (!putRes.ok) {
    throw new ApiError(putRes.status, 'S3_UPLOAD_FAILED', `S3 PUT returned ${putRes.status}`);
  }

  // Step 3 — register. Server queues the moderation pipeline.
  const reg = await api<{ video: { id: string } }>(
    '/creator/videos/register',
    {
      method: 'POST',
      body: {
        storageKey: presign.storageKey,
        title: args.title,
        seriesId: args.seriesId ?? null,
        episodeNumber: args.episodeNumber ?? null,
      },
    },
  );
  return { videoId: reg.video.id };
}
