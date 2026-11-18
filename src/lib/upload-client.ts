/**
 * 浏览器端流式上传的小封装。
 *
 * `body: file` 让 fetch 直接以文件为请求体（浏览器知道长度，不会整份读进内存复制），
 * 配合 route handler 的 `request.body` → 磁盘写入，1GB 也不会把页签内存撑爆。
 * 文件名/类型走 query：响应头与 URL 都是 ASCII++ 百分号编码，中文名没问题。
 */
export type UploadResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function uploadFileRaw<T extends { id: string }>(
  endpoint: string,
  file: File,
  extraQuery?: Record<string, string>,
): Promise<UploadResult<T>> {
  const query = new URLSearchParams({
    name: file.name,
    type: file.type || "",
    ...extraQuery,
  });

  try {
    const res = await fetch(`${endpoint}?${query.toString()}`, {
      method: "POST",
      body: file,
    });
    const data = (await res.json().catch(() => null)) as
      | (T & { error?: string })
      | null;
    if (!res.ok) {
      return { ok: false, error: data?.error ?? "上传失败，请重试" };
    }
    if (!data) return { ok: false, error: "上传失败，请重试" };
    return { ok: true, data };
  } catch {
    return { ok: false, error: "网络异常，请重试" };
  }
}
