/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 selimawn
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash } from "crypto";
import { BrowserWindow, dialog, IpcMainInvokeEvent } from "electron";
import { open, stat } from "fs/promises";
import { basename } from "path";

const BASE = "https://www.swisstransfer.com";
const API = `${BASE}/api/1`;
const XSRF_COOKIE = "SWISSTRANSFER-API-XSRF-TOKEN";
const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const CHUNK_SIZE = 52_428_800;
const MAX_TRANSFER_SIZE = 53_687_091_200;

export interface UploadParams {
    email: string;
    emailValidationId?: string;
    duration: number;
    maxDownloads: number;
    password: string;
    message: string;
    language: string;
}

export type UploadResult =
    | { ok: true; url: string; emailValidationId: string; }
    | { ok: false; reason: "need_code"; emailValidationId: string; message: string; }
    | { ok: false; reason: "need_email"; message: string; }
    | { ok: false; reason: "error"; message: string; };

export type ConfirmEmailResult =
    | { ok: true; }
    | { ok: false; message: string; };

interface LocalFile {
    path: string;
    name: string;
    size: number;
}

class CookieJar {
    private cookies = new Map<string, string>();

    header(): string | undefined {
        if (!this.cookies.size) return;
        return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }

    get(name: string): string | undefined {
        return this.cookies.get(name);
    }

    absorb(headers: Headers) {
        const lines = typeof headers.getSetCookie === "function"
            ? headers.getSetCookie()
            : (headers.get("set-cookie") ? [headers.get("set-cookie")!] : []);

        for (const line of lines) {
            const pair = line.split(";", 1)[0];
            const eq = pair.indexOf("=");
            if (eq <= 0) continue;
            this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
    }
}

interface Session {
    cookies: CookieJar;
    version: string;
}

let session: Session | null = null;

function xsrfToken(cookies: CookieJar): string | undefined {
    const raw = cookies.get(XSRF_COOKIE);
    if (!raw) return;
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

function defaultHeaders(cookies: CookieJar, extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-GB,en;q=0.9",
        Origin: BASE,
        Referer: `${BASE}/en`,
        ...extra
    };
    const cookie = cookies.header();
    if (cookie) headers.Cookie = cookie;
    const token = xsrfToken(cookies);
    if (token) headers["X-XSRF-TOKEN"] = token;
    return headers;
}

async function request(
    cookies: CookieJar,
    url: string,
    init: RequestInit & { json?: unknown; } = {}
): Promise<{ status: number; headers: Headers; text: string; json(): any; }> {
    const { json, headers: extraHeaders, ...rest } = init;
    const headers = defaultHeaders(cookies, extraHeaders as Record<string, string> | undefined);

    if (json !== undefined) {
        headers["Content-Type"] = "application/json";
        headers.Accept = "application/json";
        headers["X-Requested-With"] = "XMLHttpRequest";
        rest.body = JSON.stringify(json);
    }

    const res = await fetch(url, {
        redirect: "manual",
        ...rest,
        headers
    });
    cookies.absorb(res.headers);

    if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (location) {
            return request(cookies, new URL(location, url).href, { method: "GET" });
        }
    }

    const text = await res.text();
    return {
        status: res.status,
        headers: res.headers,
        text,
        json() {
            try {
                return JSON.parse(text);
            } catch {
                throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 300)}`);
            }
        }
    };
}

function parseInertiaVersion(html: string): string {
    const match = html.match(/<script[^>]*data-page="app"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) return "";
    try {
        return JSON.parse(match[1]).version ?? "";
    } catch {
        return "";
    }
}

async function ensureSession(): Promise<Session> {
    if (session?.cookies.get(XSRF_COOKIE) && session.version) return session;

    const cookies = new CookieJar();
    const home = await request(cookies, `${BASE}/en`, {
        method: "GET",
        headers: { Accept: "text/html,application/xhtml+xml" }
    });
    if (home.status >= 400) {
        throw new Error(`Could not reach Swiss Transfer (${home.status})`);
    }

    session = {
        cookies,
        version: parseInertiaVersion(home.text)
    };
    return session;
}

function apiErrorCode(body: any): string | undefined {
    if (body?.result === "error") return body?.error?.code;
}

function apiErrorMessage(body: any, fallback: string): string {
    const errors = body?.error?.errors;
    if (Array.isArray(errors) && errors.length) {
        return errors.map((error: any) => {
            const field = error?.context?.attribute ?? "request";
            const message = error?.description ?? "rejected";
            return `${field}: ${message}`;
        }).join(", ");
    }
    return body?.error?.description || fallback;
}

function rejectedField(body: any, field: string): boolean {
    const errors = body?.error?.errors;
    return Array.isArray(errors) && errors.some((error: any) => error?.context?.attribute === field);
}

async function solveAltcha(cookies: CookieJar): Promise<string> {
    const res = await request(cookies, `${API}/altcha-challenge`, {
        method: "GET",
        headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" }
    });
    if (res.status >= 400) {
        throw new Error(`Could not fetch the anti-bot challenge (${res.status})`);
    }

    const challenge = res.json();
    const max = Number(challenge.maxNumber ?? challenge.maxnumber ?? 1_000_000);
    const algorithm = String(challenge.algorithm || "SHA-256");
    const nodeAlgo = algorithm.toLowerCase().replace("-", "");
    const salt = String(challenge.salt ?? "");
    const expected = String(challenge.challenge ?? "");

    for (let n = 0; n <= max; n++) {
        const hash = createHash(nodeAlgo).update(salt + n).digest("hex");
        if (hash === expected) {
            return Buffer.from(JSON.stringify({
                algorithm,
                challenge: expected,
                number: n,
                salt,
                signature: challenge.signature
            })).toString("base64");
        }
    }

    throw new Error("Could not solve the Swiss Transfer anti-bot challenge");
}

async function requestEmailValidation(cookies: CookieJar, email: string): Promise<string> {
    const res = await request(cookies, `${API}/email-validations`, {
        method: "POST",
        json: { email }
    });
    const body = res.json();
    const code = apiErrorCode(body);
    if (code === "email_validation_rate_limit_error" || code === "email_validation_request_locked") {
        throw new Error("Too many verification emails. Wait a bit and try again.");
    }
    if (body?.result === "error") {
        throw new Error(apiErrorMessage(body, "Could not send the verification email"));
    }

    const id = body?.data?.id;
    if (!id) throw new Error("Swiss Transfer did not return a verification id");
    return String(id);
}

export async function confirmEmail(
    _event: IpcMainInvokeEvent,
    email: string,
    validationId: string,
    code: string
): Promise<ConfirmEmailResult> {
    try {
        const { cookies } = await ensureSession();
        const token = code.replace(/[^a-zA-Z0-9]/g, "");
        const res = await request(cookies, `${API}/email-validations/${validationId}/confirm`, {
            method: "POST",
            json: { token }
        });
        const body = res.json();
        if (apiErrorCode(body) === "invalid_validation_token" || body?.result === "error") {
            return { ok: false, message: apiErrorMessage(body, "That code was not accepted") };
        }
        void email;
        return { ok: true };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}

async function createTransfer(
    sess: Session,
    files: LocalFile[],
    params: UploadParams,
    validationId: string,
    altcha: string
) {
    const headers: Record<string, string> = {};
    if (sess.version) headers["X-Inertia-Version"] = sess.version;

    const res = await request(sess.cookies, `${API}/transfers`, {
        method: "POST",
        headers,
        json: {
            method: "link",
            title: "",
            recipients: [],
            email: params.email,
            message: params.message,
            password: params.password,
            language: params.language,
            max_download: params.maxDownloads,
            expires_in_days: params.duration,
            files: files.map(file => ({
                path: file.name,
                size: file.size,
                mime_type: null
            })),
            altcha,
            email_validation_id: validationId
        }
    });

    const body = res.json();
    if (body?.result === "error") {
        const blob = JSON.stringify(body);
        if (rejectedField(body, "altcha")) throw Object.assign(new Error("altcha"), { code: "altcha" });
        if (blob.includes("verified_email_check_failed") || blob.includes("email_not_verified")) {
            throw Object.assign(new Error("email"), { code: "email" });
        }
        throw new Error(apiErrorMessage(body, `Transfer rejected (${res.status})`));
    }

    return body?.data && typeof body.data === "object" ? body.data : body;
}

function chunkPlan(size: number) {
    if (size === 0) return [{ index: 0, offset: 0, size: 0 }];
    const chunks: { index: number; offset: number; size: number; }[] = [];
    let offset = 0;
    let index = 0;
    while (offset < size) {
        const chunkSize = Math.min(CHUNK_SIZE, size - offset);
        chunks.push({ index, offset, size: chunkSize });
        offset += chunkSize;
        index++;
    }
    return chunks;
}

async function readChunk(path: string, offset: number, size: number): Promise<Buffer> {
    if (size === 0) return Buffer.alloc(0);
    const file = await open(path, "r");
    try {
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await file.read(buffer, 0, size, offset);
        return bytesRead === size ? buffer : buffer.subarray(0, bytesRead);
    } finally {
        await file.close();
    }
}

async function putBytes(url: string, data: Buffer): Promise<string> {
    const res = await fetch(url, {
        method: "PUT",
        headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/octet-stream"
        },
        body: data
    });
    if (!res.ok) {
        throw new Error(`Storage returned ${res.status}`);
    }
    const etag = res.headers.get("etag")?.replaceAll('"', "").trim();
    if (!etag) throw new Error("Storage did not return an ETag");
    return etag;
}

async function uploadLocalFile(
    sess: Session,
    file: LocalFile,
    transferId: string,
    fileId: string
) {
    const chunks = chunkPlan(file.size);
    const direct = chunks.length <= 1;
    const etags: { chunk_index: number; etag: string; }[] = [];

    for (const chunk of chunks) {
        const presignUrl = direct
            ? `${API}/transfers/${transferId}/files/${fileId}`
            : `${API}/transfers/${transferId}/files/${fileId}/chunks/${chunk.index + 1}`;

        const presign = await request(sess.cookies, presignUrl, {
            method: "POST",
            json: {}
        });
        const body = presign.json();
        const url = body?.data?.url;
        if (!url) throw new Error(`No upload URL for ${file.name}`);

        const bytes = await readChunk(file.path, chunk.offset, chunk.size);
        const etag = await putBytes(url, bytes);
        etags.push({ chunk_index: chunk.index + 1, etag });
    }

    await request(sess.cookies, `${API}/transfers/${transferId}/files/${fileId}`, {
        method: "PATCH",
        json: direct ? {} : { etags }
    });
}

function downloadLinkFrom(body: any): string | undefined {
    const url = body?.data?.link?.download_url;
    if (typeof url === "string" && url) return url;
    const id = body?.data?.link?.id ?? body?.link?.id;
    if (typeof id === "string" && id) return `${BASE}/dl/${id}`;
}

async function finalizeTransfer(sess: Session, transferId: string): Promise<string> {
    const res = await request(sess.cookies, `${API}/transfers/${transferId}`, {
        method: "PATCH",
        json: { status: "completed" }
    });
    if (res.status >= 400) {
        throw new Error(`Could not finish the transfer (${res.status})`);
    }
    const body = res.json();
    const url = downloadLinkFrom(body);
    if (!url) throw new Error("Swiss Transfer did not return a download link");
    return url;
}

export async function pickFiles(
    event: IpcMainInvokeEvent,
    kind: "files" | "photos"
): Promise<string[]> {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(window, {
        properties: ["openFile", "multiSelections"],
        filters: kind === "photos"
            ? [{
                name: "Photos",
                extensions: ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff", "mov", "mp4", "m4v"]
            }]
            : undefined
    });
    if (result.canceled) return [];
    return result.filePaths;
}

export async function uploadFiles(
    _event: IpcMainInvokeEvent,
    paths: string[],
    params: UploadParams
): Promise<UploadResult> {
    try {
        if (!params.email.trim()) {
            return { ok: false, reason: "need_email", message: "Set a sender email in the plugin settings first." };
        }
        if (!paths.length) {
            return { ok: false, reason: "error", message: "No files selected." };
        }

        const files: LocalFile[] = [];
        let total = 0;
        for (const path of paths) {
            const info = await stat(path);
            if (!info.isFile()) continue;
            files.push({ path, name: basename(path), size: info.size });
            total += info.size;
        }
        if (!files.length) {
            return { ok: false, reason: "error", message: "None of the selected paths are files." };
        }
        if (total > MAX_TRANSFER_SIZE) {
            return { ok: false, reason: "error", message: "Swiss Transfer accepts at most 50 GB per transfer." };
        }

        const sess = await ensureSession();
        let validationId = params.emailValidationId?.trim() ?? "";
        if (!validationId) {
            validationId = await requestEmailValidation(sess.cookies, params.email.trim());
            return {
                ok: false,
                reason: "need_code",
                emailValidationId: validationId,
                message: `Swiss Transfer emailed a 6-character code to ${params.email}.`
            };
        }

        let altcha = await solveAltcha(sess.cookies);
        let transfer: any;
        try {
            transfer = await createTransfer(sess, files, params, validationId, altcha);
        } catch (error: any) {
            if (error?.code === "email") {
                validationId = await requestEmailValidation(sess.cookies, params.email.trim());
                return {
                    ok: false,
                    reason: "need_code",
                    emailValidationId: validationId,
                    message: `The saved confirmation expired. Swiss Transfer emailed a new code to ${params.email}.`
                };
            }
            if (error?.code === "altcha") {
                altcha = await solveAltcha(sess.cookies);
                transfer = await createTransfer(sess, files, params, validationId, altcha);
            } else {
                throw error;
            }
        }

        const transferId = String(transfer?.id ?? "");
        const remoteFiles: any[] = Array.isArray(transfer?.files) ? transfer.files : [];
        if (!transferId || !remoteFiles.length) {
            throw new Error("Swiss Transfer did not acknowledge the files");
        }

        for (const [index, file] of files.entries()) {
            const remote = remoteFiles.find(item => item?.path === file.name) ?? remoteFiles[index];
            const fileId = String(remote?.id ?? "");
            if (!fileId) throw new Error(`Swiss Transfer did not acknowledge ${file.name}`);
            await uploadLocalFile(sess, file, transferId, fileId);
        }

        const url = await finalizeTransfer(sess, transferId);
        return { ok: true, url, emailValidationId: validationId };
    } catch (error) {
        return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
    }
}
