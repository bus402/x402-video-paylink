export type StreamKind = "hls" | "dash" | "progressive";

export interface Wrapped {
  id: string;
  originUrl: string;
  kind: StreamKind;
  createdAt: number;
  // For progressive streams, store the original file extension
  originalExt?: string;
}

export interface WrapRequest {
  url: string;
}

export interface WrapResponse {
  wrappedUrl: string;
}
