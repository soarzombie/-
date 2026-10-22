// Moving records between phones without a server: one backup file holds every record with its sound,
// and another phone takes in the ones it does not have yet (same record id = same record).
//
// File layout: "NOISEBK1", the header's length in bytes (8 hex digits), the header (JSON: format, app
// version, phone name, export time, the records without their sound and video and where each sits),
// then the sounds and videos one after another. One record alone in such a file is how a record is
// sent to a PC (opened in the app there). Building it only joins Blobs, so the sound is never copied
// in memory.

const MAGIC = 'NOISEBK1';
const LEAD = MAGIC.length + 8;
const BLOBS = ['audio', 'video']; // a record's sound, and the video of a recording made with the camera on

export function backupBlob(records, { device = '', app = '' } = {}) {
  const parts = [];
  let offset = 0;
  const list = records.map((r) => {
    const out = { ...r };
    for (const key of BLOBS) {
      const b = r[key];
      delete out[key];
      if (!(b instanceof Blob) || !b.size) continue;
      parts.push(b);
      out[key] = { offset, size: b.size, type: b.type };
      offset += b.size;
    }
    return out;
  });
  const header = new TextEncoder().encode(JSON.stringify({ format: 1, app, device, exported: Date.now(), records: list }));
  return new Blob([MAGIC, header.length.toString(16).padStart(8, '0'), header, ...parts], { type: 'application/octet-stream' });
}

// The header with each record's sound as a Blob (a slice of the file). Throws a Korean message.
export async function readBackup(file) {
  const lead = await file.slice(0, LEAD).text();
  if (lead.slice(0, MAGIC.length) !== MAGIC) throw new Error('소음 분석 백업 파일이 아닙니다.');
  const len = parseInt(lead.slice(MAGIC.length), 16);
  if (!(len > 0) || LEAD + len > file.size) throw new Error('백업 파일이 잘렸거나 손상되었습니다.');
  let header;
  try {
    header = JSON.parse(await file.slice(LEAD, LEAD + len).text());
  } catch {
    throw new Error('백업 파일이 잘렸거나 손상되었습니다.');
  }
  if (header.format !== 1 || !Array.isArray(header.records)) throw new Error('이 앱에서 읽을 수 없는 백업 형식입니다.');
  const base = LEAD + len;
  const records = header.records
    .filter((r) => r && typeof r.id === 'string' && r.spectrum && Number.isFinite(r.ts))
    .map((r) => {
      const out = { ...r };
      for (const key of BLOBS) {
        const a = r[key];
        const whole = a && Number.isFinite(a.offset) && Number.isFinite(a.size) && base + a.offset + a.size <= file.size;
        out[key] = whole ? file.slice(base + a.offset, base + a.offset + a.size, a.type) : undefined; // cut off: keep the rest
      }
      return out;
    });
  return { ...header, records };
}

// Which backup records to add: the ones whose id this phone does not have. Each keeps the name of the
// phone it was measured on (the backup's, for records saved before phones had names).
export function importPlan(haveIds, backup, now = Date.now()) {
  const have = new Set(haveIds);
  const add = [];
  let skipped = 0;
  for (const r of backup.records) {
    if (have.has(r.id)) {
      skipped++;
      continue;
    }
    have.add(r.id);
    add.push({ ...r, device: r.device || backup.device || '', importedAt: now });
  }
  return { add, skipped };
}
