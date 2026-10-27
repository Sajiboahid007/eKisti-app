import { buildXlsx, columnName, crc32 } from './xlsx';

/** stored ZIP পড়া — পরীক্ষার জন্য */
function readZip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const files = new Map<string, string>();
  let pos = 0;
  while (view.getUint32(pos, true) === 0x04034b50) {
    const crc = view.getUint32(pos + 14, true);
    const size = view.getUint32(pos + 18, true);
    const nameLen = view.getUint16(pos + 26, true);
    const name = dec.decode(bytes.subarray(pos + 30, pos + 30 + nameLen));
    const data = bytes.subarray(pos + 30 + nameLen, pos + 30 + nameLen + size);
    expect(crc32(data)).toBe(crc);
    files.set(name, dec.decode(data));
    pos += 30 + nameLen + size;
  }
  expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  return files;
}

describe('shared/xlsx', () => {
  it('column names', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(701)).toBe('ZZ');
  });

  it('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes a valid package with one worksheet per sheet', () => {
    const files = readZip(buildXlsx([
      { name: 'ফর্ম-১', rows: [['শাখা', 'সদস্য'], ['মিরপুর & <ঢাকা>', 42]], boldRows: [0], colWidths: [20, 10] },
      { name: 'ফর্ম-১', rows: [['=SUM(A1)', 1.5]] }
    ]));
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml',
      'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'
    ]);
    const wb = files.get('xl/workbook.xml')!;
    expect(wb).toContain('name="ফর্ম-১"');
    expect(wb).toContain('name="ফর্ম-১ 2"'); // duplicate names made unique

    const s1 = files.get('xl/worksheets/sheet1.xml')!;
    expect(s1).toContain('<c r="A1" t="inlineStr" s="1"><is><t xml:space="preserve">শাখা</t></is></c>');
    expect(s1).toContain('মিরপুর &amp; &lt;ঢাকা&gt;');
    expect(s1).toContain('<c r="B2" s="2"><v>42</v></c>');
    expect(s1).toContain('<col min="1" max="1" width="20" customWidth="1"/>');

    // text that looks like a formula stays text
    const s2 = files.get('xl/worksheets/sheet2.xml')!;
    expect(s2).toContain('t="inlineStr"');
    expect(s2).not.toContain('<f>');
  });
});
