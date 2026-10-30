// Multipart receiver for uploads (attachments, Phase 12; profile photo, 12b).
// Kept out of route files, which never read the raw request (registry tests).
import busboy from "busboy";
import type { Readable } from "node:stream";
import type { Request, Response } from "express";
import { ErrorCode } from "@shared/errors";
import { AppError } from "../errors.ts";

/** What a receiver gets for the single `file` part. */
export interface UploadPart {
  filename: string;
  clientType: string;
  /** The request length, when known (bounds quota reservations). */
  declaredBytes: number | undefined;
}

/**
 * Browsers escape `"`, CR and LF in multipart filenames (HTML form encoding);
 * this restores them before the name is sanitized for display.
 */
function browserFilename(raw: string | undefined): string {
  return (raw ?? "").replace(/%22/g, '"').replace(/%0D|%0A/gi, " ");
}

/**
 * Streams the single `file` part of a multipart/form-data request into
 * `receive`. Any other field or a second file is rejected. When the upload
 * fails before the body is read (size, quota, type), the connection is closed
 * after the error response so the client stops sending.
 */
export function receiveUpload<T>(
  req: Request,
  res: Response,
  receive: (stream: Readable, part: UploadPart) => Promise<T>,
): Promise<T> {
  const type = req.headers["content-type"] ?? "";
  if (!/^multipart\/form-data;/i.test(type)) {
    return Promise.reject(
      new AppError(ErrorCode.VALIDATION, "Send the file as multipart/form-data in a `file` field"),
    );
  }
  const length = Number(req.headers["content-length"]);
  const declaredBytes = Number.isSafeInteger(length) && length >= 0 ? length : undefined;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let started = false;
    let current: Readable | null = null;
    const parser = busboy({
      headers: req.headers,
      defParamCharset: "utf8",
      // `files` and `fields` fire their events on the first part over the limit;
      // `parts` only bounds parsing (busboy signals it when the count is reached).
      limits: { files: 1, fields: 0, parts: 4, headerPairs: 32 },
    });
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      req.unpipe(parser);
      // A file still being received ends with an error, so the store cleans it up.
      if (current && !current.readableEnded) current.destroy(new Error("upload aborted"));
      res.set("Connection", "close");
      reject(error instanceof Error ? error : new Error("upload failed"));
    };
    parser.on("file", (field, stream, info) => {
      // After a rejection (an extra field, say) nothing more is stored.
      if (settled || field !== "file" || started) {
        stream.resume();
        fail(new AppError(ErrorCode.VALIDATION, "Send exactly one file in a `file` field"));
        return;
      }
      started = true;
      current = stream;
      // Errors reach the store through its async iteration; none is left unhandled.
      stream.on("error", () => undefined);
      receive(stream, {
        filename: browserFilename(info.filename),
        clientType: info.mimeType,
        declaredBytes,
      }).then(
        (meta) => {
          if (settled) return;
          settled = true;
          resolve(meta);
        },
        (error: unknown) => {
          stream.resume();
          fail(error);
        },
      );
    });
    parser.on("fieldsLimit", () => {
      fail(new AppError(ErrorCode.VALIDATION, "Send exactly one file in a `file` field"));
    });
    parser.on("filesLimit", () => {
      fail(new AppError(ErrorCode.VALIDATION, "Send exactly one file in a `file` field"));
    });
    parser.on("error", () => {
      fail(new AppError(ErrorCode.VALIDATION, "The upload is not valid multipart/form-data"));
    });
    parser.on("close", () => {
      if (!started) fail(new AppError(ErrorCode.VALIDATION, "No file was sent"));
    });
    req.on("close", () => {
      if (!req.complete) fail(new AppError(ErrorCode.VALIDATION, "The upload was interrupted"));
    });
    req.pipe(parser);
  });
}
