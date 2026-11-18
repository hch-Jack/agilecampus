import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  blobPath,
  copyBlob,
  deleteBlob,
  isBlobKey,
  persistBlob,
  readBlob,
  saveBlobFromStream,
} from "@/lib/blob-store";
import { AppError } from "@/lib/errors";

// 每个文件用独立临时目录，不往仓库的 data/ 里塞测试产物
let dir: string;
let prev: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ac-blob-"));
  prev = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = dir;
});

afterAll(async () => {
  if (prev === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = prev;
  await rm(dir, { recursive: true, force: true });
});

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
}

describe("blob-store：磁盘上的附件正文", () => {
  it("流式落盘，读回来字节一致", async () => {
    const saved = await saveBlobFromStream(streamOf("第一章", "：研究背景"));
    expect(saved.size).toBe(Buffer.byteLength("第一章：研究背景"));
    expect(isBlobKey(saved.storageKey)).toBe(true);
    expect((await readBlob(saved.storageKey)).toString("utf8")).toBe("第一章：研究背景");
    await deleteBlob(saved.storageKey);
    await expect(readBlob(saved.storageKey)).rejects.toThrow(AppError);
  });

  it("空流拒收，且不留下半成品", async () => {
    await expect(saveBlobFromStream(streamOf())).rejects.toThrow("不能上传空文件");
    const left = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".part"));
    expect(left).toEqual([]);
  });

  it("超限时中止并清理半成品", async () => {
    await expect(saveBlobFromStream(streamOf("1234", "5678"), 5)).rejects.toThrow(
      "文件不能超过 1GB",
    );
    const left = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".part"));
    expect(left).toEqual([]);
  });

  it("copyBlob 复制出新键，源与副本各自独立", async () => {
    const source = await saveBlobFromStream(streamOf("abc"));
    const copy = await copyBlob(source.storageKey);
    expect(copy.storageKey).not.toBe(source.storageKey);
    expect(copy.size).toBe(3);
    await deleteBlob(source.storageKey);
    expect((await readBlob(copy.storageKey)).toString()).toBe("abc");
    await deleteBlob(copy.storageKey);
  });

  it("persistBlob：内存字节按旧口径进 data；磁盘源复制成 storageKey", async () => {
    const inline = await persistBlob({ data: Buffer.from("hi") });
    expect(inline).toMatchObject({ size: 2, storageKey: null });

    const source = await saveBlobFromStream(streamOf("disk"));
    const fromDisk = await persistBlob({ storageKey: source.storageKey });
    expect(fromDisk.storageKey).not.toBe(source.storageKey);
    expect((await readBlob(fromDisk.storageKey!)).toString()).toBe("disk");
    await deleteBlob(source.storageKey);
    await deleteBlob(fromDisk.storageKey);
  });

  it("声明体积超限先拒；空内容拒；非法键当文件不存在", async () => {
    await expect(
      persistBlob({ data: Buffer.from("x"), size: 1024 * 1024 * 1024 + 1 }),
    ).rejects.toThrow("文件不能超过 1GB");
    await expect(persistBlob({ data: Buffer.alloc(0) })).rejects.toThrow("不能上传空文件");
    expect(() => blobPath("../../etc/passwd")).toThrow("文件不存在");
    await expect(copyBlob("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      "文件不存在",
    );
  });
});
