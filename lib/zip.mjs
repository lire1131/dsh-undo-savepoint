/**
 * dsh-undo-savepoint: zero-dependency ZIP reader/writer (V0.4.0, M1).
 *
 * 为什么不用 PowerShell Compress-Archive（Windows 专属）或 archiver/unzipper
 * （引入运行时依赖，DSH 插件启动有 risk）：
 * - ZIP 是标准格式；这里用 node:zlib 的 deflateRawSync/inflateRawSync 做 DEFLATE，
 *   产物是标准 ZIP（Windows「资源管理器」、PowerShell Expand-Archive、macOS 归档、
 *   Linux unzip 都能开），读取也能解任意标准 deflate ZIP（含 PowerShell 产出的）。
 * - 零 npm 依赖，保持"离线/无构建/局外核心可用"的既定约束。
 *
 * 边界：仅处理 ZIP64 以下的普通 ZIP；不支持加密/分卷/数据描述符（自产与 PS 产物
 * 均不开这些）。快照体积有 5M/50M 门禁，用不到 ZIP64。
 *
 * @module dsh-undo-savepoint/zip
 */
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

// CRC32（ZIP 用 poly 0xEDB88320 的标准表）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// DOS 时间字段（ZIP header 用，Windows/PS 兼容；精度到秒）
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/**
 * 写一个标准 ZIP（deflate 压缩）。
 * @param {string} zipPath 目标 .zip 路径
 * @param {Array<{name:string, data:Buffer}>} files 按序写入的文件
 */
export async function writeZip(zipPath, files) {
  const localChunks = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime();
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0);        // local file header sig
    lh.writeUInt16LE(20, 4);                // version needed
    lh.writeUInt16LE(0x0800, 6);            // flags: UTF-8 filename
    lh.writeUInt16LE(8, 8);                 // method: deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);                // extra len
    nameBuf.copy(lh, 30);
    localChunks.push(lh, comp);

    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0);        // central dir sig
    ch.writeUInt16LE(20, 4);                // version made by
    ch.writeUInt16LE(20, 6);                // version needed
    ch.writeUInt16LE(0x0800, 8);            // flags
    ch.writeUInt16LE(8, 10);                // method
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);                // extra len
    ch.writeUInt16LE(0, 32);                // comment len
    ch.writeUInt16LE(0, 34);                // disk number start
    ch.writeUInt16LE(0, 36);                // internal attrs
    ch.writeUInt32LE(0, 38);                // external attrs
    ch.writeUInt32LE(offset, 42);           // local header offset
    nameBuf.copy(ch, 46);
    central.push(ch);

    offset += lh.length + comp.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);                 // disk number
  eocd.writeUInt16LE(0, 6);                 // cd start disk
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);           // cd offset
  eocd.writeUInt16LE(0, 20);                // comment len

  await fs.mkdir(join(zipPath, '..'), { recursive: true });
  const tmp = `${zipPath}.tmp`;
  const fd = await fs.open(tmp, 'w');
  try {
    for (const c of localChunks) await fd.write(c);
    for (const c of central) await fd.write(c);
    await fd.write(eocd);
  } finally {
    await fd.close();
  }
  await fs.rename(tmp, zipPath).catch(() => { /* 并发写入已存在，忽略 */ });
}

/**
 * 单条解压大小上限（H2 加固）：解压前先校验声明大小，再用 maxOutputLength
 * 限制实际分配，防 zip 炸弹把宿主进程内存打爆。
 */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/**
 * 多条目累计解压上限（#25 后续加固）：单条 64MB 只约束单个条目，1GB 的
 * 压缩包理论上仍可塞进上万个高压缩比条目（deflate 极限约 1000:1），累计
 * 解出 TB 级数据写盘并驻留内存（readZip 的返回值全量持有解压结果）。
 * 上限取 4GB：合法导出以文本内容为主（约 3-5:1 压缩比）且 zip 文件本身
 * 已限 1GB，余量充足；炸弹场景被封死在 GB 量级。彻底方案是流式解压
 * 逐条落盘，作为后续改进记录。
 */
export const MAX_TOTAL_ENTRY_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * 读一个标准 ZIP（deflate/store），返回 [{name, data:Buffer}]。
 * 兼容 PowerShell Expand-Archive / archiver / unzip 产物。
 * @param {string} zipPath 目标 .zip 路径
 */
export async function readZip(zipPath) {
  const buf = await fs.readFile(zipPath);
  // 定位 EOCD（从末尾找 0x06054b50）
  let eocd = -1;
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('end-of-central-directory record not found (not a ZIP?)');
  const entries = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  let totalOut = 0;
  for (let n = 0; n < entries; n++) {
    const sig = buf.readUInt32LE(off);
    if (sig !== 0x02014b50) throw new Error('bad central directory signature at ' + off);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen).normalize('NFC').replace(/\\/g, '/');
    // H2：解压前先拒绝声明过大的条目；stored 条目同理（压缩比 1:1，直接超限）。
    if (usize > MAX_ENTRY_BYTES) throw new Error(`zip entry too large: ${name} (${usize} bytes > ${MAX_ENTRY_BYTES})`);
    if (csize > buf.length) throw new Error(`zip entry corrupt: ${name} (compressed size ${csize} > file size ${buf.length})`);
    // 累计解压上限（见 MAX_TOTAL_ENTRY_BYTES 注释）
    if (totalOut + usize > MAX_TOTAL_ENTRY_BYTES) throw new Error(`zip cumulative output too large: ${name} (total ${totalOut + usize} bytes > ${MAX_TOTAL_ENTRY_BYTES})`);
    // 从 local header 读数据（跳过 30 字节头 + name + extra）
    const lhSig = buf.readUInt32LE(localOffset);
    if (lhSig !== 0x04034b50) throw new Error('bad local header signature at ' + localOffset);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 8) data = inflateRawSync(comp, { maxOutputLength: MAX_ENTRY_BYTES });
    else if (method === 0) data = Buffer.from(comp);
    else throw new Error(`unsupported compression method ${method} for ${name}`);
    if (data.length !== usize) throw new Error(`size mismatch for ${name}`);
    totalOut += data.length; // 解压后如实累计（声明值已先校验过）
    out.push({ name, data });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
