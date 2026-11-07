/**
 * 全站单文件大小上限：1GB。
 *
 * 任务附件、私信/群聊附件、助手对话文件共用这一条上限；只在客户端预检与服务端
 * 落库/接收时各校一次。真正的大文件走**流式**上传（route handler 读取 raw body
 * 直接写盘），不经 server action —— server action 的 body 上限只有 12MB。
 *
 * 例外：头像 2MB（会压缩成小图，见 lib/user.ts）、助手记忆导入 5MB（是 JSON
 * 快照而不是二进制文件），它们不是「文件存储」的上限，不跟着放大。
 */
export const MAX_FILE_SIZE = 1024 * 1024 * 1024;

/** 给用户看的短标签，别在错误文案里硬编码「10MB」 */
export const MAX_FILE_SIZE_LABEL = "1GB";
