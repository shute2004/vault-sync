export class FileSystemAdapter {
  constructor(private readonly basePath: string) {}

  getBasePath(): string {
    return this.basePath;
  }
}

export const Platform = {
  isDesktopApp: true
};

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string;
  throw?: boolean;
  headers?: Record<string, string>;
}

export interface RequestUrlResponse {
  status: number;
  text: string;
  json: unknown;
}

type RequestHandler = (request: RequestUrlParam) => Promise<RequestUrlResponse> | RequestUrlResponse;
let requestHandler: RequestHandler | null = null;

export function setRequestUrlHandler(handler: RequestHandler | null): void {
  requestHandler = handler;
}

export async function requestUrl(request: RequestUrlParam): Promise<RequestUrlResponse> {
  if (!requestHandler) {
    throw new Error("No requestUrl test handler is installed.");
  }
  return await requestHandler(request);
}

export function normalizePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .replace(/\/$/, "");
}

export function arrayBufferToBase64(data: ArrayBuffer): string {
  return Buffer.from(new Uint8Array(data)).toString("base64");
}

export function base64ToArrayBuffer(value: string): ArrayBuffer {
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  return bytes.buffer;
}
