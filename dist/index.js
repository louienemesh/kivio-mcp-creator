#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { readToken, writeToken, clearToken, tokenPath } from './auth.js';
import { api, uploadVideoFromDisk, NotLinkedError, ApiError } from './api.js';
// -------- CLI commands (link / unlink / status / server) --------
const argv = process.argv.slice(2);
const subcommand = argv[0];
if (subcommand === 'link') {
    const code = argv[1];
    if (!code) {
        console.error('Usage: kivio-mcp link <code>  (mint the code in web Studio first)');
        process.exit(2);
    }
    try {
        const base = process.env['KIVIO_API_BASE'] ?? 'https://api.kidsaivideo.com';
        const res = await fetch(`${base}/public/mcp/consume-code`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        const body = await res.json();
        if (!res.ok || !body.token || !body.creator) {
            console.error('Link failed:', body.error ?? res.statusText);
            process.exit(1);
        }
        writeToken({
            token: body.token,
            creatorId: body.creator.id,
            displayName: body.creator.displayName,
            email: body.creator.email,
            expiresAt: body.expiresAt ?? '',
            linkedAt: new Date().toISOString(),
        });
        console.log(`Linked as ${body.creator.displayName} (${body.creator.email}).`);
        console.log(`Token saved to ${tokenPath()}.`);
        process.exit(0);
    }
    catch (err) {
        console.error('Link failed:', err instanceof Error ? err.message : String(err));
        process.exit(1);
    }
}
if (subcommand === 'unlink') {
    clearToken();
    console.log('Unlinked. Token file cleared.');
    process.exit(0);
}
if (subcommand === 'status') {
    const t = readToken();
    if (!t) {
        console.log('Not linked.');
        process.exit(0);
    }
    console.log(`Linked as ${t.displayName} (${t.email}).`);
    console.log(`Creator id: ${t.creatorId}`);
    console.log(`Linked at:  ${t.linkedAt}`);
    if (t.expiresAt)
        console.log(`Expires:    ${t.expiresAt}`);
    process.exit(0);
}
// Default: run the MCP server over stdio. This is what Claude Code
// and other MCP clients invoke.
// -------- Tool schemas --------
//
// zod schemas are defined once per tool; MCP serves them as JSON
// Schema via a converter at list_tools time, and we re-use them to
// validate inputs inside call_tool. One source of truth per tool.
const emptyIn = z.object({}).strict();
const ListVideosIn = z.object({
    seriesId: z.string().uuid().optional(),
    state: z.enum(['INTAKE', 'QUALITY_CHECK', 'MODERATION', 'SAFE_LIVE', 'REJECTED']).optional(),
}).strict();
const CreateSeriesIn = z.object({
    title: z.string().min(1).max(200),
    totalEpisodesPlanned: z.number().int().min(1).max(500),
    isExclusive: z.boolean().optional(),
    commissionBucket: z.enum(['NONE', 'PUBLIC_COMMISSION', 'PRIVATE_COMMISSION']).optional(),
    description: z.string().max(2000).optional(),
    releaseDate: z.string().datetime().optional(),
}).strict();
const UploadVideoIn = z.object({
    filePath: z.string().min(1),
    title: z.string().min(1).max(200),
    seriesId: z.string().uuid().optional(),
    episodeNumber: z.number().int().positive().optional(),
}).strict();
const ReplaceVideoIn = z.object({
    videoId: z.string().uuid(),
    filePath: z.string().min(1),
}).strict();
const CommissionsListIn = z.object({
    status: z.enum(['PROPOSED', 'COUNTERED', 'ACCEPTED', 'DELIVERED', 'COMPLETED', 'DISPUTED', 'RESOLVED']).optional(),
}).strict();
const CommissionIdIn = z.object({ id: z.string().uuid() }).strict();
const CounterIn = z.object({ id: z.string().uuid(), offerCoins: z.number().int().positive().max(500_000) }).strict();
const DeliverIn = z.object({ id: z.string().uuid(), videoId: z.string().uuid() }).strict();
const ReplyIn = z.object({ threadId: z.string().uuid(), body: z.string().min(1).max(2000) }).strict();
const DeletionReqIn = z.object({ videoId: z.string().uuid(), reason: z.string().min(10).max(1000) }).strict();
const LinkAccountIn = z.object({ code: z.string().min(5).max(40) }).strict();
// -------- Tool catalog --------
const TOOLS = [
    { name: 'kivio.link_account', description: 'Pair this MCP install with a KiVio creator account via a one-time code minted in web Studio.', inputSchema: zodToJsonSchema(LinkAccountIn) },
    { name: 'kivio.whoami', description: 'Return the linked creator profile + wallet state.', inputSchema: zodToJsonSchema(emptyIn) },
    { name: 'kivio.list_series', description: 'List every series owned by the linked creator.', inputSchema: zodToJsonSchema(emptyIn) },
    { name: 'kivio.list_videos', description: 'List the linked creator\'s videos; filter by series and/or state.', inputSchema: zodToJsonSchema(ListVideosIn) },
    { name: 'kivio.get_earnings', description: 'Return available, pending-escrow, and lifetime earnings in coins + USD, plus recent sales.', inputSchema: zodToJsonSchema(emptyIn) },
    { name: 'kivio.create_series', description: 'Create a new series. isExclusive and commissionBucket are set at creation and immutable after.', inputSchema: zodToJsonSchema(CreateSeriesIn) },
    { name: 'kivio.upload_video', description: 'Upload a local video file: presign, PUT to S3, register, queue the moderation pipeline. Returns the new video id.', inputSchema: zodToJsonSchema(UploadVideoIn) },
    { name: 'kivio.replace_video', description: 'Replace the bytes of an existing SAFE_LIVE video (keeps unlocks + views + engagement).', inputSchema: zodToJsonSchema(ReplaceVideoIn) },
    { name: 'kivio.list_commissions', description: 'List commissions addressed to this creator; optional status filter.', inputSchema: zodToJsonSchema(CommissionsListIn) },
    { name: 'kivio.get_commission', description: 'Return one commission\'s full state + the last 20 messages in its chat thread.', inputSchema: zodToJsonSchema(CommissionIdIn) },
    { name: 'kivio.accept_commission', description: 'Accept a PROPOSED commission; coins debit from the parent + 14-day deliver window starts.', inputSchema: zodToJsonSchema(CommissionIdIn) },
    { name: 'kivio.counter_commission', description: 'Counter the price of a PROPOSED commission.', inputSchema: zodToJsonSchema(CounterIn) },
    { name: 'kivio.reject_commission', description: 'Reject a PROPOSED commission (terminal).', inputSchema: zodToJsonSchema(CommissionIdIn) },
    { name: 'kivio.deliver_commission', description: 'Attach a delivery video to an ACCEPTED commission; the video\'s series must be a commission bucket.', inputSchema: zodToJsonSchema(DeliverIn) },
    { name: 'kivio.reply_in_thread', description: 'Send a DM reply in a chat thread. Server-side scrubber strips contact info before store.', inputSchema: zodToJsonSchema(ReplyIn) },
    { name: 'kivio.request_video_deletion', description: 'Submit a SAFE_LIVE video for admin deletion review with a short reason.', inputSchema: zodToJsonSchema(DeletionReqIn) },
];
// -------- Dispatch --------
const server = new Server({ name: 'kivio-mcp-creator', version: '0.1.0' }, {
    capabilities: { tools: {} },
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        const result = await dispatch(name, args ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
    catch (err) {
        const isNotLinked = err instanceof NotLinkedError;
        const isApi = err instanceof ApiError;
        const text = isApi
            ? `[${err.status} ${err.code}] ${err.message}`
            : err instanceof Error ? err.message : String(err);
        return {
            isError: true,
            content: [{ type: 'text', text: isNotLinked ? err.message : text }],
        };
    }
});
async function dispatch(name, raw) {
    switch (name) {
        case 'kivio.link_account': {
            const { code } = LinkAccountIn.parse(raw);
            const base = process.env['KIVIO_API_BASE'] ?? 'https://api.kidsaivideo.com';
            const res = await fetch(`${base}/public/mcp/consume-code`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ code }),
            });
            const body = await res.json();
            if (!res.ok || !body.token || !body.creator) {
                throw new ApiError(res.status, body.error ?? 'LINK_FAILED', body.error ?? res.statusText);
            }
            writeToken({
                token: body.token,
                creatorId: body.creator.id,
                displayName: body.creator.displayName,
                email: body.creator.email,
                expiresAt: body.expiresAt ?? '',
                linkedAt: new Date().toISOString(),
            });
            return { linked: true, creatorId: body.creator.id, displayName: body.creator.displayName };
        }
        case 'kivio.whoami': return api('/creator/me');
        case 'kivio.list_series': return api('/creator/series');
        case 'kivio.list_videos': {
            const q = ListVideosIn.parse(raw);
            const qs = new URLSearchParams();
            if (q.seriesId)
                qs.set('seriesId', q.seriesId);
            if (q.state)
                qs.set('state', q.state);
            const suffix = qs.toString() ? `?${qs}` : '';
            return api(`/creator/videos${suffix}`);
        }
        case 'kivio.get_earnings': return api('/creator/me');
        case 'kivio.create_series': {
            const b = CreateSeriesIn.parse(raw);
            return api('/creator/series', { method: 'POST', body: b });
        }
        case 'kivio.upload_video': {
            const b = UploadVideoIn.parse(raw);
            return uploadVideoFromDisk(b);
        }
        case 'kivio.replace_video': {
            const b = ReplaceVideoIn.parse(raw);
            // Replace uses a separate presign+PUT shape; falls back to the
            // existing /creator/videos/:id/replace endpoint which expects
            // a storageKey of the pre-uploaded replacement.
            const uploaded = await uploadVideoFromDisk({
                filePath: b.filePath,
                title: `replacement for ${b.videoId}`,
                seriesId: undefined,
                episodeNumber: undefined,
            });
            return api(`/creator/videos/${b.videoId}/replace`, {
                method: 'POST',
                body: { replacementVideoId: uploaded.videoId },
            });
        }
        case 'kivio.list_commissions': {
            const q = CommissionsListIn.parse(raw);
            const all = await api('/creator/commissions');
            if (!q.status)
                return all;
            return { commissions: all.commissions.filter(c => c.status === q.status) };
        }
        case 'kivio.get_commission': {
            const { id } = CommissionIdIn.parse(raw);
            const list = await api('/creator/commissions');
            const cm = list.commissions.find(c => c.id === id);
            if (!cm)
                throw new ApiError(404, 'NOT_FOUND', 'commission not found');
            const thread = await api(`/creator/dm/threads/${cm.threadId}/messages`);
            return { commission: cm, recentMessages: thread.messages.slice(-20) };
        }
        case 'kivio.accept_commission': {
            const { id } = CommissionIdIn.parse(raw);
            return api(`/creator/commissions/${id}/accept`, { method: 'POST' });
        }
        case 'kivio.counter_commission': {
            const b = CounterIn.parse(raw);
            return api(`/creator/commissions/${b.id}/counter`, { method: 'POST', body: { offerCoins: b.offerCoins } });
        }
        case 'kivio.reject_commission': {
            const { id } = CommissionIdIn.parse(raw);
            return api(`/creator/commissions/${id}/reject`, { method: 'POST' });
        }
        case 'kivio.deliver_commission': {
            const b = DeliverIn.parse(raw);
            return api(`/creator/commissions/${b.id}/deliver`, { method: 'POST', body: { videoId: b.videoId } });
        }
        case 'kivio.reply_in_thread': {
            const b = ReplyIn.parse(raw);
            return api(`/creator/dm/threads/${b.threadId}/messages`, { method: 'POST', body: { body: b.body } });
        }
        case 'kivio.request_video_deletion': {
            const b = DeletionReqIn.parse(raw);
            return api(`/creator/videos/${b.videoId}/deletion-request`, { method: 'POST', body: { reason: b.reason } });
        }
        default:
            throw new Error(`unknown tool: ${name}`);
    }
}
// Minimal zod → JSON Schema converter. Covers the shapes we use in
// this package (object, string, number, boolean, enum, uuid, optional).
// Full zod-to-json-schema would pull a 500 kB dep; we only need these
// primitive combinators for 15 tools. Return type is cast to Tool's
// inputSchema shape at the call site via `as Tool['inputSchema']` —
// we always start from a ZodObject so the resulting node has
// `type: 'object'`, but TS can't prove that through the dynamic
// switch.
function zodToJsonSchema(schema) {
    const def = schema._def;
    switch (def.typeName) {
        case 'ZodObject': {
            const shape = def.shape();
            const properties = {};
            const required = [];
            for (const [k, v] of Object.entries(shape)) {
                properties[k] = zodToJsonSchema(v);
                if (!v.isOptional?.())
                    required.push(k);
            }
            return required.length > 0
                ? { type: 'object', properties, required }
                : { type: 'object', properties };
        }
        case 'ZodString': {
            const out = { type: 'string' };
            for (const c of (def.checks ?? [])) {
                if (c.kind === 'uuid')
                    out['format'] = 'uuid';
                if (c.kind === 'datetime')
                    out['format'] = 'date-time';
                if (c.kind === 'min' && typeof c.value === 'number')
                    out['minLength'] = c.value;
                if (c.kind === 'max' && typeof c.value === 'number')
                    out['maxLength'] = c.value;
            }
            return out;
        }
        case 'ZodNumber': {
            const out = { type: 'number' };
            for (const c of (def.checks ?? [])) {
                if (c.kind === 'int')
                    out['type'] = 'integer';
                if (c.kind === 'min' && typeof c.value === 'number')
                    out['minimum'] = c.value;
                if (c.kind === 'max' && typeof c.value === 'number')
                    out['maximum'] = c.value;
            }
            return out;
        }
        case 'ZodBoolean': return { type: 'boolean' };
        case 'ZodEnum': return { type: 'string', enum: [...(def.values ?? [])] };
        case 'ZodOptional':
        case 'ZodDefault':
            return def.innerType ? zodToJsonSchema(def.innerType) : { type: 'string' };
        default:
            return { type: 'object', properties: {} };
    }
}
const transport = new StdioServerTransport();
await server.connect(transport);
