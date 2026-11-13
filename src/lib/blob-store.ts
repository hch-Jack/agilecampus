import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors";
import { MAX_FILE_SIZE, MAX_FILE_SIZE_LABEL } from "./file-limits";

/**
 * 附件二进制落盘层。
 *
 * 1GB 的文件不能塞进 `bytea` 再整份读进内存（PostgreSQL 单值上限约 1GB，驱动/服务端
 * 还要再复制几份），所以大文件的正文写在磁盘上，库里只留元数据 + `storageKey`。
 * 旧的 `data` 列保留：历史附件仍是库里的小 blob，读写两条路都走同一组入口。
 *
 * 目录：`UPLOAD_DIR`（默认 `<cwd>/data/uploads`）。生产 compose 挂了卷；本机 dev
 * 就落在仓库的 `data/` 下（已 gitignore）。
 */

export function uploadRoot(): string {
  const fromEnv = process.env.UPLOAD_DIR?.trim();
  return fromEnv || path.join(process.cwd(), "data", "uploads");
}

// 键形如 `ab/ab12…`（前两位是 uuid 的前两位，避免单目录塞进几十万文件）
const KEY_RE = /^[0-9a-f]{2}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isBlobKey(value: unknown): value is string {
  return typeof value === "string" && KEY_RE.test(value);
}

/** 只接受本模块生成的键；挡掉 `../` 之类的路径穿越 */
export function blobPath(storageKey: string): string {
  if (!isBlobKey(storageKey)) throw new AppError("文件不存在");
  return path.join(uploadRoot(), storageKey);
}

function newKey(): string {
  const id = randomUUID();
  return `${id.slice(0, 2)}/${id}`;
}

/**
 * 文件内容入参。`storageKey` = 已在磁盘上的源文件（复制一份，各存各的）；
 * `data` = 内存里的字节（历史路径、测试、助手生成的小文件）。
 */
export type FileContentInput = {
  data?: Buffer | null;
  storageKey?: string | null;
  /** 调用方声明的体积；与实际字节不一致时也先按它拦一次（防御性，不落库） */
  size?: number;
};

export type StoredBlob = {
  size: number;
  data: Buffer;
  storageKey: string | null;
};

/**
 * 把入参落成「库里要写的那三列」：
 * - 磁盘源 → 复制成一个**新键**，`data` 写空 Buffer（列仍 notNull，避免改表）；
 * - 内存字节 → 原样进 `data`（沿用旧行为，历史测试与生成的小文件都走这条）。
 */
export async function persistBlob(
  input: FileContentInput,
  maxSize: number = MAX_FILE_SIZE,
): Promise<StoredBlob> {
  if (typeof input.size === "number" && input.size > maxSize) {
    throw new AppError(`文件不能超过 ${MAX_FILE_SIZE_LABEL}`);
  }
  if (input.storageKey) {
    const copied = await copyBlob(input.storageKey, maxSize);
    return { size: copied.size, data: Buffer.alloc(0), storageKey: copied.storageKey };
  }
  const data = input.data;
  if (!data || data.length === 0) throw new AppError("不能上传空文件");
  if (data.length > maxSize) throw new AppError(`文件不能超过 ${MAX_FILE_SIZE_LABEL}`);
  return { size: data.length, data, storageKey: null };
}

/** 把来自 HTTP 的字节流转成磁盘文件；超限/空文件都会把半成品删掉 */
export async function saveBlobFromStream(
  stream: ReadableStream<Uint8Array> | null,
  maxSize: number = MAX_FILE_SIZE,
): Promise<{ storageKey: string; size: number }> {
  if (!stream) throw new AppError("没有收到文件内容");

  const storageKey = newKey();
  const dir = path.join(uploadRoot(), storageKey.slice(0, 2));
  await mkdir(dir, { recursive: true });
  const finalPath = path.join(uploadRoot(), storageKey);
  const partPath = `${finalPath}.part`;

  const handle = await open(partPath, "w");
  let size = 0;
  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maxSize) {
        throw new AppError(`文件不能超过 ${MAX_FILE_SIZE_LABEL}`);
      }
      await handle.write(chunk);
    }
    await handle.close();
    if (size === 0) throw new AppError("不能上传空文件");
    await rename(partPath, finalPath);
    return { storageKey, size };
  } catch (e) {
    await handle.close().catch(() => {});
    await unlink(partPath).catch(() => {});
    throw e;
  }
}

/**
 * 把内存里的字节写成一份新磁盘 blob（在线文档保存用）。
 * 与 `saveBlobFromStream` 一样先写 `.part` 再 rename，失败时清掉半成品；
 * 不做原地覆盖——旧 blob 留给版本历史。
 */
export async function saveBlobFromBuffer(
  data: Buffer,
  maxSize: number = MAX_FILE_SIZE,
): Promise<{ storageKey: string; size: number }> {
  if (!data || data.length === 0) throw new AppError("不能保存空文件");
  if (data.length > maxSize) throw new AppError(`文件不能超过 ${MAX_FILE_SIZE_LABEL}`);

  const storageKey = newKey();
  const dir = path.join(uploadRoot(), storageKey.slice(0, 2));
  await mkdir(dir, { recursive: true });
  const finalPath = path.join(uploadRoot(), storageKey);
  const partPath = `${finalPath}.part`;

  const handle = await open(partPath, "w");
  try {
    await handle.write(data);
    await handle.close();
    await rename(partPath, finalPath);
    return { storageKey, size: data.length };
  } catch (e) {
    await handle.close().catch(() => {});
    await unlink(partPath).catch(() => {});
    throw e;
  }
}

/** 复制一份磁盘 blob（新键）。源不存在 → 「文件不存在」 */
export async function copyBlob(
  sourceKey: string,
  maxSize: number = MAX_FILE_SIZE,
): Promise<{ storageKey: string; size: number }> {
  const sourcePath = blobPath(sourceKey);
  let info;
  try {
    info = await stat(sourcePath);
  } catch {
    throw new AppError("文件不存在");
  }
  if (!info.isFile()) throw new AppError("文件不存在");
  if (info.size > maxSize) throw new AppError(`文件不能超过 ${MAX_FILE_SIZE_LABEL}`);

  const storageKey = newKey();
  await mkdir(path.join(uploadRoot(), storageKey.slice(0, 2)), { recursive: true });
  await copyFile(sourcePath, path.join(uploadRoot(), storageKey));
  return { storageKey, size: info.size };
}

/** 读回整份内容（仅用于小文件：正文抽取、测试比对） */
export async function readBlob(
  storageKey: string,
  maxBytes: number = MAX_FILE_SIZE,
): Promise<Buffer> {
  const sourcePath = blobPath(storageKey);
  let info;
  try {
    info = await stat(sourcePath);
  } catch {
    throw new AppError("文件不存在");
  }
  if (info.size > maxBytes) throw new AppError("文件太大，无法一次性读取");
  const handle = await open(sourcePath, "r");
  try {
    const buf = Buffer.alloc(info.size);
    await handle.read(buf, 0, info.size, 0);
    return buf;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** 取任意一行的内容：磁盘优先，其次库内 data（历史附件） */
export async function readStoredContent(
  row: { data?: Buffer | Uint8Array | null; storageKey?: string | null },
  maxBytes: number = MAX_FILE_SIZE,
): Promise<Buffer> {
  if (row.storageKey) return readBlob(row.storageKey, maxBytes);
  return Buffer.from(row.data ?? []);
}

export function blobReadStream(storageKey: string) {
  return createReadStream(blobPath(storageKey));
}

/** 删除磁盘 blob，尽力而为：文件已不在不算错 */
export async function deleteBlob(storageKey: string | null | undefined): Promise<void> {
  if (!storageKey || !isBlobKey(storageKey)) return;
  await unlink(path.join(uploadRoot(), storageKey)).catch(() => {});
}
