import JSZip from "jszip";

/**
 * 删掉 PPTX 里「`[Content_Types].xml` 声明了、包里却没有」的部件声明。
 *
 * pptxgenjs 4.0.1 有个毛病：每张幻灯片都会多声明一份
 * `/ppt/slideMasters/slideMasterN.xml`，而实际只写出 slideMaster1。PowerPoint /
 * WPS 会忽略这些悬空声明，可前端预览器（pptx-preview）是按 Content_Types
 * 逐个读部件的 —— 读到不存在的部件会中止整份解析，最后显示 0 页「无法解析」。
 *
 * 生成端与预览端共用：新文件由生成端修正；历史文件在预览前再兜一层。
 * 没有悬空声明时原样返回，不做无谓的重打包。
 */
export async function stripDanglingPptxOverrides(
  data: ArrayBuffer | Uint8Array,
): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(data);
  const types = zip.file("[Content_Types].xml");
  if (!types) return toArrayBuffer(data);
  const xml = await types.async("string");
  const parts = new Set(
    Object.keys(zip.files)
      .filter((name) => !zip.files[name].dir)
      .map((name) => `/${name}`),
  );
  let changed = false;
  const patched = xml.replace(/<Override\s+PartName="([^"]+)"[^>]*\/>/g, (match, partName: string) => {
    if (parts.has(partName)) return match;
    changed = true;
    return "";
  });
  if (!changed) return toArrayBuffer(data);
  zip.file("[Content_Types].xml", patched);
  return zip.generateAsync({
    type: "arraybuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  // Buffer 是 Uint8Array 的子类，底层可能是一个更大的共享 buffer，按视图区间截取
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}
