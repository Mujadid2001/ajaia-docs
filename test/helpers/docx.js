'use strict';
// Minimal .docx builder for tests: a .docx is just a ZIP holding OOXML parts.
// Everything is written with the "stored" (uncompressed) method so this needs
// no external zip tooling and no binary fixture checked into the repo.

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// [u16] little-endian unsigned short
const u16 = (n) => Buffer.from([n & 0xff, (n >>> 8) & 0xff]);
// [u32] little-endian unsigned long
const u32 = (n) => Buffer.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);

    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), nameBuf, data,
    ]);
    locals.push(local);

    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      nameBuf,
    ]));

    offset += local.length;
  }

  const central = Buffer.concat(centrals);
  return Buffer.concat([
    ...locals,
    central,
    Buffer.concat([
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(central.length), u32(offset), u16(0),
    ]),
  ]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

// numId 1 -> a single-level bullet list, so <w:numPr> renders as a real list.
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:numFmt w:val="bullet"/>
      <w:lvlText w:val="&#8226;"/>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

// Build a document from simple block descriptors so tests stay readable:
//   ['h1', 'Title'] | ['p', 'plain'] | ['bold', 'x'] | ['ul', ['a','b']]
function docx(blocks) {
  const para = (text, { style, bold, list } = {}) => {
    const props = [style ? `<w:pStyle w:val="${style}"/>` : '', list ? `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>` : ''].join('');
    const run = `<w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
    return `<w:p><w:pPr>${props}</w:pPr>${run}</w:p>`;
  };
  const body = blocks.map(([kind, value]) => {
    if (kind === 'ul') return value.map((v) => para(v, { list: true })).join('');
    if (kind === 'h1') return para(value, { style: 'Heading1' });
    if (kind === 'bold') return para(value, { bold: true });
    return para(value);
  }).join('');

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`;

  return zip({
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': ROOT_RELS,
    'word/_rels/document.xml.rels': DOCUMENT_RELS,
    'word/numbering.xml': NUMBERING,
    'word/document.xml': document,
  });
}

module.exports = { docx, zip };